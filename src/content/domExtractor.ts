import { ExtractedElement, StaticTextNode, BoundingBox } from '../types/extension';

/**
 * Selector matching form controls, navigation, and custom ARIA interactive elements
 */
const INTERACTIVE_SELECTORS = [
  'input',
  'button',
  'select',
  'textarea',
  'a',
  'img',
  '[role="img"]',
  '[role="button"]',
  '[role="link"]',
  '[role="textbox"]',
  '[role="checkbox"]',
  '[role="combobox"]',
  '[role="menuitem"]',
  '[contenteditable="true"]',
  '[contenteditable=""]'
].join(', ');

/**
 * Selectors for static visible text blocks to scan for PII patterns.
 */
const STATIC_TEXT_SELECTORS = 'span, div, p, li, td, th, h1, h2, h3, h4, h5, h6';

/**
 * Maximum character count a static text node may contain to be eligible.
 */
const STATIC_TEXT_MAX_LENGTH = 300;

// ─── PII patterns (mirrored for self-contained static-text detection) ─────────
const STATIC_PII_PATTERNS: Record<string, RegExp> = {
  EMAIL: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  PHONE: /\b(?:\+?[1-9]\d{0,2}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/,
  CREDIT_CARD: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/,
  NATIONAL_ID: /\b[2-9]\d{3}\s?\d{4}\s?\d{4}\b/,
  ACCOUNT_NUM: /\b\d{9,18}\b/,
};

/**
 * Identity and accessibility attributes to extract
 */
const KEY_ATTRIBUTES = [
  'name',
  'type',
  'role',
  'placeholder',
  'aria-label',
  'aria-labelledby',
  'aria-describedby',
  'aria-hidden',
  'aria-expanded',
  'aria-checked',
  'aria-disabled',
  'disabled',
  'readonly',
  'required',
  'href',
  'title',
  'alt',
  'value',
  'data-testid'
];

export type SkipReason = 
  | 'EXTENSION_OVERLAY'
  | 'ZERO_DIMENSIONS'
  | 'OUT_OF_VIEWPORT'
  | 'CSS_HIDDEN';

export interface SkippedElement {
  element: Element;
  tagName: string;
  text: string;
  reason: SkipReason;
  details: string;
  rect: { width: number; height: number; top: number; left: number };
}

export interface DomAuditReport {
  timestamp: number;
  viewport: { width: number; height: number; devicePixelRatio: number };
  totalCandidates: number;
  extractedCount: number;
  skippedCount: number;
  staticTextNodeCount: number;
  extracted: ExtractedElement[];
  skipped: SkippedElement[];
  staticTextNodes: StaticTextNode[];
}

/**
 * Detailed visibility and filter evaluation with reason reporting
 */
export function evaluateElementVisibility(el: Element): { visible: boolean; reason?: SkipReason; details?: string } {
  // Exclude elements belonging to our own extension overlays
  if (el.closest('#sih-privacy-overlay-root, #kw-detection-overlay-root, #kw-debug-highlights-container')) {
    return { visible: false, reason: 'EXTENSION_OVERLAY', details: 'Belongs to extension overlay' };
  }

  const rect = el.getBoundingClientRect();

  // 1. Dimensions check
  if (rect.width === 0 || rect.height === 0) {
    return { visible: false, reason: 'ZERO_DIMENSIONS', details: `width=${Math.round(rect.width)}, height=${Math.round(rect.height)}` };
  }

  // 2. Viewport visibility bounds check
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

  if (
    rect.bottom <= 0 ||
    rect.right <= 0 ||
    rect.top >= viewportHeight ||
    rect.left >= viewportWidth
  ) {
    return {
      visible: false,
      reason: 'OUT_OF_VIEWPORT',
      details: `top=${Math.round(rect.top)}, bottom=${Math.round(rect.bottom)}, vh=${viewportHeight}`
    };
  }

  // 3. Computed style check
  const style = window.getComputedStyle(el);
  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.visibility === 'collapse' ||
    style.opacity === '0'
  ) {
    return {
      visible: false,
      reason: 'CSS_HIDDEN',
      details: `display=${style.display}, visibility=${style.visibility}, opacity=${style.opacity}`
    };
  }

  return { visible: true };
}

/**
 * Check if element is rendered, non-zero sized, and within visible viewport
 */
