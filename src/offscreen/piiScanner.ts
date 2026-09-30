import type {
  ExtractedElement,
  StaticTextNode,
  ExtractedOCRToken,
  DetectedPII,
  BoundingBox,
  PiiSource,
} from '../types/extension';

/**
 * High-Precision PII Detection Engine for Keyboard Warriors
 *
 * Combines three complementary sources of truth:
 *   1. DOM elements      – exact text, plus attribute/label heuristics (passwords, cc fields…)
 *   2. Static text nodes – rendered page text that pre-matched a PII pattern
 *   3. OCR               – visual text reconstructed from screenshot tokens
 *
 * ── Why OCR is scanned as *lines*, not words ──────────────────────────────────
 * Tesseract emits one token per word, so `+91 98765 43210` arrives as three tokens and
 * `4111 1111 1111 1111` as four. Matching a regex per token can never see across those
 * boundaries, so the most common PII categories were undetectable through OCR. Instead,
 * tokens are regrouped into visual lines (see `groupTokensIntoLines`), the line text is
 * reassembled using measured inter-word gaps, and every match is projected back onto the
 * union of the bounding boxes it actually covers.
 *
 * ── Why OCR patterns are matched leniently ───────────────────────────────────
 * Visual recognition confuses glyphs: `0`/`O`, `1`/`l`/`I`, `5`/`S`, `8`/`B`, `2`/`Z`.
 * A strict digit class misses the very values it is meant to catch, so digit patterns get
 * a second, confusable-tolerant pass whose detections are reported at lower confidence.
 */

// ─── 1. Regex Rules (exact / DOM-oriented) ────────────────────────────────────

/**
 * Country-code prefix for phone patterns.
 *
 * A leading run of 1–3 digits is only accepted as a country code when it is visibly
 * marked, with a `+` or a separator. Allowing `\d{1,3}` to butt straight up against the
 * number body lets a 12-digit identifier be re-read as `1` + `234 5678 9012`, which is how
 * an Aadhaar number ends up reported as a phone number.
 */
const CC_PREFIX = '(?:\\+\\d{1,3}[-.\\s]?|\\d{1,3}[-.][\\s]?)';

/**
 * Left anchor for numeric patterns.
 *
 * `\b` cannot be used in front of an optional `+`: there is no word boundary between a
 * space and a `+`, so `+91 98765 43210` never matched as a whole and the country code was
 * silently dropped from the reported value. A lookbehind expresses the actual intent —
 * "not glued to another alphanumeric character".
 */
const NUM_START = '(?<![A-Za-z0-9])';

export const PII_PATTERNS = {
  EMAIL: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  PHONE: new RegExp(
    `${NUM_START}(?:${CC_PREFIX}[-.\\s]?)?\\(?\\d{3}\\)?[-.\\s]?\\d{3}[-.\\s]?\\d{4}\\b`,
    'g'
  ),
  /**
   * Landline-with-area-code form (3-4-4), e.g. `080-2345-6789` or `011 2345 6789`.
   * The 3-3-4 pattern above cannot match it, and these are extremely common on Indian
   * contact pages — the exact pages a privacy tool is pointed at.
   */
  PHONE_LANDLINE: new RegExp(
    `${NUM_START}(?:${CC_PREFIX})?\\d{3}[-.\\s]\\d{4}[-.\\s]\\d{4}\\b`,
    'g'
  ),
  /**
   * 5+5 grouping (`98765 43210`), the standard rendering of an Indian mobile number.
   * Only the OCR-lenient set knew how to read this, which meant the *same* number was
   * found on an image but not in the DOM text of the very same page — the two engines
   * have to cover the same formats for the corroboration counts to mean anything.
   */
  PHONE_MOBILE_55: new RegExp(
    `${NUM_START}(?:${CC_PREFIX})?\\d{5}[-.\\s]\\d{5}\\b`,
    'g'
  ),
  CREDIT_CARD:
    /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
  /**
   * 13–19 digits in 4-digit groups (`4111 1111 1111 1111`), which the issuer-prefix
   * pattern above cannot match because it requires an unbroken digit run. Luhn decides.
   */
  CREDIT_CARD_GROUPED: /\b(?:\d[ -]?){12,18}\d\b/g,
  NATIONAL_ID: /\b[2-9]\d{3}\s?\d{4}\s?\d{4}\b/g, // Aadhaar format (12 digits, optional spaces)
  SSN: /\b\d{3}-\d{2}-\d{4}\b/g, // US SSN
};

