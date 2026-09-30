import { ExtensionMessage, TabContext, DetectionOverlayPayload, BoundingBox } from '../types/extension';
import { 
  extractInteractiveElements, 
  getViewportMetrics, 
  auditInteractiveElements,
  extractStaticPiiTextNodes,
  DomAuditReport
} from './domExtractor';

/**
 * Keyboard Warriors Content Script
 * Injects privacy overlay root container, listens to extension IPC,
 * and provides developer/admin inspection utilities.
 */

const OVERLAY_ROOT_ID = 'sih-privacy-overlay-root';
const DEBUG_OVERLAY_CONTAINER_ID = 'kw-debug-highlights-container';
const DETECTION_OVERLAY_ID = 'kw-detection-overlay-root';

function initOverlayRoot(): HTMLElement {
  let root = document.getElementById(OVERLAY_ROOT_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = OVERLAY_ROOT_ID;
    (document.body || document.documentElement).appendChild(root);

    // Render initial privacy status badge
    renderShieldBadge(root);
  }
  return root;
}

function renderShieldBadge(root: HTMLElement): void {
  const existingCard = root.querySelector('.sih-overlay-card');
  if (existingCard) return;

  const card = document.createElement('div');
  card.className = 'sih-overlay-card';
  card.setAttribute('role', 'status');
  card.innerHTML = `
    <span class="sih-badge-shield">🛡️</span>
    <span class="sih-overlay-text">Keyboard Warriors: Privacy Guard</span>
  `;

  // Clicking allows quick status feedback
  card.addEventListener('click', () => {
    showPrivacyToast('🔒 Active protection: Web content is sanitized locally before AI processing.');
  });

  root.appendChild(card);
}

function showPrivacyToast(message: string, duration = 3500): void {
  const root = initOverlayRoot();
  const toast = document.createElement('div');
  toast.className = 'sih-toast';
  toast.innerHTML = `
    <span style="font-size: 16px;">✨</span>
    <span>${message}</span>
  `;

  root.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.4s ease';
    setTimeout(() => toast.remove(), 400);
  }, duration);
}

// ── On-page detection overlay ───────────────────────────────────────────────

/**
 * Colour per detection kind. Faces get the loudest colour because "where was the face
 * detected" is the question the overlay exists to answer.
 */
const DETECTION_STYLE = {
  face:       { border: '#FF2D78', fill: 'rgba(255, 45, 120, 0.16)',  label: '#FF2D78' },
  person:     { border: '#FFB020', fill: 'rgba(255, 176, 32, 0.14)',  label: '#FFB020' },
  pii:        { border: '#E03131', fill: 'rgba(224, 49, 49, 0.16)',   label: '#E03131' },
  ocr:        { border: '#0CA5E9', fill: 'rgba(12, 165, 233, 0.08)',  label: '#0CA5E9' },
  default:    { border: '#7048E8', fill: 'rgba(112, 72, 232, 0.12)',  label: '#7048E8' }
} as const;

type DetectionStyle = (typeof DETECTION_STYLE)[keyof typeof DETECTION_STYLE];

/** Upper bound on drawn OCR boxes; a dense page can produce thousands of tokens. */
const MAX_OCR_BOXES = 300;

function clearDetectionOverlay(): void {
  document.getElementById(DETECTION_OVERLAY_ID)?.remove();
}

/**
 * Draw a single bounding box with an attached label.
 *
 * `position: fixed` is deliberate. Every box in this pipeline is expressed in CSS
 * viewport pixels (that is what `getBoundingClientRect()` returns and what the vision
 * letterbox inverse maps back to), so a fixed layer lines the boxes up with what the
 * screenshot actually captured. An absolute layer would additionally add the scroll
 * offset and drift away from the captured frame the moment the user scrolls.
 */
