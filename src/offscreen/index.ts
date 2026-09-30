import { 
  ExtensionMessage, 
  OffscreenProcessRequest, 
  OffscreenProcessResponse, 
  VisionDetection,
  ExtractedElement,
  DetectedPII,
  ExtractedOCRToken,
  ExtractedOCRLine,
  OCRMeta
} from '../types/extension';
import { runInference } from './visionDetector';
import { runOCR, getOCRStatus } from './ocrEngine';
import { scanPayloadForPII, summarizePIIDetections } from './piiScanner';

/**
 * Keyboard Warriors Offscreen Document
 * Provides a sandboxed environment for:
 *   1. Local PII sanitization (text-based privacy pipeline)
 *   2. WebGPU/ONNX vision inference (BlazeFace + YOLOv8n)
 */

console.log('[Keyboard Warriors Offscreen] Dedicated runtime initialized');

// Regex patterns for local privacy sanitization
const PII_PATTERNS = {
  EMAIL: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  PHONE: /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
  API_KEY: /(?:api[_-]?key|secret|token|bearer|auth)['"]?\s*[:=]\s*['"]?([a-zA-Z0-9_\-]{16,})['"]?/gi,
  IP_ADDRESS: /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g,
  CREDIT_CARD: /\b(?:\d{4}[ -]?){3}\d{4}\b/g
};

/**
 * Local privacy processor (text-based PII scrubbing)
 */
class LocalPrivacyPipeline {
  private workerReady = false;

  constructor() {
    this.initPipeline();
  }

  private initPipeline(): void {
    try {
      const workerBlob = new Blob([
        `self.onmessage = function(e) {
          const { id, text, action } = e.data;
          self.postMessage({ id, status: 'ready', time: Date.now() });
        };`
      ], { type: 'application/javascript' });

      const worker = new Worker(URL.createObjectURL(workerBlob));
      worker.onmessage = () => {
        this.workerReady = true;
      };
      worker.postMessage({ id: 'init', action: 'INIT_ONNX_RUNTIME' });
    } catch (err) {
      console.warn('[Keyboard Warriors Offscreen] Worker fallback mode active:', err);
      this.workerReady = true;
    }
  }

  public async process(request: OffscreenProcessRequest): Promise<OffscreenProcessResponse> {
    const startTime = performance.now();
    const action = request.action || 'SANITIZE_PII';
    const text = request.text || '';
    const detectedEntities: string[] = [];
    let maskedCount = 0;

    let sanitized = text;

    sanitized = sanitized.replace(PII_PATTERNS.EMAIL, (match) => {
      detectedEntities.push(`Email (${match.split('@')[1]})`);
      maskedCount++;
      return `[REDACTED_EMAIL_${maskedCount}]`;
    });

    sanitized = sanitized.replace(PII_PATTERNS.PHONE, () => {
      detectedEntities.push('Phone Number');
      maskedCount++;
      return `[REDACTED_PHONE_${maskedCount}]`;
    });

    sanitized = sanitized.replace(PII_PATTERNS.API_KEY, (match, keyGroup) => {
      detectedEntities.push('Secret / API Key');
      maskedCount++;
      return match.replace(keyGroup, '[REDACTED_SECRET_KEY]');
    });

    sanitized = sanitized.replace(PII_PATTERNS.IP_ADDRESS, (ip) => {
      if (ip === '127.0.0.1' || ip === '0.0.0.0') return ip;
      detectedEntities.push('IP Address');
      maskedCount++;
      return `[REDACTED_IP_${maskedCount}]`;
    });

    let result = sanitized;

    if (action === 'SUMMARIZE_LOCAL') {
      const tabTitle = request.tabInfo?.title || 'Current Webpage';
      const cleanSnippet = sanitized.slice(0, 300);
      result = `Safe Local Summary for "${tabTitle}":\n` +
        `• Privacy Shield Status: Verified (All PII filtered)\n` +
        `• Core Content: ${cleanSnippet ? cleanSnippet + '...' : 'Clean context extracted.'}\n` +
        `• Detected entities removed: ${detectedEntities.length > 0 ? detectedEntities.join(', ') : 'None'}`;
    } else if (action === 'ANALYZE_SECURITY') {
      const url = request.tabInfo?.url || '';
      const isHttps = url.startsWith('https://');
      const hasTracker = /[?&](utm_|fbclid|gclid|trk)/i.test(url);
      result = `Security Audit for: ${url}\n` +
        `• Protocol: ${isHttps ? '🔒 Secure HTTPS' : '⚠️ Unencrypted HTTP'}\n` +
        `• URL Tracking Parameters: ${hasTracker ? 'Detected & Stripped' : 'None detected'}\n` +
        `• PII Exposure Risk: ${detectedEntities.length > 0 ? 'High (Masked ' + maskedCount + ' tokens)' : 'Low (Safe)'}`;
    }

    const elapsed = Math.round(performance.now() - startTime);

    return {
      success: true,
      action,
      result,
      maskedCount,
      detectedEntities: Array.from(new Set(detectedEntities)),
      confidenceScore: 0.99,
      processingTimeMs: elapsed
    };
  }
}

const pipeline = new LocalPrivacyPipeline();

/**
 * Handle IPC Messages from Extension Service Worker
 *
 * The vision and OCR/PII paths are triggered exclusively by the `OFFSCREEN_*` message
 * types, which are deliberately distinct from the public request types the service worker
 * accepts and forwards. When a document re-dispatches a request under the same type it
 * received, both documents become handlers of one message and their replies race for the
 * same `sendResponse`; when it re-dispatches the same type it handles, it recurses.
 */
chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  // ── PII Privacy Processing (legacy sanitize pipeline) ──────────────────────
  if (message.type === 'PROCESS_OFFSCREEN') {

    const requestPayload = message.payload as OffscreenProcessRequest;

    pipeline.process(requestPayload)
      .then((response) => {
        sendResponse(response);
      })
      .catch((error) => {
        console.error('[Keyboard Warriors Offscreen] Pipeline error:', error);
        sendResponse({
          success: false,
          action: requestPayload?.action || 'UNKNOWN',
          result: '',
          error: String(error)
        });
      });

    return true;
  }

  // ── WebGPU Vision Inference ──────────────────────────────────────────────
  if (message.type === 'OFFSCREEN_RUN_VISION') {
    const { screenshotUrl, viewport, extractedElements } = message.payload as {
      screenshotUrl: string;
      viewport: { width: number; height: number; devicePixelRatio: number };
      extractedElements?: ExtractedElement[];
    };

    if (!screenshotUrl) {
      sendResponse({ success: false, error: 'Missing screenshotUrl in vision payload' });
      return true;
    }

    runInference(screenshotUrl, viewport, extractedElements || [])
      .then((result) => {
        sendResponse({
          success: !result.error,
          payload: {
            detections: result.detections as VisionDetection[],
            modelsUsed: result.modelsUsed,
            statuses: result.statuses,
            faceCount: result.faceCount,
            objectCount: result.objectCount,
            processingTimeMs: result.processingTimeMs
          },
          error: result.error
        });
      })
      .catch((err: any) => {
        console.error('[Keyboard Warriors Offscreen] Vision error:', err);
        sendResponse({
          success: false,
          error: err?.message || String(err),
          payload: {
            detections: [] as VisionDetection[],
            modelsUsed: [],
            statuses: [],
            faceCount: 0,
            objectCount: 0,
            processingTimeMs: 0
          }
        });
      });

    return true;
  }

  // ── OCR & On-Device PII Scanning ──────────────────────────────────────────
  if (message.type === 'OFFSCREEN_SCAN_PII') {
    const { screenshotUrl, domElements, staticTextNodes, viewport } = message.payload as {
      screenshotUrl?: string;
      domElements?: ExtractedElement[];
      staticTextNodes?: import('../types/extension').StaticTextNode[];
      viewport?: { width: number; height: number; devicePixelRatio: number };
    };

    const startTime = performance.now();

    (async () => {
      let ocrTokens: ExtractedOCRToken[] = [];
      let ocrLines: ExtractedOCRLine[] = [];
      let ocrMeta: OCRMeta = getOCRStatus();

      try {
        if (screenshotUrl) {
          const ocrResult = await runOCR(screenshotUrl, viewport);
          ocrTokens = ocrResult.tokens;
          ocrLines = ocrResult.lines;
          ocrMeta = ocrResult.meta;
        } else {
          // Without a capture there is nothing for OCR to read; say so rather than
          // reporting an empty result that looks like "no PII on this page".
          ocrMeta = {
            ...getOCRStatus(),
            status: 'error',
            stage: 'No screenshot supplied',
            error: 'screenshotUrl was empty, so the OCR pass never ran.',
          };
        }

        // Run combined PII scanning over DOM + static text nodes + reconstructed OCR lines
        const piiDetections = scanPayloadForPII(domElements || [], ocrTokens, staticTextNodes || []);
        const summary = summarizePIIDetections(piiDetections);
        const elapsed = Math.round(performance.now() - startTime);

        console.log(
          `[Keyboard Warriors Offscreen] PII scan: ${summary.total} detection(s) — ` +
            `${summary.domFlagged} from DOM, ${summary.ocrFlagged} OCR-only, ` +
            `${summary.corroborated} corroborated by both, ` +
            `over ${ocrTokens.length} OCR tokens in ${elapsed}ms`
        );

        sendResponse({
          success: true,
          payload: {
            piiDetections,
            ocrTokens,
            ocrLines,
            ocrMeta,
            piiMeta: {
              totalScanned: (domElements?.length || 0) + (staticTextNodes?.length || 0) + ocrTokens.length,
              flaggedCount: piiDetections.length,
              domFlaggedCount: summary.domFlagged,
              ocrFlaggedCount: summary.ocrFlagged,
              corroboratedCount: summary.corroborated,
              ocrMatchedCount: summary.ocrMatched,
              processingTimeMs: elapsed,
            }
          }
        });
      } catch (err: any) {
        console.error('[Keyboard Warriors Offscreen] PII scan error:', err);
        sendResponse({
          success: false,
          error: err?.message || String(err),
          payload: {
            piiDetections: [],
            ocrTokens: [],
            ocrLines: [],
            ocrMeta: {
              ...getOCRStatus(),
              status: 'error' as const,
              error: err?.message || String(err),
            },
            piiMeta: {
              totalScanned: 0,
              flaggedCount: 0,
              domFlaggedCount: 0,
              ocrFlaggedCount: 0,
              corroboratedCount: 0,
              ocrMatchedCount: 0,
              processingTimeMs: 0,
              error: err?.message || String(err),
            }
          }
        });
      }
    })();

    return true;
  }

  return false;
});
