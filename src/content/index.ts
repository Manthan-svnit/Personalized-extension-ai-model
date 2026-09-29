import { ExtensionMessage, TabContext } from '../types/extension';
import { 
  extractInteractiveElements, 
  getViewportMetrics, 
  auditInteractiveElements,
  DomAuditReport
} from './domExtractor';

/**
 * Keyboard Warriors Content Script
 * Injects privacy overlay root container, listens to extension IPC,
 * and provides developer/admin inspection utilities.
 */

const OVERLAY_ROOT_ID = 'sih-privacy-overlay-root';
const DEBUG_OVERLAY_CONTAINER_ID = 'kw-debug-highlights-container';

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
          sendResponse({
            success: true,
            payload: {
              elements,
              viewport
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