function drawBox(
  root: HTMLElement,
  bbox: BoundingBox,
  kind: keyof typeof DETECTION_STYLE,
  text: string,
  tooltip: string
): boolean {
  const style: DetectionStyle = DETECTION_STYLE[kind] ?? DETECTION_STYLE.default;

  const left = Math.max(0, Math.min(bbox.left, bbox.right));
  const top = Math.max(0, Math.min(bbox.top, bbox.bottom));
  const right = Math.max(left, Math.max(bbox.left, bbox.right));
  const bottom = Math.max(top, Math.max(bbox.top, bbox.bottom));
  const width = right - left;
  const height = bottom - top;

  // Sub-pixel and off-screen boxes carry no information worth drawing.
  if (!isFinite(left) || !isFinite(top) || width < 1 || height < 1) return false;

  const box = document.createElement('div');
  box.style.cssText = `
    position: absolute;
    left: ${left}px;
    top: ${top}px;
    width: ${width}px;
    height: ${height}px;
    box-sizing: border-box;
    border: 2px solid ${style.border};
    background: ${style.fill};
    border-radius: 2px;
    pointer-events: none;
  `;
  box.title = tooltip;

  const label = document.createElement('span');
  label.style.cssText = `
    position: absolute;
    left: -2px;
    top: ${top < 16 ? '-2px' : '-15px'};
    transform: ${top < 16 ? 'translateY(0)' : 'translateY(-100%)'};
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    background: ${style.label};
    color: #fff;
    font: 600 10px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    padding: 0 4px;
    border-radius: 2px;
    white-space: nowrap;
  `;
  label.textContent = text;
  box.appendChild(label);
  root.appendChild(box);
  return true;
}

/**
 * Render the vision / PII / OCR detections on top of the live page.
 *
 * Returns the number of boxes drawn per layer so the caller can tell the difference
 * between "nothing was found" and "nothing was drawn".
 */