// ─── 2. OCR-lenient digit classes ────────────────────────────────────────────

/**
 * Glyphs Tesseract routinely confuses when reading digits. Every numeric pattern below
 * is widened to accept these look-alikes, so a value read as `l23-45-6789` is still
 * recognised as `123-45-6789`. The first Aadhaar digit additionally tolerates `O`/`l`
 * because the semantic rule there is "not 0 or 1", not "is a specific digit".
 */
const ANY_DIGIT_CLASS = '[0-9OoIlZSGB]';

function N(count: number, max?: number): string {
  return max === undefined
    ? `(?:${ANY_DIGIT_CLASS}){${count}}`
    : `(?:${ANY_DIGIT_CLASS}){${count},${max}}`;
}

/**
 * Lenient patterns applied *only* to OCR text. Detection confidence is reduced to
 * reflect the chance of a glyph-level false positive.
 */
const OCR_LENIENT_PATTERNS: Array<{
  type: DetectedPII['type'];
  regex: RegExp;
  confidence: number;
  validate?: (match: string) => boolean;
}> = [
  {
    // Card numbers: 13–19 digits with optional 4-group separators. Rather than relying on
    // issuer prefixes (which fail on OCR'd spacing and unknown issuers), the candidate is
    // captured generically and the Luhn checksum decides.
    type: 'CREDIT_CARD',
    regex: new RegExp(
      `(?<![A-Za-z0-9])(?:${ANY_DIGIT_CLASS}[\\s-]?){12,18}${ANY_DIGIT_CLASS}(?![A-Za-z0-9])`,
      'g'
    ),
    confidence: 0.72,
    validate: (match) => isValidLuhn(match),
  },
  {
    // Aadhaar / national ID: 12 digits, commonly printed as 4-4-4.
    type: 'NATIONAL_ID',
    regex: new RegExp(
      `(?<![A-Za-z0-9])[2-9OoIl]${N(3)}[\\s-]?${N(4)}[\\s-]?${N(4)}(?![A-Za-z0-9])`,
      'g'
    ),
    confidence: 0.7,
  },
  {
    // Phone: optional country code, then 3-3-4, 5-5, or 3-4-4 digit groupings.
    // The country-code group mirrors CC_PREFIX: a bare leading `1` must not be peeled off
    // a 12-digit identifier and reinterpreted as a prefix.
    type: 'PHONE',
    regex: new RegExp(
      `(?<![A-Za-z0-9])(?:\\+${N(1, 3)}[\\s.-]?|${N(1, 3)}[.][\\s])?` +
        `(?:${N(3)}[\\s.-]?${N(3)}[\\s.-]?${N(4)}` +
        `|${N(5)}[\\s.-]?${N(5)}` +
        `|${N(3)}[\\s.-]${N(4)}[\\s.-]${N(4)})(?![A-Za-z0-9])`,
      'g'
    ),
    confidence: 0.68,
    /**
     * An unformatted run of 10–15 digits is a phone number far less often than it is an
     * order id, a timestamp or a 12-digit government identifier. Requiring exactly 10
     * digits when nothing separates the groups keeps `Track 987654321098` out of the
     * report while still catching `9876543210`.
     */
    validate: (match) => {
      const digits = match.replace(/\D/g, '');
      if (digits.length < 10 || digits.length > 15) return false;
      return /[\s.+-]/.test(match) || digits.length === 10;
    },
  },
  {
    // US SSN: 3-2-4.
    type: 'NATIONAL_ID',
    regex: new RegExp(`(?<![A-Za-z0-9])${N(3)}[\\s-]${N(2)}[\\s-]${N(4)}(?![A-Za-z0-9])`, 'g'),
    confidence: 0.72,
  },
];

