import { ExtractedElement, BoundingBox } from '../types/extension';

/**
 * Selector matching form controls, navigation, and custom ARIA interactive elements
 */
const INTERACTIVE_SELECTORS = [
  'input',
  'button',
  'select',
  'textarea',
  'a',
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
  extracted: ExtractedElement[];
  skipped: SkippedElement[];
}

/**
 * Detailed visibility and filter evaluation with reason reporting
 */
export function evaluateElementVisibility(el: Element): { visible: boolean; reason?: SkipReason; details?: string } {
  // Exclude elements belonging to our own extension overlay
  if (el.closest('#sih-privacy-overlay-root')) {
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
 * Extract all interactive DOM elements matching requirements
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

    elements.push({
      id: node.id || `kw-el-${index}`,
      tagName,
      type: type || undefined,
      role: role || undefined,
      text,
      selector,
      xpath,
      bbox,
      attributes
    });
  });

  return elements;
}

/**
 * Developer & Admin Audit: Runs complete extraction and tracks what was extracted vs skipped
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
    const type = node.getAttribute('type') || (node instanceof HTMLInputElement || node instanceof HTMLButtonElement ? node.type : undefined);
    const role = node.getAttribute('role') || undefined;
    const text = extractElementText(node);
    const selector = generateCssSelector(node);
    const xpath = generateXPath(node);
    const attributes = extractElementAttributes(node);

    extracted.push({
      id: node.id || `kw-el-${index}`,
      tagName,
      type: type || undefined,
      role: role || undefined,
      text,
      selector,
      xpath,
      bbox,
      attributes
    });
  });

  return {
    timestamp: Date.now(),
    viewport: getViewportMetrics(),
    totalCandidates: nodes.length,
    extractedCount: extracted.length,
    skippedCount: skipped.length,
    extracted,
    skipped
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