function renderDetectionOverlay(payload: DetectionOverlayPayload): {
  faces: number;
  objects: number;
  pii: number;
  ocr: number;
} {
  clearDetectionOverlay();

  const {
    visionDetections = [],
    piiDetections = [],
    ocrTokens = [],
    viewport,
    layers
  } = payload;

  const showVision = layers?.vision !== false;
  const showPii = layers?.pii !== false;
  const showOcr = layers?.ocr !== false;

  const root = document.createElement('div');
  root.id = DETECTION_OVERLAY_ID;
  root.style.cssText = `
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 2147483647;
    contain: layout style;
  `;

  let faces = 0;
  let objects = 0;

  if (showVision) {
    for (const det of visionDetections) {
      const isFace = det.label === 'face';
      const percent = `${Math.round((det.confidence ?? 0) * 100)}%`;
      const drawn = drawBox(
        root,
        det.bbox,
        isFace ? 'face' : det.label === 'person' ? 'person' : 'default',
        isFace ? `FACE ${percent}` : `${det.label.toUpperCase()} ${percent}`,
        `${det.source} · ${det.label} · ${percent}\n` +
          `box: ${Math.round(det.bbox.left)},${Math.round(det.bbox.top)} ` +
          `${Math.round(det.bbox.width)}x${Math.round(det.bbox.height)}`
      );
      if (drawn) {
        if (isFace) faces++;
        else objects++;
      }
    }
  }

  let pii = 0;
  if (showPii) {
    for (const det of piiDetections) {
      // Corroborated detections are outlined differently so "both engines saw this"
      // is visible on the page, not just in the side panel.
      const corroborated = (det.sources?.length ?? 0) > 1;
      const style = corroborated ? DETECTION_STYLE.person : DETECTION_STYLE.pii;
      const box = document.createElement('div');
      const left = Math.max(0, det.bbox.left);
      const top = Math.max(0, det.bbox.top);
      const width = Math.max(1, det.bbox.width);
      const height = Math.max(1, det.bbox.height);
      box.style.cssText = `
        position: absolute;
        left: ${left}px;
        top: ${top}px;
        width: ${width}px;
        height: ${height}px;
        box-sizing: border-box;
        border: 2px ${corroborated ? 'solid' : 'dashed'} ${style.border};
        background: ${style.fill};
        border-radius: 2px;
        pointer-events: none;
      `;
      box.title = `${det.type} · ${det.sources?.join('+') ?? det.source}\n"${det.text}"`;

      const label = document.createElement('span');
      label.style.cssText = `
        position: absolute;
        left: -2px;
        top: ${top < 16 ? '-2px' : '-15px'};
        transform: ${top < 16 ? 'translateY(0)' : 'translateY(-100%)'};
        max-width: 260px;
        overflow: hidden;
        text-overflow: ellipsis;
        background: ${style.label};
        color: #fff;
        font: 600 10px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
        padding: 0 4px;
        border-radius: 2px;
        white-space: nowrap;
      `;
      // Mask the value itself; the overlay must not become a new source of leaked PII.
      label.textContent = `${det.type} · ${det.sources?.join('+') ?? det.source} · ${det.text.slice(0, 6)}…`;
      box.appendChild(label);
      root.appendChild(box);
      pii++;
    }
  }

  let ocr = 0;
  if (showOcr) {
    for (const token of ocrTokens.slice(0, MAX_OCR_BOXES)) {
      if (drawBox(root, token.bbox, 'ocr', token.text.slice(0, 22), token.text)) ocr++;
    }
    if (ocrTokens.length > MAX_OCR_BOXES) {
      const note = document.createElement('div');
      note.style.cssText = `
        position: absolute;
        left: 8px;
        bottom: 8px;
        background: ${DETECTION_STYLE.ocr.label};
        color: #fff;
        font: 600 10px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
        padding: 2px 6px;
        border-radius: 2px;
      `;
      note.textContent = `OCR: showing ${MAX_OCR_BOXES} of ${ocrTokens.length} tokens`;
      root.appendChild(note);
    }
  }

  // Legend, so the colours on screen are decodable.
  const legend = document.createElement('div');
  legend.style.cssText = `
    position: absolute;
    top: 8px;
    right: 8px;
    pointer-events: auto;
    background: rgba(15, 23, 42, 0.92);
    color: #E2E8F0;
    font: 600 11px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace;
    padding: 6px 9px;
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
    text-align: right;
  `;
  const swatch = (color: string, label: string) =>
    `<div><span style="color:${color}">■</span> ${label}</div>`;
  legend.innerHTML = [
    `<div style="opacity:.75;font-weight:500">detections @ ${Math.round(viewport?.width ?? 0)}x${Math.round(viewport?.height ?? 0)}</div>`,
    showVision ? swatch(DETECTION_STYLE.face.border, `face: ${faces}`) : '',
    showVision && objects ? swatch(DETECTION_STYLE.person.border, `objects: ${objects}`) : '',
    showPii ? swatch(DETECTION_STYLE.pii.border, `PII: ${pii}`) : '',
    showPii ? swatch(DETECTION_STYLE.person.border, '= DOM + OCR') : '',
    showOcr ? swatch(DETECTION_STYLE.ocr.label, `OCR tokens: ${ocr}`) : '',
    `<div style="opacity:.6;font-weight:500;margin-top:2px">Esc to dismiss</div>`
  ].join('');
  root.appendChild(legend);

  // Appended to <html>, not <body>: a `transform`/`filter`/`perspective` on <body> turns a
  // `position: fixed` descendant into one positioned against <body> instead of the
  // viewport, which silently shifts every box off the element it marks.
  (document.documentElement || document.body).appendChild(root);
  return { faces, objects, pii, ocr };
}

function extractPageContext(): TabContext {
  const title = document.title || 'Untitled Page';
  const url = window.location.href;
  const selectedText = window.getSelection()?.toString()?.trim() || '';
  
  const metaDesc = (
    document.querySelector('meta[name="description"]') ||
    document.querySelector('meta[property="og:description"]')
  )?.getAttribute('content') || '';

  const headings = Array.from(document.querySelectorAll('h1, h2'))
    .map(h => h.textContent?.trim() || '')
    .filter(text => text.length > 0)
    .slice(0, 5);

  // Extract a lightweight, readable snippet of the main content
  const mainEl = document.querySelector('main, article, #content, [role="main"]') || document.body;
  const simplifiedContent = (mainEl?.textContent || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800);

  return {
    title,
    url,
    selectedText,
    metaDescription: metaDesc,
    headings,
    simplifiedContent,
    timestamp: Date.now()
  };
}

// Initialize on DOM load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => initOverlayRoot());
} else {
  initOverlayRoot();
}