// ─── 3. Heuristic Context Matchers ────────────────────────────────────────────

const HEURISTIC_KEYWORDS = {
  PASSWORD: /(?:password|passwd|passcode|pin|secret|cvv|cvc|security[_-]?code)/i,
  CREDIT_CARD:
    /(?:credit[_-]?card|debit[_-]?card|card[_-]?number|cc[_-]?number|card[_-]?num|cc[_-]?num|exp[_-]?date|cvv|cvc)/i,
  NATIONAL_ID:
    /(?:aadhaar|ssn|social[_-]?security|passport|national[_-]?id|tax[_-]?id|pan[_-]?card|voter[_-]?id)/i,
  ACCOUNT_NUM:
    /(?:account[_-]?num|acct[_-]?num|account[_-]?number|bank[_-]?acc|routing[_-]?num|iban|swift)/i,
  ADDRESS:
    /(?:street[_-]?address|billing[_-]?address|shipping[_-]?address|postal[_-]?code|zip[_-]?code|residential[_-]?address)/i,
  NAME: /(?:full[_-]?name|first[_-]?name|last[_-]?name|customer[_-]?name|cardholder[_-]?name)/i,
};

/** Account/bank numbers are ambiguous on their own, so require nearby context. */
const ACCOUNT_CONTEXT =
  /(?:account|acct|a\/c|acc\.?|bank|routing|rtgs|neft|imps|iban|swift|ifsc|cheque|check\s*no)/i;

/**
 * A bare 12-digit run is not an identity document. Government identifiers appear next to
 * a label; transaction and tracking identifiers appear next to a different one. Without
 * this split, `Track 987654321098` reports as an Aadhaar number.
 */
const ID_CONTEXT =
  /(?:aadhaar|aadhar|uidai|national\s*id|identity\s*(?:no|number|proof)|id\s*(?:no|number)|govt|government|voter|passport|pan\s*(?:card|no|number)|ssn|social\s*security|tax\s*id)/i;

const NON_ID_CONTEXT =
  /(?:order|tracking|track|invoice|receipt|bill\s*no|txn|transaction|utr|reference|ref\s*no|ticket|coupon|promo|batch|job|sku|imei|imn|order\s*id|tracking\s*id|trace|waybill|awb|rrn|rr\s*no)/i;

/** Surrounding window (characters) inspected for account-number context. */
const CONTEXT_WINDOW = 48;

/**
 * Validate a card number using the Luhn Algorithm
 */
function isValidLuhn(ccNum: string): boolean {
  const digits = ccNum.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = parseInt(digits.charAt(i), 10);
    if (Number.isNaN(digit)) return false;
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

// ─── 4. Bounding-box helpers ──────────────────────────────────────────────────

function makeBBox(left: number, top: number, right: number, bottom: number): BoundingBox {
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right,
    bottom,
  };
}

/** Overlap ratio of two boxes (intersection over the smaller area). */
function overlapRatio(a: BoundingBox, b: BoundingBox): number {
  const iw = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const ih = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (iw <= 0 || ih <= 0) return 0;
  const intersection = iw * ih;
  const smaller = Math.min(a.width * a.height, b.width * b.height);
  return smaller > 0 ? intersection / smaller : 0;
}

/** Normalized fingerprint used to recognize the same value reported by two sources. */
function normalizeValue(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
    .replace(/[oil]/g, '1')
    .replace(/[z]/g, '2')
    .replace(/[s]/g, '5')
    .replace(/[b]/g, '8')
    .replace(/[g]/g, '9')
    .replace(/[a]/g, '4')
    .replace(/[u]/g, '0');
}