export function isElementVisible(el: Element): boolean {
  return evaluateElementVisibility(el).visible;
}

// ─── Label Association ────────────────────────────────────────────────────────

/**
 * Attempt to resolve the human-readable label text associated with a form input.
 * Checks in priority order:
 *  1. <label for="id"> matching the input's id attribute
 *  2. Wrapping <label> ancestor
 *  3. aria-label / aria-labelledby attribute on the input itself
 *  4. Preceding sibling element text
 *  5. Parent container short text (e.g. <div>Name *<input .../></div>)
 */
export function resolveInputLabelText(input: Element): string | undefined {
  // 1. <label for="id"> matching
  if (input.id && input.id.trim()) {
    const forLabel = document.querySelector(`label[for="${CSS.escape(input.id.trim())}"]`);
    if (forLabel) {
      const text = (forLabel.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) return text;
    }
  }

  // 2. Wrapping <label> ancestor
  const wrappingLabel = input.closest('label');
  if (wrappingLabel) {
    const clone = wrappingLabel.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('input, button, select, textarea').forEach(c => c.remove());
    const text = (clone.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) return text;
  }

  // 3. aria-label on element itself
  const ariaLabel = input.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

  // 4. aria-labelledby reference
  const labelledBy = input.getAttribute('aria-labelledby');
  if (labelledBy) {
    const refEl = document.getElementById(labelledBy);
    if (refEl) {
      const text = (refEl.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) return text;
    }
  }

  // 5. Immediately preceding sibling element text
  const prevSibling = input.previousElementSibling;
  if (prevSibling && !prevSibling.matches('input, button, select, textarea, a')) {
    const text = (prevSibling.textContent || '').replace(/\s+/g, ' ').trim();
    if (text && text.length <= 80) return text;
  }

  // 6. Direct parent container short text
  const parent = input.parentElement;
  if (parent) {
    const clone = parent.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('input, button, select, textarea').forEach(c => c.remove());
    const parentText = (clone.textContent || '').replace(/\s+/g, ' ').trim();
    if (parentText && parentText.length <= 80) return parentText;
  }

  return undefined;
}

/**
 * Generate a unique, safe CSS selector for an Element
 */
export function generateCssSelector(el: Element): string {
  // If element has a valid, unique ID
  if (el.id && typeof el.id === 'string' && el.id.trim()) {
    const escapedId = CSS.escape(el.id.trim());
    const selector = `#${escapedId}`;
    try {
      if (document.querySelectorAll(selector).length === 1) {
        return selector;
      }
    } catch {
      // Fallback to path if invalid selector
    }
  }

  const path: string[] = [];
  let current: Element | null = el;

  while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
    const tagName = current.tagName.toLowerCase();

    // Check if ID on intermediate element provides unique anchor
    if (current.id && typeof current.id === 'string' && current.id.trim()) {
      const escapedId = CSS.escape(current.id.trim());
      const idSelector = `#${escapedId}`;
      try {
        if (document.querySelectorAll(idSelector).length === 1) {
          path.unshift(idSelector);
          break;
        }
      } catch {
        // Continue upward
      }
    }

    // Name attribute anchor for form controls
    const nameAttr = current.getAttribute('name');
    if (nameAttr && current.parentElement) {
      const nameSelector = `${tagName}[name="${CSS.escape(nameAttr)}"]`;
      if (current.parentElement.querySelectorAll(nameSelector).length === 1) {
        path.unshift(nameSelector);
        current = current.parentElement;
        continue;
      }
    }

    // Positional nth-of-type indexing
    let index = 1;
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.tagName.toLowerCase() === tagName) {
        index++;
      }
      sibling = sibling.previousElementSibling;
    }

    path.unshift(`${tagName}:nth-of-type(${index})`);
    current = current.parentElement;
  }

  return path.join(' > ');
}

/**
 * Generate a unique, absolute XPath string starting from root
 */
export function generateXPath(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;

  while (current && current.nodeType === Node.ELEMENT_NODE) {
    let index = 1;
    let sibling = current.previousElementSibling;
    const tagName = current.tagName.toLowerCase();

    while (sibling) {
      if (sibling.tagName.toLowerCase() === tagName) {
        index++;
      }
      sibling = sibling.previousElementSibling;
    }

    parts.unshift(`${tagName}[${index}]`);
    current = current.parentElement;
  }

  return '/' + parts.join('/');
}

