import React, { useEffect, useMemo, useState } from 'react';
import { 
  X, 
  Camera, 
  Layers, 
  Sparkles, 
  Eye, 
  ShieldAlert, 
  AlertTriangle, 
  Cpu, 
  ChevronDown, 
  ChevronRight,
  FileText,
  Lock,
  Mail,
  Phone,
  CreditCard,
  User,
  MapPin,
  Key,
  CheckCircle2,
  Copy,
  Search,
  ScanText
} from 'lucide-react';
import { ScreenAndDomPayload, DetectedPII, ExtractedOCRToken } from '../../types/extension';

interface DevInspectorProps {
  isOpen: boolean;
  onClose: () => void;
}

export const DevInspector: React.FC<DevInspectorProps> = ({ isOpen, onClose }) => {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ScreenAndDomPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'summary' | 'dom' | 'vision' | 'pii' | 'ocr' | 'preview'>('summary');
  const [showOverlaysOnPreview, setShowOverlaysOnPreview] = useState(true);
  const [showPiiOnly, setShowPiiOnly] = useState(false);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [ocrFilter, setOcrFilter] = useState('');
  const [copied, setCopied] = useState(false);
  const [overlayLayers, setOverlayLayers] = useState({ vision: true, pii: true, ocr: false });
  const [overlayMessage, setOverlayMessage] = useState<string | null>(null);

  const ocrMeta = data?.ocrMeta;
  const ocrTokens = data?.ocrTokens ?? [];

  /**
   * PII attribution is computed from `sources`, never from the single owning `source`.
   *
   * A DOM hit and an OCR hit for the same on-screen value are merged into one detection
   * owned by DOM, so filtering on `source === 'OCR'` reported an empty OCR column even
   * though OCR had matched those values - which made the whole OCR pass look unused.
   */
  const piiDetections = data?.piiDetections ?? [];
  const sourcesOf = (p: DetectedPII): string[] => p.sources?.length ? p.sources : [p.source];
  const ocrPii = useMemo(
    () => piiDetections.filter((p) => sourcesOf(p).includes('OCR')),
    [piiDetections]
  );
  const ocrOnlyPii = useMemo(
    () => piiDetections.filter((p) => sourcesOf(p).includes('OCR') && !sourcesOf(p).includes('DOM')),
    [piiDetections]
  );
  const domPii = useMemo(
    () => piiDetections.filter((p) => sourcesOf(p).includes('DOM')),
    [piiDetections]
  );
  const corroboratedPii = useMemo(
    () => piiDetections.filter((p) => sourcesOf(p).length > 1),
    [piiDetections]
  );
  const faceDetections = useMemo(
    () => (data?.visionDetections ?? []).filter((d) => d.label === 'face'),
    [data?.visionDetections]
  );
  const filteredOcrTokens = useMemo(() => {
    const query = ocrFilter.trim().toLowerCase();
    if (!query) return ocrTokens;
    return ocrTokens.filter((t) => t.text.toLowerCase().includes(query));
  }, [ocrTokens, ocrFilter]);

  // Escape always closes the inspector, so it cannot leave the panel looking stuck.
  //
  // Declared above the `if (!isOpen) return null` bail-out on purpose: a hook placed
  // after an early return is only reached when the inspector is open, so opening it
  // renders more hooks than the previous (closed) render. React treats that mismatch as
  // a fatal error and unmounts the whole side panel — which presents as the entire UI
  // going black the moment the shield button is clicked.
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleCopyOcrText = async () => {
    const text = ocrMeta?.fullText ?? '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  const handleCaptureAndInspect = async () => {
    setLoading(true);
    setError(null);
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type: 'GET_SCREEN_AND_DOM' }, (response) => {
          setLoading(false);
          if (chrome.runtime.lastError) {
            setError(chrome.runtime.lastError.message || 'Error executing GET_SCREEN_AND_DOM');
            return;
          }
          if (!response?.success) {
            setError(response?.error || 'Failed to capture screen and extract DOM');
            return;
          }
          setData(response.payload);
        });
      } else {
        // Mock fallback for browser dev server
        setTimeout(() => {
          setLoading(false);
          setData({
            screenshotUrl: '',
            viewport: { width: 1280, height: 800, devicePixelRatio: 1 },
            elements: [
              {
                id: 'input-email',
                tagName: 'INPUT',
                type: 'email',
                text: '',
                selector: 'input#input-email',
                xpath: '//input[@id="input-email"]',
                bbox: { x: 50, y: 60, width: 280, height: 38, top: 60, left: 50, right: 330, bottom: 98 },
                attributes: { placeholder: 'test.user@example.com', value: 'john.doe@company.org' }
              },
              {
                id: 'input-pwd',
                tagName: 'INPUT',
                type: 'password',
                text: '',
                selector: 'input#input-pwd',
                xpath: '//input[@id="input-pwd"]',
                bbox: { x: 50, y: 110, width: 280, height: 38, top: 110, left: 50, right: 330, bottom: 148 },
                attributes: { placeholder: 'Enter password', type: 'password' }
              }
            ],
            visionDetections: [
              {
                label: 'face',
                confidence: 0.94,
                bbox: { x: 520, y: 80, width: 120, height: 120, top: 80, left: 520, right: 640, bottom: 200 },
                source: 'BlazeFace'
              }
            ],
            ocrTokens: [
              {
                text: 'user@domain.com',
                confidence: 96,
                bbox: { x: 55, y: 65, width: 130, height: 20, top: 65, left: 55, right: 185, bottom: 85 }
              }
            ],
            piiDetections: [
              {
                id: 'pii-dom-email-0',
                type: 'EMAIL',
                text: 'john.doe@company.org',
                bbox: { x: 50, y: 60, width: 280, height: 38, top: 60, left: 50, right: 330, bottom: 98 },
                source: 'DOM',
                sources: ['DOM', 'OCR'],
                selector: 'input#input-email',
                confidence: 0.99
              },
              {
                id: 'pii-dom-pwd-1',
                type: 'PASSWORD',
                text: '••••••••',
                bbox: { x: 50, y: 110, width: 280, height: 38, top: 110, left: 50, right: 330, bottom: 148 },
                source: 'DOM',
                sources: ['DOM'],
                selector: 'input#input-pwd',
                confidence: 0.99
              }
            ],
            piiMeta: {
              totalScanned: 3,
              flaggedCount: 2,
              domFlaggedCount: 2,
              ocrFlaggedCount: 0,
              ocrMatchedCount: 1,
              corroboratedCount: 1,
              processingTimeMs: 14
            },
            visionMeta: {
              modelsUsed: ['BlazeFace', 'YOLOv8n'],
              processingTimeMs: 38,
              statuses: [
                { model: 'BlazeFace', loaded: true },
                { model: 'YOLOv8n', loaded: true }
              ],
              faceCount: 1,
              objectCount: 0
            }
          });
        }, 500);
      }
    } catch (err: any) {
      setLoading(false);
      setError(err?.message || String(err));
    }
  };

  /**
   * Ask the content script to draw the last capture's boxes on the live page.
   *
   * This goes through the background as a `tabs.sendMessage` so it works on the real
   * inspected tab; injecting the payload via `executeScript` would rebuild it from
   * serialized arguments and silently fall back to a no-op if the content script
   * version does not match.
   */
  const handleOverlayOnPage = async (mode: 'render' | 'clear') => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      setOverlayMessage('Extension messaging is unavailable outside the extension build.');
      return;
    }
    if (mode === 'render' && !data) {
      setOverlayMessage('Run a capture first — there is nothing to draw yet.');
      return;
    }

    chrome.runtime.sendMessage(
      mode === 'render'
        ? {
            type: 'RENDER_DETECTION_OVERLAY',
            payload: {
              visionDetections: overlayLayers.vision ? data?.visionDetections : [],
              piiDetections: overlayLayers.pii ? data?.piiDetections : [],
              ocrTokens: overlayLayers.ocr ? data?.ocrTokens : [],
              viewport: data?.viewport ?? { width: 0, height: 0, devicePixelRatio: 1 },
              layers: overlayLayers
            }
          }
        : { type: 'CLEAR_DETECTION_OVERLAY' },
      (response: any) => {
        if (chrome.runtime.lastError) {
          setOverlayMessage(chrome.runtime.lastError.message || 'Failed to reach the content script.');
          return;
        }
        if (!response?.success) {
          setOverlayMessage(response?.error || 'The content script could not draw the overlay.');
          return;
        }
        setOverlayMessage(
          mode === 'clear'
            ? 'Overlay cleared.'
            : `Drew ${response.drawn.faces} face, ${response.drawn.objects} object, ` +
              `${response.drawn.pii} PII and ${response.drawn.ocr} OCR boxes on the page.`
        );
      }
    );
  };

  const handleHighlightOnPage = () => {
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        if (tab?.id) {
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              if ((window as any).__KW_DEBUG__?.highlight) {
                (window as any).__KW_DEBUG__.highlight(8000);
              } else {
                alert('Keyboard Warriors content script is not loaded on this tab. Please refresh the page.');
              }
            }
          });
        }
      });
    }
  };

  const renderPiiIcon = (type: DetectedPII['type']) => {
    switch (type) {
      case 'EMAIL': return <Mail className="w-3.5 h-3.5 text-cyan-400" />;
      case 'PHONE': return <Phone className="w-3.5 h-3.5 text-emerald-400" />;
      case 'CREDIT_CARD': return <CreditCard className="w-3.5 h-3.5 text-rose-400" />;
      case 'PASSWORD': return <Key className="w-3.5 h-3.5 text-red-400" />;
      case 'NAME': return <User className="w-3.5 h-3.5 text-amber-400" />;
      case 'ADDRESS': return <MapPin className="w-3.5 h-3.5 text-violet-400" />;
      default: return <Lock className="w-3.5 h-3.5 text-red-400" />;
    }
  };

  return (
    /*
     * Opaque and unblurred on purpose. This previously used `bg-gemini-bg/95` with
     * `backdrop-blur-xl`, and since `gemini-bg` is #131314 that painted the entire side
     * panel near-black: clicking the shield button looked like the extension had crashed
     * rather than opening a tool. A solid surface with a visible header reads as a panel.
     */
    <div className="fixed inset-0 z-50 flex flex-col bg-gemini-bg text-white">
      {/* Top Header — wraps and truncates so the close button is always reachable in a
          narrow side panel, where the previous single-row layout overflowed off-screen. */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 border-b border-gemini-border bg-gemini-surface">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <div className="p-1.5 rounded-lg bg-gemini-purple/20 text-gemini-purple border border-gemini-purple/30 shrink-0">
            <Cpu className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h2 className="text-xs font-bold uppercase tracking-wider text-gemini-blue truncate">
              Developer Inspector
            </h2>
            <p className="text-[11px] text-gemini-muted truncate">
              Vision · OCR · PII detection
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleCaptureAndInspect}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-gemini-blue hover:bg-gemini-blue/90 text-white shadow-sm transition-all disabled:opacity-50 whitespace-nowrap"
          >
            <Camera className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>{loading ? 'Analyzing...' : 'Run Pipeline'}</span>
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gemini-muted hover:text-white hover:bg-gemini-elevated transition-all shrink-0"
            aria-label="Close inspector"
            title="Close (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Navigation Sub-Tabs */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-gemini-border bg-gemini-bg text-xs overflow-x-auto">
        <button
          onClick={() => setActiveTab('summary')}
          className={`px-3 py-1 rounded-md transition-all whitespace-nowrap ${
            activeTab === 'summary' 
              ? 'bg-gemini-blue/20 text-gemini-blue font-semibold border border-gemini-blue/30' 
              : 'text-gemini-muted hover:text-white'
          }`}
        >
          Summary
        </button>
        <button
          onClick={() => setActiveTab('dom')}
          className={`flex items-center gap-1 px-3 py-1 rounded-md transition-all whitespace-nowrap ${
            activeTab === 'dom' 
              ? 'bg-gemini-blue/20 text-gemini-blue font-semibold border border-gemini-blue/30' 
              : 'text-gemini-muted hover:text-white'
          }`}
        >
          <Layers className="w-3 h-3" />
          <span>DOM ({data?.elements?.length ?? 0})</span>
        </button>
        <button
          onClick={() => setActiveTab('vision')}
          className={`flex items-center gap-1 px-3 py-1 rounded-md transition-all whitespace-nowrap ${
            activeTab === 'vision' 
              ? 'bg-gemini-blue/20 text-gemini-blue font-semibold border border-gemini-blue/30' 
              : 'text-gemini-muted hover:text-white'
          }`}
        >
          <Sparkles className="w-3 h-3" />
          <span>Vision ({data?.visionDetections?.length ?? 0})</span>
        </button>
        <button
          onClick={() => setActiveTab('pii')}
          className={`flex items-center gap-1 px-3 py-1 rounded-md transition-all whitespace-nowrap ${
            activeTab === 'pii' 
              ? 'bg-red-500/20 text-red-400 font-semibold border border-red-500/30' 
              : 'text-gemini-muted hover:text-white'
          }`}
        >
          <ShieldAlert className="w-3 h-3 text-red-400" />
          <span>PII ({data?.piiDetections?.length ?? 0})</span>
        </button>
        <button
          onClick={() => setActiveTab('ocr')}
          className={`flex items-center gap-1 px-3 py-1 rounded-md transition-all whitespace-nowrap ${
            activeTab === 'ocr'
              ? 'bg-emerald-500/20 text-emerald-400 font-semibold border border-emerald-500/30'
              : 'text-gemini-muted hover:text-white'
          }`}
        >
          <ScanText className="w-3 h-3" />
          <span>OCR Text ({ocrTokens.length})</span>
        </button>
        {data?.screenshotUrl && (
          <button
            onClick={() => setActiveTab('preview')}
            className={`flex items-center gap-1 px-3 py-1 rounded-md transition-all whitespace-nowrap ${
              activeTab === 'preview' 
                ? 'bg-gemini-blue/20 text-gemini-blue font-semibold border border-gemini-blue/30' 
                : 'text-gemini-muted hover:text-white'
            }`}
          >
            <Eye className="w-3 h-3" />
            <span>Screenshot</span>
          </button>
        )}
      </div>

      {/* Body Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {error && (
          <div className="flex items-start gap-2.5 p-3 rounded-lg bg-red-950/40 border border-red-500/30 text-red-300 text-xs">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold text-red-200">Execution Error</div>
              <div>{error}</div>
            </div>
          </div>
        )}

        {/*
          Per-stage failures. The capture still succeeded, so without these banners a dead
          vision model or a failed OCR pass is indistinguishable from "found nothing".
        */}
        {data && (data.visionMeta?.error || data.piiMeta?.error) && (
          <div className="space-y-1.5">
            {data.visionMeta?.error && (
              <div className="flex items-start gap-2.5 p-3 rounded-lg bg-amber-950/30 border border-amber-500/30 text-amber-200 text-xs">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold text-amber-100">Vision stage failed</div>
                  <div>{data.visionMeta.error}</div>
                  {!!data.visionMeta.statuses?.length && (
                    <div className="mt-1 font-mono text-[10px] text-amber-300/80">
                      {data.visionMeta.statuses
                        .map((s) => `${s.model}: ${s.error ? s.error : s.loaded ? 'ok' : 'not loaded'}`)
                        .join(' · ')}
                    </div>
                  )}
                </div>
              </div>
            )}
            {data.piiMeta?.error && (
              <div className="flex items-start gap-2.5 p-3 rounded-lg bg-amber-950/30 border border-amber-500/30 text-amber-200 text-xs">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold text-amber-100">OCR / PII stage failed</div>
                  <div>{data.piiMeta.error}</div>
                  {data.ocrMeta?.error && (
                    <div className="mt-1 font-mono text-[10px] text-amber-300/80">{data.ocrMeta.error}</div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {!data && !loading && !error && (
          <div className="flex flex-col items-center justify-center py-10 px-6 text-center space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-gemini-surface flex items-center justify-center text-gemini-blue border border-gemini-border">
              <Camera className="w-6 h-6" />
            </div>
            <div>
              <p className="text-sm font-medium text-white">No capture yet</p>
              <p className="text-xs max-w-xs mt-1.5 text-gemini-muted leading-relaxed">
                Press <strong className="text-gemini-blue">Run Pipeline</strong> to capture the
                active tab. It runs the DOM walk, face/object vision, and on-device OCR together,
                then reports which engine found each detection.
              </p>
            </div>
            <button
              onClick={handleCaptureAndInspect}
              className="mt-1 flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-gemini-blue hover:bg-gemini-blue/90 text-white transition-colors"
            >
              <Camera className="w-3.5 h-3.5" />
              <span>Run Pipeline</span>
            </button>
            <p className="text-[10px] text-gemini-muted/70">
              Face boxes can be drawn on the page itself under the Screenshot tab.
            </p>
          </div>
        )}

        {loading && (
          <div className="flex flex-col items-center justify-center py-16 text-center text-gemini-muted space-y-3">
            <div className="w-8 h-8 rounded-full border-2 border-gemini-blue border-t-transparent animate-spin" />
            <p className="text-xs">Running DOM extraction, vision, and Tesseract OCR & PII detection...</p>
            <p className="text-[10px] text-gemini-muted/70">First run also loads the ONNX and OCR models, so it takes a while.</p>
          </div>
        )}

        {data && (
          <>
            {/* TAB: SUMMARY */}
            {activeTab === 'summary' && (
              <div className="space-y-4">
                {/* Metric Cards Grid */}
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="p-3 rounded-xl bg-gemini-surface/60 border border-gemini-border">
                    <span className="text-gemini-muted block text-[11px]">Viewport Dimensions</span>
                    <span className="text-sm font-semibold text-white mt-1 block">
                      {data.viewport.width} × {data.viewport.height}
                    </span>
                    <span className="text-[10px] text-gemini-muted">DPR: {data.viewport.devicePixelRatio}x</span>
                  </div>

                  <div className="p-3 rounded-xl bg-red-950/20 border border-red-500/30">
                    <span className="text-red-300 block text-[11px] font-medium flex items-center gap-1">
                      <ShieldAlert className="w-3 h-3 text-red-400" />
                      Flagged PII Items
                    </span>
                    <span className="text-base font-bold text-red-400 mt-1 block">
                      {data.piiDetections?.length ?? 0} sensitive fields
                    </span>
                    <span className="text-[10px] text-red-300/70">
                      {domPii.length} DOM · {ocrOnlyPii.length} OCR-only · {corroboratedPii.length} both · {data.piiMeta?.processingTimeMs ?? 0} ms
                    </span>
                  </div>

                  <div className="p-3 rounded-xl bg-gemini-surface/60 border border-gemini-border">
                    <span className="text-gemini-muted block text-[11px]">Interactive DOM</span>
                    <span className="text-sm font-semibold text-gemini-blue mt-1 block">
                      {data.elements.length} elements
                    </span>
                    <span className="text-[10px] text-gemini-muted">Inputs, buttons, links, images</span>
                  </div>

                  <div
                    className={`p-3 rounded-xl border ${
                      data.visionMeta?.error
                        ? 'bg-red-950/20 border-red-500/30'
                        : 'bg-gemini-surface/60 border-gemini-border'
                    }`}
                  >
                    <span className="text-gemini-muted block text-[11px]">WebGPU Vision</span>
                    <span className="text-sm font-semibold text-gemini-purple mt-1 block">
                      {faceDetections.length} faces · {Math.max(0, (data.visionDetections?.length ?? 0) - faceDetections.length)} objects
                    </span>
                    <span className="text-[10px] text-gemini-muted">
                      {data.visionMeta?.modelsUsed?.join(' + ') || 'BlazeFace + YOLOv8'} ({data.visionMeta?.processingTimeMs ?? 0}ms)
                    </span>
                  </div>

                  <div
                    className={`col-span-2 p-3 rounded-xl border ${
                      ocrMeta?.status === 'error'
                        ? 'bg-red-950/20 border-red-500/30'
                        : 'bg-gemini-surface/60 border-gemini-border'
                    }`}
                  >
                    <span className="text-gemini-muted block text-[11px] flex items-center gap-1">
                      <FileText className="w-3 h-3 text-gemini-blue" />
                      OCR Text Extracted
                    </span>
                    <span className="text-sm font-semibold text-white mt-1 block">
                      {ocrTokens.length} tokens
                      {data.ocrMeta ? ` · ${data.ocrMeta.lineCount} lines` : ''}
                    </span>
                    <span
                      className={`text-[10px] block ${
                        ocrMeta?.status === 'error' ? 'text-red-300' : 'text-gemini-muted'
                      }`}
                    >
                      {ocrMeta?.status === 'error'
                        ? ocrMeta.error
                        : ocrMeta?.stage || 'Not run yet'}
                    </span>
                    <button
                      onClick={() => setActiveTab('ocr')}
                      className="mt-2 text-[11px] text-emerald-400 hover:underline font-medium"
                    >
                      Inspect extracted text →
                    </button>
                  </div>
                </div>

                {/* Quick Action: Highlight on Page */}
                <div className="p-3 rounded-xl bg-gradient-to-r from-gemini-blue/10 via-gemini-purple/10 to-transparent border border-gemini-blue/20 flex items-center justify-between">
                  <div>
                    <div className="text-xs font-semibold text-white">Visual Highlight on Page</div>
                    <div className="text-[11px] text-gemini-muted">Draw neon bounding boxes directly on the target webpage</div>
                  </div>
                  <button
                    onClick={handleHighlightOnPage}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white shadow transition-all"
                  >
                    Highlight Page
                  </button>
                </div>
              </div>
            )}

            {/* TAB: DOM ELEMENTS */}
            {activeTab === 'dom' && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-gemini-muted pb-1">
                  <span>Showing {data.elements.length} interactive elements</span>
                  <button
                    onClick={handleHighlightOnPage}
                    className="text-emerald-400 hover:underline text-[11px]"
                  >
                    Highlight all on page
                  </button>
                </div>

                <div className="space-y-1.5">
                  {data.elements.map((el, i) => {
                    const isExpanded = expandedRow === `dom-${i}`;
                    return (
                      <div
                        key={i}
                        className="rounded-lg bg-gemini-surface/50 border border-gemini-border p-2 text-xs transition-all"
                      >
                        <div
                          className="flex items-center justify-between cursor-pointer"
                          onClick={() => setExpandedRow(isExpanded ? null : `dom-${i}`)}
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-gemini-blue/20 text-gemini-blue font-bold">
                              &lt;{el.tagName}&gt;
                            </span>
                            <span className="text-white font-medium truncate max-w-[160px]">
                              {el.text || el.id || el.selector}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 text-gemini-muted text-[11px]">
                            <span>
                              {el.bbox.width}×{el.bbox.height}
                            </span>
                            {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                          </div>
                        </div>

                        {isExpanded && (
                          <div className="mt-2 pt-2 border-t border-gemini-border/50 text-[11px] space-y-1 text-gemini-muted font-mono">
                            <div><strong className="text-white">Selector:</strong> {el.selector}</div>
                            <div><strong className="text-white">XPath:</strong> {el.xpath}</div>
                            <div><strong className="text-white">Bounding Box:</strong> x:{el.bbox.x}, y:{el.bbox.y}, w:{el.bbox.width}, h:{el.bbox.height}</div>
                            {el.role && <div><strong className="text-white">Role:</strong> {el.role}</div>}
                            {el.type && <div><strong className="text-white">Type:</strong> {el.type}</div>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* TAB: VISION DETECTIONS */}
            {activeTab === 'vision' && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-gemini-muted pb-1">
                  <span>
                    {faceDetections.length} face{faceDetections.length === 1 ? '' : 's'} ·{' '}
                    {Math.max(0, (data.visionDetections?.length ?? 0) - faceDetections.length)} other objects
                  </span>
                  <span className="text-[11px] text-gemini-purple font-semibold">
                    {data.visionMeta?.processingTimeMs ?? 0} ms
                  </span>
                </div>

                {/* Per-model status, so "no faces" is distinguishable from "BlazeFace never ran". */}
                {!!data.visionMeta?.statuses?.length && (
                  <div className="flex flex-wrap gap-1.5 pb-1">
                    {data.visionMeta.statuses.map((s) => (
                      <span
                        key={s.model}
                        className={`px-1.5 py-0.5 rounded text-[9px] font-mono border ${
                          s.error
                            ? 'bg-red-500/20 text-red-300 border-red-500/40'
                            : s.loaded
                            ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                            : 'bg-gemini-surface text-gemini-muted border-gemini-border'
                        }`}
                        title={s.error || s.executionProvider || undefined}
                      >
                        {s.model}
                        {s.error ? ` ✕ ${s.error.slice(0, 40)}` : s.loaded ? ' ✓' : ' · idle'}
                      </span>
                    ))}
                  </div>
                )}

                {(!data.visionDetections || data.visionDetections.length === 0) ? (
                  <div className="p-4 rounded-xl bg-gemini-surface/30 border border-gemini-border text-center text-xs text-gemini-muted">
                    {data.visionMeta?.error
                      ? `Vision stage failed: ${data.visionMeta.error}`
                      : 'No visual bounding boxes detected for this screen.'}
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {data.visionDetections.map((d, i) => (
                      <div
                        key={i}
                        className="rounded-lg bg-gemini-surface/50 border border-gemini-border p-2 text-xs flex items-center justify-between"
                      >
                        <div className="flex items-center gap-2">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            d.label === 'face' 
                              ? 'bg-pink-500/20 text-pink-400 border border-pink-500/30' 
                              : d.label === 'person'
                              ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                              : 'bg-gemini-blue/20 text-gemini-blue border border-gemini-blue/30'
                          }`}>
                            {d.label.toUpperCase()}
                          </span>
                          <span className="text-gemini-muted text-[11px]">via {d.source}</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="font-mono text-emerald-400 font-semibold text-[11px]">
                            {Math.round(d.confidence * 100)}% conf
                          </span>
                          <span className="font-mono text-gemini-muted text-[10px]">
                            [{d.bbox.x}, {d.bbox.y}, {d.bbox.width}×{d.bbox.height}]
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* TAB: PII & OCR */}
            {activeTab === 'pii' && (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-xs text-gemini-muted pb-1">
                  <span>Detected {data.piiDetections?.length ?? 0} sensitive PII items</span>
                  <span className="text-[11px] text-red-400 font-semibold">
                    {data.piiMeta?.processingTimeMs ?? 0} ms scanning latency
                  </span>
                </div>

                {(!data.piiDetections || data.piiDetections.length === 0) ? (
                  <div className="p-4 rounded-xl bg-gemini-surface/30 border border-gemini-border text-center text-xs text-gemini-muted">
                    No unencrypted PII patterns detected on this page.
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {data.piiDetections.map((pii, i) => (
                      <div
                        key={i}
                        className="rounded-lg bg-red-950/20 border border-red-500/30 p-2.5 text-xs transition-all space-y-1.5"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            {renderPiiIcon(pii.type)}
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-500/20 text-red-300 border border-red-500/40">
                              {pii.type}
                            </span>
                            <span className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-gemini-surface text-gemini-muted border border-gemini-border">
                              {sourcesOf(pii).join(' + ')}
                            </span>
                            {sourcesOf(pii).length > 1 && (
                              <span
                                className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                                title="Both the DOM text walk and the OCR pass flagged this value independently"
                              >
                                corroborated
                              </span>
                            )}
                          </div>
                          <span className="font-mono text-[10px] text-gemini-muted">
                            [{pii.bbox.x}, {pii.bbox.y}, {pii.bbox.width}×{pii.bbox.height}]
                          </span>
                        </div>

                        <div className="font-mono text-[11px] text-white bg-black/40 px-2 py-1 rounded border border-red-500/20 truncate">
                          {pii.text}
                        </div>

                        {pii.selector && (
                          <div className="text-[10px] text-gemini-muted font-mono truncate">
                            Selector: {pii.selector}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* OCR Summary Strip */}
                <div className="pt-3 mt-1 border-t border-gemini-border flex items-center justify-between">
                  <div className="text-xs text-gemini-muted">
                    <span className="text-gemini-blue font-semibold">{ocrTokens.length}</span> OCR tokens ·{' '}
                    <span className="text-red-400 font-semibold">{ocrPii.length}</span> matched by OCR
                    {corroboratedPii.length > 0 && (
                      <>
                        {' '}· <span className="text-emerald-400 font-semibold">{corroboratedPii.length}</span> both engines
                      </>
                    )}

                  </div>
                  <button
                    onClick={() => setActiveTab('ocr')}
                    className="text-emerald-400 hover:underline text-[11px] font-medium"
                  >
                    View extracted text →
                  </button>
                </div>
              </div>
            )}

            {/* TAB: OCR TEXT — the raw on-device recognition output */}
            {activeTab === 'ocr' && (
              <div className="space-y-3">
                {/* Engine status banner */}
                {ocrMeta && (
                  <div
                    className={`flex items-start gap-2.5 p-3 rounded-lg border text-xs ${
                      ocrMeta.status === 'error'
                        ? 'bg-red-950/40 border-red-500/30 text-red-300'
                        : ocrMeta.status === 'done'
                        ? 'bg-emerald-950/30 border-emerald-500/30 text-emerald-300'
                        : 'bg-gemini-surface/60 border-gemini-border text-gemini-muted'
                    }`}
                  >
                    {ocrMeta.status === 'error' ? (
                      <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                    ) : ocrMeta.status === 'done' ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                    ) : (
                      <ScanText className="w-4 h-4 text-gemini-blue shrink-0 mt-0.5" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold">{ocrMeta.stage}</div>
                      <div className="text-[11px] opacity-80 mt-0.5">
                        {ocrMeta.engine} · {ocrMeta.tokenCount} words · {ocrMeta.lineCount} lines ·{' '}
                        {ocrMeta.meanConfidence}% mean confidence · {ocrMeta.durationMs}ms · {ocrMeta.scale}x
                      </div>
                      {ocrMeta.error && (
                        <div className="text-[11px] text-red-300 mt-1.5 font-mono break-words">
                          {ocrMeta.error}
                        </div>
                      )}
                      {ocrMeta.assets.worker && (
                        <div className="text-[10px] opacity-60 mt-1.5 font-mono break-all">
                          worker: {ocrMeta.assets.worker}
                          <br />
                          lang: {ocrMeta.assets.lang}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Full recognized text */}
                <div className="rounded-xl bg-gemini-surface/40 border border-gemini-border overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-2 border-b border-gemini-border bg-gemini-surface/60">
                    <span className="text-xs font-semibold text-emerald-400 flex items-center gap-1.5">
                      <FileText className="w-3.5 h-3.5" />
                      Extracted Text
                    </span>
                    <button
                      onClick={handleCopyOcrText}
                      disabled={!ocrMeta?.fullText}
                      className="flex items-center gap-1 text-[10px] px-2 py-1 rounded bg-gemini-surface border border-gemini-border text-gemini-muted hover:text-white transition-all disabled:opacity-40"
                    >
                      {copied ? <CheckCircle2 className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <pre className="max-h-72 overflow-y-auto p-3 text-[11px] font-mono text-white whitespace-pre-wrap break-words leading-relaxed">
                    {ocrMeta?.fullText || (
                      <span className="text-gemini-muted">
                        {ocrMeta?.status === 'error'
                          ? 'OCR produced no text. See the error above.'
                          : 'No text recognized. Run the pipeline to populate this view.'}
                      </span>
                    )}
                  </pre>
                </div>

                {/* PII the OCR pass matched — the column that used to read as empty */}
                <div className="rounded-xl bg-red-950/20 border border-red-500/30 overflow-hidden">
                  <div className="px-3 py-2 border-b border-red-500/20 text-xs font-semibold text-red-400 flex items-center gap-1.5">
                    <ShieldAlert className="w-3.5 h-3.5" />
                    PII Matched By OCR ({ocrPii.length})
                    <span className="ml-auto font-mono text-[9px] font-normal text-red-300/70">
                      {ocrOnlyPii.length} OCR-only · {corroboratedPii.length} with DOM
                    </span>
                  </div>
                  {ocrPii.length === 0 ? (
                    <div className="p-3 text-[11px] text-gemini-muted">
                      OCR read {ocrTokens.length} tokens and matched no PII pattern. DOM-only hits: {domPii.length}.
                    </div>
                  ) : (
                    <div className="divide-y divide-red-500/10">
                      {ocrPii.map((pii) => (
                        <div key={pii.id} className="px-3 py-2 space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-1.5 min-w-0">
                              {renderPiiIcon(pii.type)}
                              <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-red-500/20 text-red-300 border border-red-500/40">
                                {pii.type}
                              </span>
                              <span className="font-mono text-[11px] text-white truncate">{pii.text}</span>
                            </div>
                            <span className="font-mono text-[10px] text-gemini-muted shrink-0">
                              {Math.round((pii.confidence ?? 0) * 100)}%
                            </span>
                          </div>
                          {pii.context && (
                            <div className="text-[10px] text-gemini-muted font-mono truncate">
                              ctx: {pii.context}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Token list with filter */}
                <div className="rounded-xl bg-gemini-surface/40 border border-gemini-border overflow-hidden">
                  <div className="px-3 py-2 border-b border-gemini-border flex items-center gap-2">
                    <Search className="w-3.5 h-3.5 text-gemini-muted shrink-0" />
                    <input
                      type="text"
                      value={ocrFilter}
                      onChange={(e) => setOcrFilter(e.target.value)}
                      placeholder="Filter words…"
                      className="flex-1 bg-transparent text-xs text-white placeholder:text-gemini-muted focus:outline-none"
                    />
                    <span className="text-[10px] text-gemini-muted shrink-0">
                      {filteredOcrTokens.length}/{ocrTokens.length}
                    </span>
                  </div>
                  {filteredOcrTokens.length === 0 ? (
                    <div className="p-3 text-[11px] text-gemini-muted">
                      {ocrTokens.length === 0
                        ? 'No OCR tokens were produced for this capture.'
                        : 'No tokens match the current filter.'}
                    </div>
                  ) : (
                    <div className="max-h-64 overflow-y-auto divide-y divide-gemini-border/40">
                      {filteredOcrTokens.map((tok: ExtractedOCRToken, i) => (
                        <div
                          key={i}
                          className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] font-mono"
                        >
                          <span className="text-white truncate">{tok.text}</span>
                          <span className="flex items-center gap-2 shrink-0">
                            <span
                              className={`px-1 py-0.5 rounded text-[9px] ${
                                tok.confidence >= 80
                                  ? 'bg-emerald-500/20 text-emerald-400'
                                  : tok.confidence >= 50
                                  ? 'bg-amber-500/20 text-amber-400'
                                  : 'bg-red-500/20 text-red-400'
                              }`}
                            >
                              {tok.confidence}%
                            </span>
                            <span className="text-gemini-muted/70 text-[10px]">
                              {tok.bbox.x},{tok.bbox.y} {tok.bbox.width}×{tok.bbox.height}
                            </span>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TAB: PREVIEW */}
            {activeTab === 'preview' && data.screenshotUrl && (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gemini-muted">Viewport Screenshot ({data.viewport.width}×{data.viewport.height})</span>
                  <div className="flex items-center gap-3 text-[11px]">
                      <label className="flex items-center gap-1.5 text-gemini-muted cursor-pointer">
                        <input
                          type="checkbox"
                          checked={showOverlaysOnPreview}
                          onChange={(e) => setShowOverlaysOnPreview(e.target.checked)}
                          className="rounded border-gemini-border bg-gemini-surface text-gemini-blue"
                        />
                        <span>All Overlays</span>
                      </label>
                      <span className="text-[10px] text-gemini-muted flex items-center gap-2">
                        <span className="flex items-center gap-1">
                          <span className="w-2 h-2 rounded-sm border border-cyan-400/70 bg-cyan-400/30" />
                          OCR
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="w-2 h-2 rounded-sm border border-emerald-500" />
                          DOM
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="w-2 h-2 rounded-sm border-2 border-red-500" />
                          PII
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="w-2 h-2 rounded-sm border-2 border-dashed border-orange-500" />
                          PII (OCR only)
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="w-2 h-2 rounded-sm border-2 border-pink-500" />
                          Face
                        </span>
                      </span>
                    <label className="flex items-center gap-1.5 text-red-400 cursor-pointer font-medium">
                      <input
                        type="checkbox"
                        checked={showPiiOnly}
                        onChange={(e) => setShowPiiOnly(e.target.checked)}
                        className="rounded border-gemini-border bg-gemini-surface text-red-500"
                      />
                      <span>PII Only</span>
                    </label>
                  </div>
                </div>

                <div className="rounded-xl bg-gemini-surface/40 border border-gemini-border p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-gemini-muted font-medium">
                      Draw these boxes on the live page
                    </span>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => handleOverlayOnPage('render')}
                        disabled={!data}
                        className="px-2 py-1 rounded text-[10px] font-semibold bg-gemini-blue/20 text-gemini-blue border border-gemini-blue/30 hover:bg-gemini-blue/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        Show on page
                      </button>
                      <button
                        onClick={() => handleOverlayOnPage('clear')}
                        className="px-2 py-1 rounded text-[10px] font-semibold bg-gemini-surface text-gemini-muted border border-gemini-border hover:text-white transition-colors"
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-[10px] text-gemini-muted">
                    {(['vision', 'pii', 'ocr'] as const).map((layer) => (
                      <label key={layer} className="flex items-center gap-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={overlayLayers[layer]}
                          onChange={(e) => setOverlayLayers((prev) => ({ ...prev, [layer]: e.target.checked }))}
                          className="rounded border-gemini-border bg-gemini-surface text-gemini-blue"
                        />
                        <span>{layer === 'vision' ? 'Faces & objects' : layer === 'pii' ? 'PII' : 'OCR tokens'}</span>
                      </label>
                    ))}
                  </div>
                  {overlayMessage && (
                    <div className="text-[10px] text-gemini-blue/90 font-mono">{overlayMessage}</div>
                  )}
                </div>

                <div className="relative border border-gemini-border rounded-xl overflow-hidden bg-black/50">
                  <img
                    src={data.screenshotUrl}
                    alt="Captured Viewport"
                    className="w-full h-auto block"
                  />
                  {showOverlaysOnPreview && (
                    <div className="absolute inset-0 pointer-events-none">
                      {/* Render DOM boxes in emerald */}
                      {!showPiiOnly && data.elements.map((el, i) => (
                        <div
                          key={`dom-box-${i}`}
                          style={{
                            position: 'absolute',
                            left: `${(el.bbox.x / data.viewport.width) * 100}%`,
                            top: `${(el.bbox.y / data.viewport.height) * 100}%`,
                            width: `${(el.bbox.width / data.viewport.width) * 100}%`,
                            height: `${(el.bbox.height / data.viewport.height) * 100}%`,
                            border: '1px solid #10B981',
                            background: 'rgba(16, 185, 129, 0.12)'
                          }}
                        />
                      ))}

                      {/* Render Vision boxes, labelled so a box is identifiable without the side panel */}
                      {!showPiiOnly && data.visionDetections?.map((d, i) => {
                        const face = d.label === 'face';
                        const stroke = face ? '#EC4899' : d.label === 'person' ? '#F59E0B' : '#3B82F6';
                        return (
                          <div
                            key={`vision-box-${i}`}
                            title={`${d.source} · ${d.label} · ${Math.round(d.confidence * 100)}%`}
                            style={{
                              position: 'absolute',
                              left: `${(d.bbox.x / data.viewport.width) * 100}%`,
                              top: `${(d.bbox.y / data.viewport.height) * 100}%`,
                              width: `${(d.bbox.width / data.viewport.width) * 100}%`,
                              height: `${(d.bbox.height / data.viewport.height) * 100}%`,
                              border: `2px solid ${stroke}`,
                              background: face ? 'rgba(236, 72, 153, 0.18)' : d.label === 'person' ? 'rgba(245, 158, 11, 0.18)' : 'rgba(59, 130, 246, 0.18)'
                            }}
                          >
                            <span
                              className="absolute -top-4 left-0 text-white font-mono font-bold text-[9px] px-1 rounded whitespace-nowrap"
                              style={{ background: stroke }}
                            >
                              {face ? 'FACE' : d.label.toUpperCase()} {Math.round(d.confidence * 100)}%
                            </span>
                          </div>
                        );
                      })}

                      {/* Render PII boxes in pulsating red */}
                      {data.piiDetections?.map((pii, i) => {
                        const sources = sourcesOf(pii);
                        const ocrOnly = sources.includes('OCR') && !sources.includes('DOM');
                        const both = sources.length > 1;
                        return (
                          <div
                            key={`pii-box-${i}`}
                            title={`${pii.type} · ${sources.join(' + ')}\n${pii.text}`}
                            style={{
                              position: 'absolute',
                              left: `${(pii.bbox.x / data.viewport.width) * 100}%`,
                              top: `${(pii.bbox.y / data.viewport.height) * 100}%`,
                              width: `${(pii.bbox.width / data.viewport.width) * 100}%`,
                              height: `${(pii.bbox.height / data.viewport.height) * 100}%`,
                              // Solid = corroborated by both engines, dashed = single engine.
                              border: both ? '2px solid #EF4444' : ocrOnly ? '2px dashed #F97316' : '2px solid #EF4444',
                              background: 'rgba(239, 68, 68, 0.28)',
                              boxShadow: '0 0 8px rgba(239, 68, 68, 0.6)'
                            }}
                          >
                            <span className="absolute -top-4 left-0 bg-red-600 text-white font-mono font-bold text-[9px] px-1 rounded whitespace-nowrap">
                              {pii.type} · {sources.join('+')}
                            </span>
                          </div>
                        );
                      })}

                      {/* Render OCR token boxes in cyan */}
                      {!showPiiOnly && ocrTokens.slice(0, 300).map((tok, i) => (
                        <div
                          key={`ocr-box-${i}`}
                          title={`${tok.text} (${tok.confidence}%)`}
                          style={{
                            position: 'absolute',
                            left: `${(tok.bbox.x / data.viewport.width) * 100}%`,
                            top: `${(tok.bbox.y / data.viewport.height) * 100}%`,
                            width: `${(tok.bbox.width / data.viewport.width) * 100}%`,
                            height: `${(tok.bbox.height / data.viewport.height) * 100}%`,
                            border: '1px solid rgba(34, 211, 238, 0.55)',
                            background: 'rgba(34, 211, 238, 0.10)'
                          }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
