export type MessageType = 
  | 'PING' 
  | 'PONG' 
  | 'GET_TAB_CONTEXT' 
  | 'TAB_CONTEXT_RESPONSE' 
  | 'EXECUTE_ACTION' 
  | 'PROCESS_OFFSCREEN'
  | 'CAPTURE_SCREENSHOT'
  | 'EXTRACT_DOM'
  | 'GET_SCREEN_AND_DOM'
  /**
   * Public request types. The background service worker handles these and forwards
   * them to the offscreen document using the `OFFSCREEN_*` types below. Keeping the
   * two sets distinct guarantees the offscreen listener can never re-handle a message
   * that the background already dispatched (which would recurse indefinitely and make
   * the winning `sendResponse` non-deterministic).
   */
  | 'PROCESS_VISION'
  | 'SCAN_PII'
  | 'RENDER_DETECTION_OVERLAY'
  | 'CLEAR_DETECTION_OVERLAY'
  /** Offscreen-document-only dispatch types. Never handled by the background. */
  | 'OFFSCREEN_RUN_VISION'
  | 'OFFSCREEN_SCAN_PII';

export interface ExtensionMessage { 
  type: MessageType; 
  payload?: any; 
  sender?: string; 
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export interface ExtractedElement {
  id: string;
  tagName: string;
  type?: string;
  role?: string;
  text: string;
  /** Associated <label> text resolved via for/id, parent container, or sibling heuristics */
  labelText?: string;
  selector: string;
  xpath: string;
  bbox: BoundingBox;
  attributes: Record<string, string>;
}

/**
 * A visible static text node that matched one or more PII regex patterns.
 * Harvested from <span>, <div>, <p>, <h1>–<h6> that expose data like emails,
 * phone numbers, Aadhaar IDs, etc. in the rendered page.
 */
export interface StaticTextNode {
  id: string;
  tagName: string;
  text: string;
  selector: string;
  xpath: string;
  bbox: BoundingBox;
  /** PII pattern types that triggered inclusion of this node */
  matchedPatterns: Array<'EMAIL' | 'PHONE' | 'CREDIT_CARD' | 'NATIONAL_ID' | 'ACCOUNT_NUM'>;
}

export type PiiSource = 'DOM' | 'OCR';

export interface VisionDetection {
  label: 'face' | 'person' | 'ui_element' | 'document' | 'card';
  confidence: number;
  /**
   * Full `BoundingBox` in CSS viewport pixels (x/y are aliases of left/top).
   * Every source in the pipeline — DOM, OCR and vision — emits this identical shape,
   * so overlay rendering and cross-source de-duplication can treat them uniformly.
   */
  bbox: BoundingBox;
  source: 'YOLOv8' | 'BlazeFace';
}

/** Per-model diagnostics, so a partial vision failure is visible instead of silent. */
export interface VisionModelStatus {
  model: 'BlazeFace' | 'YOLOv8n';
  loaded: boolean;
  executionProvider?: string;
  error?: string;
}

export interface VisionMeta {
  modelsUsed: string[];
  processingTimeMs: number;
  statuses?: VisionModelStatus[];
  /** Populated when the vision stage failed outright. */
  error?: string;
  faceCount?: number;
  objectCount?: number;
}

export interface VisionPayload {
  detections: VisionDetection[];
  modelsUsed: string[];
  processingTimeMs: number;
  statuses?: VisionModelStatus[];
  faceCount?: number;
  objectCount?: number;
  error?: string;
}

export interface ExtractedOCRToken {
  text: string;
  bbox: BoundingBox;
  confidence: number;
}

/** A reconstructed OCR text line, used to rebuild readable page text. */
export interface ExtractedOCRLine {
  text: string;
  bbox: BoundingBox;
  confidence: number;
}

/** Lifecycle + diagnostics for the on-device OCR engine. */
export interface OCRMeta {
  status: 'idle' | 'loading' | 'ready' | 'running' | 'done' | 'error';
  /** Human-readable description of the current or last completed stage. */
  stage: string;
  progress: number;
  tokenCount: number;
  lineCount: number;
  /** Full text reconstructed from the recognized lines. */
  fullText: string;
  meanConfidence: number;
  durationMs: number;
  /** Upscale factor applied to the screenshot before recognition. */
  scale: number;
  engine: string;
  /** Resolved local asset URLs the engine loaded its runtime from. */
  assets: { worker: string; core: string; lang: string };
  error?: string;
}

export interface DetectedPII {
  id: string;
  type: 'EMAIL' | 'PHONE' | 'CREDIT_CARD' | 'NATIONAL_ID' | 'PASSWORD' | 'NAME' | 'ADDRESS' | 'ACCOUNT_NUM';
  text: string;
  bbox: BoundingBox;
  /**
   * The source that owns this detection. DOM wins when both sources see the same
   * value in the same region, because DOM text is exact and carries a CSS selector.
   */
  source: PiiSource;
  /**
   * Every source that independently flagged this value.
   *
   * A DOM hit and an OCR hit for the same on-screen value are *one* piece of PII
   * found by *two* engines, so they are merged here rather than one being discarded.
   * `source` alone under-reports OCR: a page whose PII also exists in the DOM would
   * otherwise show an empty OCR column even though OCR did match it.
   */
  sources: PiiSource[];
  selector?: string;
  confidence?: number;
  /** Text surrounding the match, used to explain why it was flagged. */
  context?: string;
}

export interface ScreenAndDomPayload {
  screenshotUrl: string;
  elements: ExtractedElement[];
  /** Visible static text nodes containing PII-like data harvested from the page */
  staticTextNodes?: StaticTextNode[];
  viewport: { 
    width: number; 
    height: number; 
    devicePixelRatio: number; 
  };
  visionDetections?: VisionDetection[];
  visionMeta?: VisionMeta;
  ocrTokens?: ExtractedOCRToken[];
  ocrLines?: ExtractedOCRLine[];
  ocrMeta?: OCRMeta;
  piiDetections?: DetectedPII[];
  piiMeta?: {
    totalScanned: number;
    flaggedCount: number;
    /** Detections whose primary source was the DOM pass. */
    domFlaggedCount?: number;
    /** Detections whose primary source was the OCR pass — PII no DOM walk could see. */
    ocrFlaggedCount?: number;
    /** Values OCR matched at all, including those the DOM also claimed. */
    ocrMatchedCount?: number;
    /** Values flagged independently by both DOM and OCR. */
    corroboratedCount?: number;
    processingTimeMs: number;
    error?: string;
  };
}

/** Payload used to draw detection boxes over the live page. */
export interface DetectionOverlayPayload {
  visionDetections?: VisionDetection[];
  piiDetections?: DetectedPII[];
  ocrTokens?: ExtractedOCRToken[];
  /** Viewport the boxes are expressed in; overlays are clamped to it. */
  viewport: { width: number; height: number; devicePixelRatio: number };
  /** Which layers to draw. All default to true when omitted. */
  layers?: { vision?: boolean; pii?: boolean; ocr?: boolean };
}

export interface TabContext {
  tabId?: number;
  title: string;
  url: string;
  favIconUrl?: string;
  selectedText?: string;
  metaDescription?: string;
  headings?: string[];
  simplifiedContent?: string;
  timestamp: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  privacyShieldActive?: boolean;
  sanitizedEntities?: string[];
  tabContext?: {
    title: string;
    url: string;
  };
}

export interface OffscreenProcessRequest {
  action: 'SANITIZE_PII' | 'SUMMARIZE_LOCAL' | 'ANALYZE_SECURITY' | 'INSPECT_FORMS';
  text: string;
  tabInfo?: {
    url: string;
    title: string;
  };
}

export interface OffscreenProcessResponse {
  success: boolean;
  action: string;
  result: string;
  maskedCount?: number;
  detectedEntities?: string[];
  confidenceScore?: number;
  processingTimeMs?: number;
}

export interface ExtensionActionPayload {
  actionType: 'SHOW_PRIVACY_TOAST' | 'HIGHLIGHT_ELEMENT' | 'TOGGLE_SHIELD_OVERLAY' | 'INSPECT_PAGE_PRIVACY';
  message?: string;
  details?: any;
}