// Escape dismisses the overlay so it never blocks reading the page underneath.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.getElementById(DETECTION_OVERLAY_ID)) {
    clearDetectionOverlay();
  }
});

/**
 * Developer & Admin Inspection API (attached to window for browser DevTools console access)
 */
const KW_DEBUG = {
  /**
   * Run a full DOM extraction audit and display extracted vs skipped elements
   */
  audit(): DomAuditReport {
    const report = auditInteractiveElements();

    console.group('%c🛡️ [Keyboard Warriors] DOM Extraction Audit Report', 'color: #4285F4; font-weight: bold; font-size: 13px;');
    console.log(`%cViewport: ${report.viewport.width}x${report.viewport.height} (DPR: ${report.viewport.devicePixelRatio})`, 'color: #9B72CF;');
    console.log(`%cCandidates Scanned: ${report.totalCandidates} | Extracted (Visible): ${report.extractedCount} | Missed/Filtered: ${report.skippedCount}`, 'color: #10B981; font-weight: bold;');

    console.groupCollapsed(`%c✅ Extracted Elements (${report.extractedCount})`, 'color: #10B981; font-weight: bold;');
    console.table(
      report.extracted.map(el => ({
        id: el.id,
        tag: el.tagName,
        type: el.type || '-',
        role: el.role || '-',
        text: el.text || '(empty)',
        selector: el.selector,
        bbox: `[${el.bbox.x}, ${el.bbox.y}, ${el.bbox.width}x${el.bbox.height}]`
      }))
    );
    console.groupEnd();

    console.groupCollapsed(`%c⚠️ Missed / Filtered Elements (${report.skippedCount})`, 'color: #F59E0B; font-weight: bold;');
    console.table(
      report.skipped.map(el => ({
        tag: el.tagName,
        text: el.text || '(empty)',
        reason: el.reason,
        details: el.details,
        dimensions: `${el.rect.width}x${el.rect.height}`,
        position: `top:${el.rect.top}, left:${el.rect.left}`
      }))
    );
    console.groupCollapsed(`%c🔤 Static PII Text Nodes (${report.staticTextNodeCount ?? 0})`, 'color: #F87171; font-weight: bold;');
    console.table(
      (report.staticTextNodes || []).map(n => ({
        id: n.id,
        tag: n.tagName,
        text: n.text.length > 60 ? n.text.slice(0, 57) + '...' : n.text,
        patterns: n.matchedPatterns.join(', '),
        selector: n.selector,
        bbox: `[${n.bbox.x}, ${n.bbox.y}, ${n.bbox.width}x${n.bbox.height}]`
      }))
    );
    console.groupEnd();

    console.groupEnd();

    return report;
  },

  /**
   * Visually highlight extracted elements on the page with neon bounding boxes
   */
  highlight(durationMs = 10000): void {
    KW_DEBUG.clearHighlights();

    const report = auditInteractiveElements();
    const container = document.createElement('div');
    container.id = DEBUG_OVERLAY_CONTAINER_ID;
    container.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 2147483646;';

    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.scrollY || window.pageYOffset;

    report.extracted.forEach((el, idx) => {
      const box = document.createElement('div');
      box.style.cssText = `
        position: absolute;
        left: ${el.bbox.left + scrollX}px;
        top: ${el.bbox.top + scrollY}px;
        width: ${el.bbox.width}px;
        height: ${el.bbox.height}px;
        border: 2px solid #10B981;
        background: rgba(16, 185, 129, 0.12);
        box-sizing: border-box;
        border-radius: 4px;
        pointer-events: none;
      `;

      const label = document.createElement('span');
      label.style.cssText = `
        position: absolute;
        top: -16px;
        left: 0;
        background: #10B981;
        color: #000;
        font-size: 10px;
        font-family: monospace;
        font-weight: bold;
        padding: 0 4px;
        border-radius: 2px;
        white-space: nowrap;
      `;
      label.textContent = `#${idx + 1} <${el.tagName}>`;
      box.appendChild(label);
      container.appendChild(box);
    });

    document.body.appendChild(container);

    if (durationMs > 0) {
      setTimeout(() => KW_DEBUG.clearHighlights(), durationMs);
    }
  },

  /**
   * Remove any active debug highlight overlays
   */
  clearHighlights(): void {
    const existing = document.getElementById(DEBUG_OVERLAY_CONTAINER_ID);
    if (existing) existing.remove();
  },

  /**
   * Draw the last pipeline result on the live page and report what was drawn.
   * Useful for verifying that a face box really lands on the face.
   */
  renderOverlay(payload: DetectionOverlayPayload) {
    const counts = renderDetectionOverlay(payload);
    console.group('%c🖼️ [Keyboard Warriors] Detection Overlay', 'color: #FF2D78; font-weight: bold;');
    console.log('Drawn:', counts);
    console.groupEnd();
    return counts;
  },

  /**
   * Dismiss the on-page detection overlay
   */
  clearOverlay(): void {
    clearDetectionOverlay();
  },

  /**
   * Test the complete screen capture + DOM extraction pipeline from DevTools
   */
  async getScreenAndDom(): Promise<any> {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_SCREEN_AND_DOM' }, (res) => {
        console.group('%c📸 [Keyboard Warriors] Screen & DOM Result', 'color: #4285F4; font-weight: bold;');
        console.log('Result payload:', res);
        if (res?.success && res?.payload?.screenshotUrl) {
          console.log('%cScreenshot captured successfully! (Open URL below or view in Sources)', 'color: #10B981;');
        }
        console.groupEnd();
        resolve(res);
      });
    });
  }
};