/**
 * Extract clean, accessible textual representation of an element
 */
export function extractElementText(el: Element): string {
  // 1. Check aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim()) {
    return ariaLabel.trim();
  }

  // 2. Check aria-labelledby
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const labelEl = document.getElementById(labelledBy);
    if (labelEl && labelEl.textContent && labelEl.textContent.trim()) {
      return labelEl.textContent.trim();
    }
  }

  // 3. Form input value/placeholder
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.placeholder && el.placeholder.trim()) {
      return el.placeholder.trim();
    }
    if (el.value && el.value.trim() && el.type !== 'password') {
      return el.value.trim();
    }
  }

  // 4. Alt or Title attributes
  const alt = el.getAttribute('alt');
  if (alt && alt.trim()) return alt.trim();

  const title = el.getAttribute('title');
  if (title && title.trim()) return title.trim();

  // 5. Direct visible text content
  const textContent = (el instanceof HTMLElement ? el.innerText : el.textContent) || '';
  const cleaned = textContent.replace(/\s+/g, ' ').trim();
  if (cleaned) {
    // Truncate overly long text snippets to maintain lean payload
    return cleaned.length > 120 ? cleaned.slice(0, 117) + '...' : cleaned;
  }

  return '';
}

/**
 * Extract clean dictionary of key identity attributes
 */
export function extractElementAttributes(el: Element): Record<string, string> {
  const attributes: Record<string, string> = {};

  for (const attrName of KEY_ATTRIBUTES) {
    const value = el.getAttribute(attrName);
    if (value !== null && value !== '') {
      // For security, do not expose password values in attributes
      if (attrName === 'value' && el.getAttribute('type') === 'password') {
        attributes[attrName] = '[PROTECTED]';
      } else {
        attributes[attrName] = value.trim();
      }
    }
  }

  return attributes;
}

/**
 * Extract all interactive DOM elements with label association
 */
export function extractInteractiveElements(): ExtractedElement[] {
  const elements: ExtractedElement[] = [];
  const nodes = document.querySelectorAll(INTERACTIVE_SELECTORS);

  nodes.forEach((node, index) => {
    if (!(node instanceof Element)) return;
    if (!isElementVisible(node)) return;

    const rect = node.getBoundingClientRect();
    const bbox: BoundingBox = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      top: Math.round(rect.top),
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      bottom: Math.round(rect.bottom)
    };

    const tagName = node.tagName.toLowerCase();
    const type = node.getAttribute('type') || (node instanceof HTMLInputElement || node instanceof HTMLButtonElement ? node.type : undefined);
    const role = node.getAttribute('role') || undefined;
    const text = extractElementText(node);
    const selector = generateCssSelector(node);
    const xpath = generateXPath(node);
    const attributes = extractElementAttributes(node);

    // Resolve label text for form controls
    let labelText: string | undefined;
    if (['input', 'select', 'textarea'].includes(tagName)) {
      labelText = resolveInputLabelText(node);
    }

    elements.push({
      id: node.id || `kw-el-${index}`,
      tagName,
      type: type || undefined,
      role: role || undefined,
      text,
      labelText,
      selector,
      xpath,
      bbox,
      attributes
    });
  });

  return elements;
}

// ─── Static PII Text Node Harvesting ─────────────────────────────────────────

/**
 * Determine which PII pattern types are present in a text string
 */
function detectPiiPatternsInText(
  text: string
): Array<'EMAIL' | 'PHONE' | 'CREDIT_CARD' | 'NATIONAL_ID' | 'ACCOUNT_NUM'> {
  const matched: Array<'EMAIL' | 'PHONE' | 'CREDIT_CARD' | 'NATIONAL_ID' | 'ACCOUNT_NUM'> = [];

  for (const [key, regex] of Object.entries(STATIC_PII_PATTERNS)) {
    const freshRegex = new RegExp(regex.source);
    if (freshRegex.test(text)) {
      matched.push(key as 'EMAIL' | 'PHONE' | 'CREDIT_CARD' | 'NATIONAL_ID' | 'ACCOUNT_NUM');
    }
  }

  return matched;
}

/**
 * Harvest static visible text nodes from the page containing PII-like data.
 * Scans <span>, <div>, <p>, <h1>-<h6>, <li>, <td>, <th> that:
 *  - Are visible in the viewport
 *  - Contain no interactive child elements
 *  - Have text shorter than STATIC_TEXT_MAX_LENGTH
 *  - Match at least one PII pattern regex
 */
