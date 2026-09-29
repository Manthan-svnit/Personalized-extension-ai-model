export type MessageType = 
  | 'PING' 
  | 'PONG' 
  | 'GET_TAB_CONTEXT' 
  | 'TAB_CONTEXT_RESPONSE' 
  | 'EXECUTE_ACTION' 
  | 'PROCESS_OFFSCREEN'
  | 'CAPTURE_SCREENSHOT'
  | 'EXTRACT_DOM'
  | 'GET_SCREEN_AND_DOM';

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
  selector: string;
  xpath: string;
  bbox: BoundingBox;
  attributes: Record<string, string>;
}

export interface ScreenAndDomPayload {
  screenshotUrl: string;
  elements: ExtractedElement[];
  viewport: { 
    width: number; 
    height: number; 
    devicePixelRatio: number; 
  };
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