// Expose on window for easy developer inspection in Chrome DevTools
(window as any).__KW_DEBUG__ = KW_DEBUG;

/**
 * Listen and respond to extension IPC messages
 */
chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  const messageType = message?.type;

  switch (messageType) {
    case 'PING': {
      sendResponse({
        type: 'PONG',
        payload: { ready: true, url: window.location.href },
        sender: 'content_script'
      });
      return false;
    }

    case 'GET_TAB_CONTEXT': {
      const context = extractPageContext();
      sendResponse({
        type: 'TAB_CONTEXT_RESPONSE',
        payload: context,
        sender: 'content_script'
      });
      return false;
    }

    case 'EXTRACT_DOM': {
      try {
        if (message.payload?.includeAudit) {
          const audit = auditInteractiveElements();
          sendResponse({
            success: true,
            payload: audit,
            sender: 'content_script'
          });
        } else {
          const elements = extractInteractiveElements();
          const viewport = getViewportMetrics();
          const staticTextNodes = extractStaticPiiTextNodes();
          sendResponse({
            success: true,
            payload: {
              elements,
              viewport,
              staticTextNodes
            },
            sender: 'content_script'
          });
        }
      } catch (error) {
        sendResponse({
          success: false,
          error: String(error),
          sender: 'content_script'
        });
      }
      return false;
    }

    case 'RENDER_DETECTION_OVERLAY': {
      try {
        const counts = renderDetectionOverlay(message.payload as DetectionOverlayPayload);
        sendResponse({ success: true, drawn: counts, sender: 'content_script' });
      } catch (error: any) {
        sendResponse({
          success: false,
          error: error?.message || String(error),
          sender: 'content_script'
        });
      }
      return false;
    }

    case 'CLEAR_DETECTION_OVERLAY': {
      clearDetectionOverlay();
      sendResponse({ success: true, sender: 'content_script' });
      return false;
    }

    case 'EXECUTE_ACTION': {
      const payload = message.payload;
      if (payload?.actionType === 'SHOW_PRIVACY_TOAST') {
        showPrivacyToast(payload.message || 'Keyboard Warriors action executed');
        sendResponse({ success: true, executed: 'SHOW_PRIVACY_TOAST' });
      } else if (payload?.actionType === 'INSPECT_PAGE_PRIVACY') {
        const inputs = document.querySelectorAll('input');
        const count = inputs.length;
        showPrivacyToast(`🔒 Privacy audit complete: ${count} input field(s) analyzed.`);
        sendResponse({ success: true, fieldCount: count });
      } else {
        showPrivacyToast(payload?.message || 'Action executed successfully.');
        sendResponse({ success: true });
      }
      return false;
    }

    default:
      return false;
  }
});
