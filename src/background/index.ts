import { 
  ExtensionMessage, 
  TabContext, 
  ScreenAndDomPayload, 
  VisionDetection,
  VisionMeta,
  DetectedPII,
  ExtractedOCRToken,
  ExtractedOCRLine,
  OCRMeta,
  DetectionOverlayPayload
} from '../types/extension';

const OFFSCREEN_DOCUMENT_PATH = 'src/offscreen/offscreen.html';
let creatingOffscreenPromise: Promise<void> | null = null;

/**
 * Configure extension behavior on install
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[Keyboard Warriors] Extension installed/updated:', details.reason);

  try {
    // Configure Chrome side panel to open when user clicks extension action icon
    if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
      console.log('[Keyboard Warriors] Side panel behavior set to openPanelOnActionClick');
    }
  } catch (error) {
    console.error('[Keyboard Warriors] Error setting side panel behavior:', error);
  }

  // Pre-seed local storage default settings
  chrome.storage.local.set({
    privacyShieldEnabled: true,
    localModelActive: true,
    installedAt: Date.now(),
  });
});

/**
 * Offscreen document creation and management lifecycle helper
 */
async function ensureOffscreenDocument(): Promise<void> {
  if (!chrome.offscreen) {
    console.warn('[Keyboard Warriors] chrome.offscreen API not available');
    return;
  }

  // If already creating, wait for the existing promise
  if (creatingOffscreenPromise) {
    return creatingOffscreenPromise;
  }

  // Check if an offscreen document already exists using chrome.runtime.getContexts if supported
  if ('getContexts' in chrome.runtime) {
    try {
      const contexts = await (chrome.runtime as any).getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)]
      });
      if (contexts && contexts.length > 0) {
        return;
      }
    } catch (e) {
      // Fallback if getContexts is unavailable or fails
    }
  }

  // Check using chrome.offscreen.hasDocument if supported (Chrome 116+)
  if ('hasDocument' in chrome.offscreen) {
    try {
      const hasDoc = await (chrome.offscreen as any).hasDocument();
      if (hasDoc) {
        return;
      }
    } catch (e) {
      // Continue to create
    }
  }

  creatingOffscreenPromise = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: 'Local privacy-preserving ONNX inference and worker execution'
      });
      console.log('[Keyboard Warriors] Offscreen document created successfully');
    } catch (error: any) {
      // If document already exists, ignore the duplicate error
      if (!error?.message?.includes('Only a single offscreen document may be created')) {
        console.error('[Keyboard Warriors] Failed to create offscreen document:', error);
        throw error;
      }
    } finally {
      creatingOffscreenPromise = null;
    }
  })();

  return creatingOffscreenPromise;
}

/**
 * Check if a tab URL is an active web document (http:// or https://)
 */
function isValidWebUrl(url?: string): boolean {
  if (!url) return false;
  return url.startsWith('http://') || url.startsWith('https://');
}

/**
 * Screen Capture Handler: captures visible viewport of target window as PNG
 */
async function captureViewport(windowId?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const targetWindowId = windowId ?? chrome.windows.WINDOW_ID_CURRENT;
    chrome.tabs.captureVisibleTab(
      targetWindowId,
      { format: 'png' },
      (dataUrl) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (!dataUrl) {
          return reject(new Error('Failed to capture visible tab: Empty image data returned'));
        }
        resolve(dataUrl);
      }
    );
  });
}

/**
 * Get active tab and request DOM context from content script
 */