function contextAround(text: string, start: number, end: number): string {
  return text
    .slice(Math.max(0, start - CONTEXT_WINDOW), Math.min(text.length, end + CONTEXT_WINDOW))
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── 5. Generic text scanning ─────────────────────────────────────────────────

interface ScanOptions {
  baseId: string;
  source: 'DOM' | 'OCR';
  selector?: string;
  /** Supplied by OCR so a match's exact sub-region can be highlighted. */
  resolveBBox?: (start: number, end: number) => BoundingBox | null;
  /** OCR additionally runs the confusable-tolerant pattern set. */
  lenient?: boolean;
  /** Confidence multiplier for the whole scan (OCR text is noisier than DOM text). */
  confidenceScale?: number;
}

/**
 * Scan a single text string against every PII rule.
 * Returns detections in document order, with stable ids.
 */
function scanText(text: string, fallbackBBox: BoundingBox, options: ScanOptions): DetectedPII[] {
  const detected: DetectedPII[] = [];
  if (!text || text.trim().length < 3) return detected;

  const {
    baseId,
    source,
    selector,
    resolveBBox,
    lenient = false,
    confidenceScale = 1,
  } = options;

  /**
   * Character span of every detection emitted so far, parallel to `detected`.
   * A 16-digit card also satisfies the 12-digit Aadhaar pattern on its first 12 digits,
   * and ranges settle that overlap exactly — comparing bounding boxes cannot, because a
   * DOM element's box covers its whole text run.
   */
  const ranges: Array<{ start: number; end: number }> = [];
  const isCovered = (start: number, end: number): boolean =>
    ranges.some((r) => start >= r.start && end <= r.end);

  const push = (
    type: DetectedPII['type'],
    value: string,
    start: number,
    end: number,
    confidence: number
  ) => {
    const bbox = resolveBBox?.(start, end) ?? fallbackBBox;
    detected.push({
      id: `${baseId}-${type.toLowerCase()}-${detected.length}`,
      type,
      text: value,
      bbox,
      source,
      sources: [source],
      selector,
      confidence: Math.round(confidence * confidenceScale * 100) / 100,
      context: contextAround(text, start, end),
    });
    ranges.push({ start, end });
  };

  // 1. Email — OCR reads `@` reliably enough that the strict pattern is kept.
  for (const match of text.matchAll(new RegExp(PII_PATTERNS.EMAIL.source, 'g'))) {
    const raw = match[0];
    const domain = raw.split('@')[1] ?? '';
    // Reject obvious false positives such as "user@localhost" or version strings.
    if (!domain.includes('.')) continue;
    if (/\.(png|jpg|jpeg|gif|webp|svg|css|js|html?)$/i.test(domain)) continue;
    push('EMAIL', raw, match.index, match.index + raw.length, 0.97);
  }

  // 2. SSN (strict digits, hyphenated).
  for (const match of text.matchAll(new RegExp(PII_PATTERNS.SSN.source, 'g'))) {
    const raw = match[0];
    push('NATIONAL_ID', raw, match.index, match.index + raw.length, 0.95);
  }

  // 3. Credit card (strict digits, Luhn-validated). Scanned before the 12-digit national-ID
  //    pattern so the card wins the overlap and the ID rule skips it.
  for (const match of text.matchAll(new RegExp(PII_PATTERNS.CREDIT_CARD.source, 'g'))) {
    const raw = match[0];
    if (isValidLuhn(raw)) {
      push('CREDIT_CARD', raw, match.index, match.index + raw.length, 0.96);
    }
  }

  // 3b. Grouped card numbers (`4111 1111 1111 1111`). Without this pass the 12-digit
  //     national-ID pattern matches the first 12 digits of the card and reports both.
  for (const match of text.matchAll(new RegExp(PII_PATTERNS.CREDIT_CARD_GROUPED.source, 'g'))) {
    const raw = match[0];
    const start = match.index;
    const end = start + raw.length;
    if (isCovered(start, end)) continue;
    if (!isValidLuhn(raw)) continue;
    push('CREDIT_CARD', raw, start, end, 0.95);
  }

  // 4. Aadhaar / national ID (strict digits), gated on surrounding context.
  for (const match of text.matchAll(new RegExp(PII_PATTERNS.NATIONAL_ID.source, 'g'))) {
    const raw = match[0];
    const start = match.index;
    const end = start + raw.length;
    if (raw.replace(/\s/g, '').length !== 12) continue;
    if (isCovered(start, end)) continue;

    const context = contextAround(text, start, end);
    if (NON_ID_CONTEXT.test(context)) continue;

    push('NATIONAL_ID', raw, start, end, ID_CONTEXT.test(context) ? 0.94 : 0.62);
  }

  // 5. Phone (strict digits, formatting-aware).
  for (const match of text.matchAll(new RegExp(PII_PATTERNS.PHONE.source, 'g'))) {
    const raw = match[0];
    const start = match.index;
    const end = start + raw.length;
    if (isCovered(start, end)) continue;

    const digitsOnly = raw.replace(/\D/g, '');
    const hasFormatting = /[-.()\s+]/.test(raw);
    const valid =
      (hasFormatting && digitsOnly.length >= 10 && digitsOnly.length <= 15) ||
      (!hasFormatting && digitsOnly.length === 10);
    if (valid) {
      push('PHONE', raw, start, end, 0.9);
    }
  }

  // 5b. Landline form (3-4-4), e.g. `080-2345-6789`, and 5-5 mobile form, e.g. `98765 43210`.
  for (const pattern of [PII_PATTERNS.PHONE_LANDLINE, PII_PATTERNS.PHONE_MOBILE_55]) {
    for (const match of text.matchAll(new RegExp(pattern.source, 'g'))) {
      const raw = match[0];
      const start = match.index;
      const end = start + raw.length;
      if (isCovered(start, end)) continue;
      push('PHONE', raw, start, end, 0.88);
    }
  }

  // 6. Account / bank numbers. Deliberately context-gated: a bare 9–18 digit run is far
  //    more likely to be an order id, timestamp or price than an account number.
  for (const match of text.matchAll(/\b\d{9,18}\b/g)) {
    const raw = match[0];
    const start = match.index;
    const end = start + raw.length;

    if (detected.some((d) => d.text === raw)) continue;
    if (isCovered(start, end)) continue;
    if (isValidLuhn(raw) && raw.length >= 13) continue; // already reported as a card

    if (!ACCOUNT_CONTEXT.test(contextAround(text, start, end))) continue;
    push('ACCOUNT_NUM', raw, start, end, 0.85);
  }

  // 7. OCR-lenient numeric patterns, catching glyph-confused values.
  if (lenient) {
    for (const rule of OCR_LENIENT_PATTERNS) {
      for (const match of text.matchAll(new RegExp(rule.regex.source, 'g'))) {
        const raw = match[0];
        const start = match.index;
        const end = start + raw.length;
        if (rule.validate && !rule.validate(raw)) continue;

        // Skip if an exact match already covered this span at higher confidence.
        if (isCovered(start, end)) continue;
        if (detected.some((d) => d.text === raw)) continue;
        if (detected.some((d) => normalizeValue(d.text) === normalizeValue(raw))) continue;

        // The lenient ID rule is as ambiguous as the strict one, so it obeys the same
        // context rules rather than reporting every 12-digit glyph run.
        let confidence = rule.confidence;
        if (rule.type === 'NATIONAL_ID') {
          const context = contextAround(text, start, end);
          if (NON_ID_CONTEXT.test(context)) continue;
          if (ID_CONTEXT.test(context)) confidence = 0.85;
        }

        push(rule.type, raw, start, end, confidence);
      }
    }
  }

  return detected;
}

// ─── 6. DOM element heuristics ────────────────────────────────────────────────

function scanDomElementHeuristics(el: ExtractedElement, index: number): DetectedPII[] {
  const detected: DetectedPII[] = [];
  const attrs = el.attributes || {};

  const typeAttr = (attrs['type'] || el.type || '').toLowerCase();
  const autocomplete = (attrs['autocomplete'] || '').toLowerCase();
  const name = (attrs['name'] || '').toLowerCase();
  const id = (el.id || '').toLowerCase();
  const placeholder = (attrs['placeholder'] || '').toLowerCase();
  const ariaLabel = (attrs['aria-label'] || attrs['aria-labelledby'] || '').toLowerCase();
  const value = (attrs['value'] || '').trim();

  // Include the resolved label text — it is often the only place a field names itself.
  const contextString = `${name} ${id} ${placeholder} ${ariaLabel} ${attrs['class'] || ''} ${
    el.labelText || ''
  }`;

  const emit = (type: DetectedPII['type'], text: string, confidence: number) => {
    detected.push({
      id: `dom-heuristic-${type.toLowerCase()}-${index}`,
      type,
      text,
      bbox: el.bbox,
      source: 'DOM',
      sources: ['DOM'],
      selector: el.selector,
      confidence,
      context: (el.labelText || placeholder || name).slice(0, 80),
    });
  };

  // 1. Password Field — return early, nothing else to check.
  if (
    typeAttr === 'password' ||
    autocomplete.includes('password') ||
    HEURISTIC_KEYWORDS.PASSWORD.test(contextString)
  ) {
    emit('PASSWORD', value ? '••••••••' : `[Password Input: ${placeholder || name || id || 'masked'}]`, 0.99);
    return detected;
  }

  // 2. Credit Card Context
  if (
    autocomplete.includes('cc-number') ||
    autocomplete.includes('cc-exp') ||
    autocomplete.includes('cc-csc') ||
    HEURISTIC_KEYWORDS.CREDIT_CARD.test(contextString)
  ) {
    if (value || placeholder) {
      emit('CREDIT_CARD', value || `[Credit Card Field: ${placeholder || name}]`, 0.95);
    }
  }

  // 3. National ID Context
  if (HEURISTIC_KEYWORDS.NATIONAL_ID.test(contextString)) {
    if (value || placeholder) {
      emit('NATIONAL_ID', value || `[National ID Field: ${placeholder || name}]`, 0.92);
    }
  }

  // 4. Account / Routing Number Context
  if (HEURISTIC_KEYWORDS.ACCOUNT_NUM.test(contextString)) {
    if (value || placeholder) {
      emit('ACCOUNT_NUM', value || `[Bank Account Field: ${placeholder || name}]`, 0.9);
    }
  }

  // 5. Physical Address Context
  if (
    autocomplete.includes('address') ||
    autocomplete.includes('postal-code') ||
    autocomplete.includes('zip') ||
    HEURISTIC_KEYWORDS.ADDRESS.test(contextString)
  ) {
    if (value || placeholder) {
      emit('ADDRESS', value || `[Address Field: ${placeholder || name}]`, 0.88);
    }
  }

  // 6. Person Name Context
  if (
    autocomplete === 'name' ||
    autocomplete === 'given-name' ||
    autocomplete === 'family-name' ||
    HEURISTIC_KEYWORDS.NAME.test(contextString)
  ) {
    if (value && value.length > 2) {
      emit('NAME', value, 0.86);
    }
  }

  return detected;
}

// ─── 7. OCR line reconstruction ───────────────────────────────────────────────

interface OCRWordSpan {
  start: number;
  end: number;
  token: ExtractedOCRToken;
}

interface OCRTextLine {
  text: string;
  spans: OCRWordSpan[];
  bbox: BoundingBox;
  meanConfidence: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Regroup OCR word tokens into visual lines.
 *
 * Tokens are bucketed by vertical centre (within a fraction of the median glyph height),
 * then ordered left-to-right. Inter-word gaps are measured so that a real space is
 * inserted only when the tokens are visually separated — this keeps `98765 43210` split
 * while rejoining an over-eager split of `9876543210`.
 */
export function groupTokensIntoLines(tokens: ExtractedOCRToken[]): OCRTextLine[] {
  if (tokens.length === 0) return [];

  const heights = tokens.map((t) => t.bbox.height).filter((h) => h > 0);
  const medianHeight = median(heights) || 12;
  const yTolerance = Math.max(4, medianHeight * 0.6);

  const ordered = [...tokens].sort(
    (a, b) => a.bbox.y + a.bbox.height / 2 - (b.bbox.y + b.bbox.height / 2)
  );

  const buckets: ExtractedOCRToken[][] = [];
  const bucketCenters: number[] = [];

  for (const token of ordered) {
    const center = token.bbox.y + token.bbox.height / 2;

    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < buckets.length; i++) {
      const distance = Math.abs(bucketCenters[i] - center);
      if (distance <= yTolerance && distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }

    if (bestIndex === -1) {
      buckets.push([token]);
      bucketCenters.push(center);
    } else {
      buckets[bestIndex].push(token);
      // Re-centre on the median so the bucket does not drift as words are added.
      bucketCenters[bestIndex] = median(
        buckets[bestIndex].map((t) => t.bbox.y + t.bbox.height / 2)
      );
    }
  }

  return buckets.map((bucket) => {
    const sorted = [...bucket].sort((a, b) => a.bbox.left - b.bbox.left);
    const lineHeights = sorted.map((t) => t.bbox.height).filter((h) => h > 0);
    const referenceHeight = median(lineHeights) || medianHeight;

    let text = '';
    const spans: OCRWordSpan[] = [];

    sorted.forEach((token, i) => {
      if (i > 0) {
        const previous = sorted[i - 1];
        const gap = token.bbox.left - (previous.bbox.left + previous.bbox.width);
        // A gap wider than ~45% of the glyph height is a real word space.
        if (gap > referenceHeight * 0.45) text += ' ';
      }
      const start = text.length;
      text += token.text;
      spans.push({ start, end: text.length, token });
    });

    const left = Math.min(...sorted.map((t) => t.bbox.left));
    const right = Math.max(...sorted.map((t) => t.bbox.right));
    const top = Math.min(...sorted.map((t) => t.bbox.top));
    const bottom = Math.max(...sorted.map((t) => t.bbox.bottom));

    return {
      text,
      spans,
      bbox: makeBBox(left, top, right, bottom),
      meanConfidence: median(sorted.map((t) => t.confidence)),
    };
  });
}

// ─── 8. Public API ────────────────────────────────────────────────────────────

/**
 * scanPayloadForPII
 *
 * Runs the full PII rule set over DOM elements, static page text, and reconstructed
 * OCR lines, and returns a de-duplicated list of detections.
 *
 * DOM hits win over OCR hits for the same visual region, since DOM text is exact and
 * carries a CSS selector; the OCR box is only used when no DOM source claims the area.
 *
 * @param domElements   - Interactive elements parsed from the active web page
 * @param ocrTokens     - Word tokens extracted by the on-device OCR engine
 * @param staticTextNodes - Visible page text nodes that pre-matched a PII pattern
 */
export function scanPayloadForPII(
  domElements: ExtractedElement[] = [],
  ocrTokens: ExtractedOCRToken[] = [],
  staticTextNodes: StaticTextNode[] = []
): DetectedPII[] {
  const detections: DetectedPII[] = [];

  /**
   * Merge a detection into the accumulated list.
   *
   * When two sources flag the same value in the same on-screen region they are folded into
   * a single entry whose `sources` records both engines. Keeping only one of them — which
   * is what happened before — made the OCR pass look inert on any page whose PII is also
   * present in the DOM, even though OCR had matched it.
   *
   * DOM still wins as the primary source, because DOM text is exact and carries a CSS
   * selector that the overlay can use for element-level highlighting.
   */
  const addIfUnique = (item: DetectedPII): void => {
    for (let i = 0; i < detections.length; i++) {
      const existing = detections[i];
      if (existing.type !== item.type) continue;
      if (overlapRatio(existing.bbox, item.bbox) <= 0.3) continue;

      const sameValue =
        normalizeValue(existing.text) === normalizeValue(item.text) ||
        existing.text === item.text;
      if (!sameValue) continue;

      const primary = item.source === 'DOM' ? item : existing;
      const secondary = primary === item ? existing : item;

      detections[i] = {
        ...primary,
        sources: [...new Set([...existing.sources, ...item.sources])].sort(),
        selector: primary.selector ?? secondary.selector,
        confidence: Math.max(existing.confidence ?? 0, item.confidence ?? 0),
        context: primary.context ?? secondary.context,
      };
      return;
    }

    detections.push(item);
  };

  // ─── 1. DOM elements: metadata heuristics + exact text ─────────────────────
  domElements.forEach((el, index) => {
    scanDomElementHeuristics(el, index).forEach(addIfUnique);

    const textPool = [
      el.text || '',
      el.attributes['value'] || '',
      el.attributes['placeholder'] || '',
      el.attributes['aria-label'] || '',
      el.labelText || '',
    ].join(' ');

    scanText(textPool, el.bbox, {
      baseId: `dom-${index}`,
      source: 'DOM',
      selector: el.selector,
    }).forEach(addIfUnique);
  });

  // ─── 2. Static page text ────────────────────────────────────────────────────
  staticTextNodes.forEach((node, index) => {
    scanText(node.text, node.bbox, {
      baseId: `static-${index}`,
      source: 'DOM',
      selector: node.selector,
    }).forEach(addIfUnique);
  });

  // ─── 3. OCR, reconstructed as visual lines ─────────────────────────────────
  const ocrLines = groupTokensIntoLines(ocrTokens);

  ocrLines.forEach((line, index) => {
    // Project a character span back onto the union of the tokens it covers, so a phone
    // number split across three tokens highlights all three.
    const resolveBBox = (start: number, end: number): BoundingBox | null => {
      const hits = line.spans.filter((span) => span.end > start && span.start < end);
      if (hits.length === 0) return line.bbox;
      return makeBBox(
        Math.min(...hits.map((h) => h.token.bbox.left)),
        Math.min(...hits.map((h) => h.token.bbox.top)),
        Math.max(...hits.map((h) => h.token.bbox.right)),
        Math.max(...hits.map((h) => h.token.bbox.bottom))
      );
    };

    scanText(line.text, line.bbox, {
      baseId: `ocr-line-${index}`,
      source: 'OCR',
      resolveBBox,
      lenient: true,
    }).forEach(addIfUnique);
  });

  return detections;
}

export interface PIIScanSummary {
  total: number;
  /** Detections whose primary source is the DOM. */
  domFlagged: number;
  /** Detections whose primary source is OCR — i.e. only vision of the text found these. */
  ocrFlagged: number;
  /** Detections both engines independently flagged. */
  corroborated: number;
  /** Detections OCR contributed to, whether or not DOM also claimed them. */
  ocrMatched: number;
}

/**
 * Tally detections by provenance.
 *
 * `ocrMatched` is the number that answers "did OCR find anything on this page" — including
 * values the DOM already knew about. `ocrFlagged` is the stricter "found only by OCR"
 * count, i.e. PII that is invisible to any DOM walk (canvas, images, video, PDF viewers).
 */
export function summarizePIIDetections(detections: DetectedPII[]): PIIScanSummary {
  const summary: PIIScanSummary = {
    total: detections.length,
    domFlagged: 0,
    ocrFlagged: 0,
    corroborated: 0,
    ocrMatched: 0,
  };

  for (const d of detections) {
    const sources: PiiSource[] = d.sources ?? [d.source];

    if (d.source === 'DOM') summary.domFlagged++;
    else summary.ocrFlagged++;

    if (sources.includes('OCR')) summary.ocrMatched++;
    if (sources.includes('DOM') && sources.includes('OCR')) summary.corroborated++;
  }

  return summary;
}
