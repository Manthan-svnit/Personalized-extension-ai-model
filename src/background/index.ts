import { ExtensionMessage, TabContext, ScreenAndDomPayload } from '../types/extension';

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

          const { elements, viewport } = domResponse.payload;

          sendResponse({
            success: true,
            payload: {
              screenshotUrl,
              elements,
              viewport
            }
          });
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

    default:
      // Other unhandled messages
      return false;
  }
});