async function getActiveTabContext(): Promise<TabContext> {
  let [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!activeTab || !activeTab.id) {
    const tabs = await chrome.tabs.query({ active: true });
    activeTab = tabs.find(t => t.url && (t.url.startsWith('http://') || t.url.startsWith('https://'))) || tabs[0];
  }
  
  if (!activeTab || !activeTab.id) {
    return {
      title: 'No active tab',
      url: 'about:blank',
      timestamp: Date.now()
    };
  }

  const fallbackContext: TabContext = {
    tabId: activeTab.id,
    title: activeTab.title || 'Untitled Tab',
    url: activeTab.url || '',
    favIconUrl: activeTab.favIconUrl,
    timestamp: Date.now()
  };

  // If chrome:// or edge:// url, cannot inject content script
  if (!isValidWebUrl(activeTab.url)) {
    return fallbackContext;
  }

  try {
    const response = await chrome.tabs.sendMessage(activeTab.id, {
      type: 'GET_TAB_CONTEXT'
    } as ExtensionMessage);

    if (response && response.type === 'TAB_CONTEXT_RESPONSE' && response.payload) {
      return {
        ...fallbackContext,
        ...response.payload
      };
    }
  } catch (error) {
    // Content script might not be injected yet or page is still loading
    console.debug('[Keyboard Warriors] Content script unreachable, using basic tab info:', error);
  }

  return fallbackContext;
}

/**
 * Central IPC Router via chrome.runtime.onMessage
 */
chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  const messageType = message?.type;

  switch (messageType) {
    case 'PING': {
      sendResponse({
        type: 'PONG',
        payload: { timestamp: Date.now() },
        sender: 'background'
      });
      return true;
    }

    case 'GET_TAB_CONTEXT': {
      getActiveTabContext()
        .then((tabContext) => {
          sendResponse({
            type: 'TAB_CONTEXT_RESPONSE',
            payload: tabContext,
            sender: 'background'
          });
        })
        .catch((error) => {
          sendResponse({
            type: 'TAB_CONTEXT_RESPONSE',
            payload: {
              title: 'Context unavailable',
              url: '',
              timestamp: Date.now(),
              error: String(error)
            },
            sender: 'background'
          });
        });
      return true; // Keep message channel open for async response
    }

    case 'CAPTURE_SCREENSHOT': {
      (async () => {
        try {
          let [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (!activeTab || !activeTab.id) {
            const tabs = await chrome.tabs.query({ active: true });
            activeTab = tabs.find(t => t.url && (t.url.startsWith('http://') || t.url.startsWith('https://'))) || tabs[0];
          }

          if (!activeTab || !activeTab.id) {
            sendResponse({ success: false, error: 'No active tab found' });
            return;
          }

          if (!isValidWebUrl(activeTab.url)) {
            sendResponse({
              success: false,
              error: 'Screen capture is only supported on http:// and https:// pages'
            });
            return;
          }

          const screenshotUrl = await captureViewport(activeTab.windowId);
          sendResponse({
            success: true,
            payload: { screenshotUrl },
            sender: 'background'
          });
        } catch (error) {
          sendResponse({
            success: false,
            error: String(error),
            sender: 'background'
          });
        }
      })();
      return true;
    }

    case 'GET_SCREEN_AND_DOM': {
      (async () => {
        try {
          // 1. Query active tab using lastFocusedWindow (works even when DevTools or Side Panel has focus)
          let [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

          // 2. If lastFocusedWindow returns no tab, fallback to searching all tabs
          if (!activeTab || !activeTab.id) {
            const tabs = await chrome.tabs.query({ active: true });
            activeTab = tabs.find(t => t.url && (t.url.startsWith('http://') || t.url.startsWith('https://'))) || tabs[0];
          }

          if (!activeTab || !activeTab.id) {
            sendResponse({ success: false, error: 'No active tab found' });
            return;
          }

          const tabId = activeTab.id;
          const windowId = activeTab.windowId;

          // Check if tab URL is restricted (chrome://, chrome-extension://, edge://, about:blank, etc.)
          if (!isValidWebUrl(activeTab.url)) {
            sendResponse({
              success: false,
              error: 'Cannot execute script on restricted URL'
            });
            return;
          }

          // Concurrently capture viewport and extract DOM from active tab
          const [screenshotUrl, domResponse] = await Promise.all([
            captureViewport(windowId),
            (async (): Promise<any> => {
              try {
                return await chrome.tabs.sendMessage(tabId, {
                  type: 'EXTRACT_DOM'
                } as ExtensionMessage);
              } catch (sendErr: any) {
                // If content script was not yet injected (e.g., page opened before extension reload), inject it dynamically
                if (chrome.scripting && sendErr?.message?.includes('Receiving end does not exist')) {
                  try {
                    await chrome.scripting.executeScript({
                      target: { tabId },
                      files: ['src/content/index.js']
                    });
                    return await chrome.tabs.sendMessage(tabId, {
                      type: 'EXTRACT_DOM'
                    } as ExtensionMessage);
                  } catch (injectErr) {
                    throw new Error('Please refresh the web page tab so the content script can attach.');
                  }
                }
                throw sendErr;
              }
            })()
          ]);

          if (!domResponse || !domResponse.success || !domResponse.payload) {
            sendResponse({
              success: false,
              error: domResponse?.error || 'Failed to extract DOM elements from target page'
            });
            return;
          }

          const { elements, viewport, staticTextNodes } = domResponse.payload;

          // Forward screenshot to offscreen document for vision inference and OCR + PII
          // scanning concurrently.
          let visionDetections: VisionDetection[] = [];
          let visionMeta: VisionMeta | undefined;
          let piiDetections: DetectedPII[] = [];
          let ocrTokens: ExtractedOCRToken[] = [];
          let ocrLines: ExtractedOCRLine[] = [];
          let ocrMeta: OCRMeta | undefined;
          let piiMeta: ScreenAndDomPayload['piiMeta'];

          try {
            await ensureOffscreenDocument();

            const [visionResponse, piiResponse] = await Promise.all([
              chrome.runtime.sendMessage({
                type: 'OFFSCREEN_RUN_VISION',
                payload: { screenshotUrl, viewport, extractedElements: elements },
                sender: 'background'
              } as ExtensionMessage).catch(err => {
                console.warn('[Keyboard Warriors] Vision dispatch error:', err);
                return null;
              }),
              chrome.runtime.sendMessage({
                type: 'OFFSCREEN_SCAN_PII',
                payload: { screenshotUrl, domElements: elements, staticTextNodes, viewport },
                sender: 'background'
              } as ExtensionMessage).catch(err => {
                console.warn('[Keyboard Warriors] PII dispatch error:', err);
                return null;
              })
            ]);

            if (visionResponse?.success && visionResponse?.payload) {
              visionDetections = visionResponse.payload.detections || [];
              visionMeta = {
                modelsUsed: visionResponse.payload.modelsUsed || [],
                processingTimeMs: visionResponse.payload.processingTimeMs || 0,
                statuses: visionResponse.payload.statuses || [],
                faceCount: visionResponse.payload.faceCount ?? 0,
                objectCount: visionResponse.payload.objectCount ?? 0,
              };
            } else {
              // A dead vision stage must say so; an empty box list reads as "nothing found".
              visionMeta = {
                modelsUsed: [],
                processingTimeMs: 0,
                statuses: [],
                faceCount: 0,
                objectCount: 0,
                error: visionResponse?.error || 'The vision stage did not return a result.',
              };
              console.warn('[Keyboard Warriors] Vision stage failed:', visionMeta.error);
            }

            if (piiResponse?.success && piiResponse?.payload) {
              piiDetections = piiResponse.payload.piiDetections || [];
              ocrTokens = piiResponse.payload.ocrTokens || [];
              ocrLines = piiResponse.payload.ocrLines || [];
              ocrMeta = piiResponse.payload.ocrMeta;
              piiMeta = piiResponse.payload.piiMeta;
            } else {
              ocrMeta = piiResponse?.payload?.ocrMeta;
              piiMeta = {
                totalScanned: 0,
                flaggedCount: 0,
                processingTimeMs: 0,
                error: piiResponse?.error || 'The OCR/PII stage did not return a result.',
              };
              console.warn('[Keyboard Warriors] PII stage failed:', piiMeta.error);
            }
          } catch (offscreenErr: any) {
            const message = offscreenErr?.message || String(offscreenErr);
            console.warn('[Keyboard Warriors] Offscreen processing skipped:', message);
            visionMeta = { modelsUsed: [], processingTimeMs: 0, statuses: [], error: message };
            piiMeta = { totalScanned: 0, flaggedCount: 0, processingTimeMs: 0, error: message };
          }

          const payload: ScreenAndDomPayload = {
            screenshotUrl,
            elements,
            staticTextNodes: staticTextNodes || [],
            viewport,
            visionDetections,
            visionMeta,
            ocrTokens,
            ocrLines,
            ocrMeta,
            piiDetections,
            piiMeta
          };

          sendResponse({ success: true, payload });
        } catch (error: any) {
          console.error('[Keyboard Warriors] GET_SCREEN_AND_DOM error:', error);
          sendResponse({
            success: false,
            error: error?.message || String(error)
          });
        }
      })();
      return true; // Keep message channel open for async sendResponse
    }

    case 'EXECUTE_ACTION': {
      chrome.tabs.query({ active: true, currentWindow: true })
        .then(async ([tab]) => {
          if (!tab || !tab.id) {
            sendResponse({ success: false, error: 'No active tab' });
            return;
          }
          try {
            const result = await chrome.tabs.sendMessage(tab.id, message);
            sendResponse({ success: true, result });
          } catch (err) {
            sendResponse({ success: false, error: String(err) });
          }
        })
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    case 'PROCESS_OFFSCREEN': {
      (async () => {
        try {
          await ensureOffscreenDocument();
          // Dispatch to offscreen document
          const offscreenResponse = await chrome.runtime.sendMessage({
            type: 'PROCESS_OFFSCREEN',
            payload: message.payload,
            sender: 'background'
          });
          sendResponse(offscreenResponse);
        } catch (err) {
          console.error('[Keyboard Warriors] Offscreen routing failed:', err);
          sendResponse({
            success: false,
            error: 'Offscreen worker execution failed: ' + String(err)
          });
        }
      })();
      return true;
    }

    case 'SCAN_PII': {
      (async () => {
        try {
          await ensureOffscreenDocument();
          // Re-dispatched under a distinct type so the offscreen listener is the only
          // handler of this request and therefore the only possible responder.
          const piiResponse = await chrome.runtime.sendMessage({
            type: 'OFFSCREEN_SCAN_PII',
            payload: message.payload,
            sender: 'background'
          } as ExtensionMessage);
          sendResponse(piiResponse);
        } catch (err: any) {
          console.error('[Keyboard Warriors] SCAN_PII background routing failed:', err);
          sendResponse({ success: false, error: err?.message || String(err) });
        }
      })();
      return true;
    }

    case 'RENDER_DETECTION_OVERLAY':
    case 'CLEAR_DETECTION_OVERLAY': {
      (async () => {
        try {
          const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (!activeTab?.id || !isValidWebUrl(activeTab.url)) {
            sendResponse({ success: false, error: 'No inspectable web page is active.' });
            return;
          }

          const target: ExtensionMessage =
            messageType === 'RENDER_DETECTION_OVERLAY'
              ? { type: 'RENDER_DETECTION_OVERLAY', payload: message.payload as DetectionOverlayPayload }
              : { type: 'CLEAR_DETECTION_OVERLAY' };

          const response = await chrome.tabs.sendMessage(activeTab.id, target);
          sendResponse(response ?? { success: true });
        } catch (err: any) {
          // A missing content script is a normal state on a tab that predates the install.
          sendResponse({
            success: false,
            error: 'Content script unavailable — refresh the page, then run the pipeline again.'
          });
        }
      })();
      return true;
    }

    default:
      // Other unhandled messages
      return false;
  }
});