export function extractStaticPiiTextNodes(): StaticTextNode[] {
  const results: StaticTextNode[] = [];
  const seenTexts = new Set<string>();
  const candidates = document.querySelectorAll(STATIC_TEXT_SELECTORS);

  candidates.forEach((node, idx) => {
    if (!(node instanceof HTMLElement)) return;

    // Overlay labels are rendered text too; scanning them would make the tool report
    // its own annotations as page PII on the next run.
    if (node.closest('#sih-privacy-overlay-root, #kw-detection-overlay-root, #kw-debug-highlights-container')) return;

    if (node.querySelector('input, button, select, textarea, a')) return;

    const evalResult = evaluateElementVisibility(node);
    if (!evalResult.visible) return;

    const rawText = (node.innerText || '').replace(/\s+/g, ' ').trim();
    if (!rawText || rawText.length < 3 || rawText.length > STATIC_TEXT_MAX_LENGTH) return;

    const normKey = rawText.toLowerCase().replace(/\s+/g, '');
    if (seenTexts.has(normKey)) return;

    const matchedPatterns = detectPiiPatternsInText(rawText);
    if (matchedPatterns.length === 0) return;

    seenTexts.add(normKey);

    const rect = node.getBoundingClientRect();
    const bbox: BoundingBox = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      top: Math.round(rect.top),
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      bottom: Math.round(rect.bottom)
    };

    results.push({
      id: node.id || `kw-static-${idx}`,
      tagName: node.tagName.toLowerCase(),
      text: rawText,
      selector: generateCssSelector(node),
      xpath: generateXPath(node),
      bbox,
      matchedPatterns
    });
  });

  return results;
}

/**
 * Developer & Admin Audit: Runs complete extraction and tracks extracted vs skipped elements
 * and harvested static PII text nodes.
 */
export function auditInteractiveElements(): DomAuditReport {
  const nodes = document.querySelectorAll(INTERACTIVE_SELECTORS);
  const extracted: ExtractedElement[] = [];
  const skipped: SkippedElement[] = [];

  nodes.forEach((node, index) => {
    if (!(node instanceof Element)) return;

    const evalResult = evaluateElementVisibility(node);
    const rect = node.getBoundingClientRect();

    if (!evalResult.visible) {
      skipped.push({
        element: node,
        tagName: node.tagName.toLowerCase(),
        text: extractElementText(node),
        reason: evalResult.reason || 'CSS_HIDDEN',
        details: evalResult.details || '',
        rect: {
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          top: Math.round(rect.top),
          left: Math.round(rect.left)
        }
      });
      return;
    }

    const bbox: BoundingBox = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      top: Math.round(rect.top),
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      bottom: Math.round(rect.bottom)
    };

    const tagName = node.tagName.toLowerCase();
    const type =
      node.getAttribute('type') ||
      (node instanceof HTMLInputElement || node instanceof HTMLButtonElement ? node.type : undefined);
    const role = node.getAttribute('role') || undefined;
    const text = extractElementText(node);
    const selector = generateCssSelector(node);
    const xpath = generateXPath(node);
    const attributes = extractElementAttributes(node);

    let labelText: string | undefined;
    if (['input', 'select', 'textarea'].includes(tagName)) {
      labelText = resolveInputLabelText(node);
    }

    extracted.push({
      id: node.id || `kw-el-${index}`,
      tagName,
      type: type || undefined,
      role: role || undefined,
      text,
      labelText,
      selector,
      xpath,
      bbox,
      attributes
    });
  });

  const staticTextNodes = extractStaticPiiTextNodes();

  return {
    timestamp: Date.now(),
    viewport: getViewportMetrics(),
    totalCandidates: nodes.length,
    extractedCount: extracted.length,
    skippedCount: skipped.length,
    staticTextNodeCount: staticTextNodes.length,
    extracted,
    skipped,
    staticTextNodes
  };
}

/**
 * Get current viewport metrics
 */
export function getViewportMetrics(): { width: number; height: number; devicePixelRatio: number } {
  return {
    width: window.innerWidth || document.documentElement.clientWidth || 0,
    height: window.innerHeight || document.documentElement.clientHeight || 0,
    devicePixelRatio: window.devicePixelRatio || 1
  };
}
