#!/usr/bin/env node
/**
 * Keyboard Warriors — Project Memory Generator
 * =============================================
 * Regenerates `PROJECT_MEMORY.md` at the repository root: a single, self-contained
 * knowledge base describing this entire folder — architecture, data flow, build
 * pipeline, file-by-file responsibilities, a full content inventory, and the verbatim
 * source of every text file in the project.
 *
 * Why this is a script and not a hand-written document:
 *   - A hand-written memory file drifts from the code the moment anything changes.
 *   - A generator can diff the tree against the previous run and record exactly which
 *     files were added / modified / removed, which is what makes the history section
 *     trustworthy rather than aspirational.
 *
 * Usage:
 *   node scripts/generate-project-memory.mjs
 *   npm run memory
 *
 * What is embedded vs. catalogued:
 *   - EMBEDDED   : full verbatim content of every text file under a size cap.
 *   - CATALOGUED : binaries and oversized generated bundles (ONNX models, WASM blobs,
 *                  traineddata, minified ONNX Runtime builds) get an inventory row with
 *                  size + SHA-256 + purpose. Embedding ~120 MB of vendor binaries would
 *                  make the file unreadable without adding information.
 *
 * Persistence strategy (no extra state files):
 *   - Previous file hashes live in a `<!-- MANIFEST -->` HTML comment inside the output.
 *   - Previous changelog entries live in a `<!-- CHANGELOG -->` HTML comment block.
 *   - The authored prose (analysis, architecture) is the TEMPLATE constant in this file,
 *     so regenerating never loses hand-written knowledge.
 */

import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { join, resolve, relative, sep } from 'path';
import { execFileSync } from 'child_process';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_FILE = resolve(ROOT, 'PROJECT_MEMORY.md');

const SKIP_DIRS = new Set(['.git', 'node_modules']);
/** Files at or above this size are catalogued, not embedded. */
const INLINE_MAX_BYTES = 120 * 1024;
/** Cap on retained changelog entries so the file cannot grow without bound. */
const MAX_CHANGELOG_ENTRIES = 60;

const MARKER = {
  manifestStart: '<!-- MANIFEST:BEGIN -->',
  manifestEnd: '<!-- MANIFEST:END -->',
  changelogStart: '<!-- CHANGELOG:BEGIN -->',
  changelogEnd: '<!-- CHANGELOG:END -->',
  inventoryStart: '<!-- INVENTORY:BEGIN -->',
  inventoryEnd: '<!-- INVENTORY:END -->',
  contentStart: '<!-- CONTENT:BEGIN -->',
  contentEnd: '<!-- CONTENT:END -->',
};

// ─── Binary / oversized extensions that must never be embedded ────────────────
const BINARY_EXT = new Set([
  '.onnx', '.wasm', '.traineddata', '.png', '.jpg', '.jpeg', '.gif', '.webp',
  '.ico', '.zip', '.gz', '.br', '.pdf', '.woff', '.woff2', '.ttf', '.eot',
]);

// ─── Human-readable purpose per file (path first, then extension) ─────────────
const PATH_PURPOSE = {
  'manifest.json':
    'Chrome MV3 manifest. Points at TypeScript sources; the Vite closeBundle hook rewrites .ts → .js in the dist copy.',
  'package.json': 'npm manifest: scripts, runtime deps, dev deps.',
  'package-lock.json': 'Pinned npm dependency graph.',
  'tsconfig.json': 'TypeScript compiler options. `noEmit`, `strict`, `jsx: react-jsx`, `types: ["chrome"]`.',
  'vite.config.ts':
    'Bundler. 4 entry points, custom `chrome-extension-builder` plugin that rewrites the manifest, copies content CSS, copies ONNX Runtime WASM/JS into dist/assets AND dist/src/offscreen, and copies public/models → dist/models.',
  'tailwind.config.js':
    'Tailwind config. Defines the `gemini-*` colour palette, Inter font stack, pulse-glow and gradient-flow keyframes.',
  'postcss.config.js': 'PostCSS pipeline: tailwindcss + autoprefixer.',
  'eng.traineddata':
    'Stray duplicate of the Tesseract English language model sitting at the repository root. The pipeline reads `public/tesseract/lang/eng.traineddata`, so this copy is dead weight (5.2 MB) and safe to delete.',
  'scripts/download-models.mjs':
    'One-off asset fetcher. Downloads blazeface.onnx + yolov8n.onnx from HuggingFace into public/models with redirect following, progress logging and a minimum-size sanity check.',
  'scripts/generate-project-memory.mjs':
    'THIS FILE. Regenerates PROJECT_MEMORY.md (analysis + inventory + full source embeds + changelog).',
  'src/types/extension.ts':
    'Shared type contract. Every MessageType, BoundingBox, ExtractedElement, StaticTextNode, VisionDetection, VisionMeta, OCRMeta, DetectedPII, ScreenAndDomPayload, DetectionOverlayPayload, TabContext, ChatMessage, and the offscreen request/response shapes. Changing a type here breaks every consumer simultaneously.',
  'src/background/index.ts':
    'MV3 service worker. Owns the central IPC router, active-tab resolution, viewport screenshot capture, offscreen-document lifecycle, and orchestration of the concurrent vision + OCR/PII dispatches behind GET_SCREEN_AND_DOM.',
  'src/content/index.ts':
    'Content script (document_idle, <all_urls>). Injects the privacy badge/toast overlay, renders the on-page detection overlay, harvests page context, and exposes window.__KW_DEBUG__ for DevTools inspection.',
  'src/content/domExtractor.ts':
    'DOM walker. Interactive-element extraction, label-association heuristics, CSS-selector + XPath generation, visibility auditing with skip reasons, and static PII text-node harvesting.',
  'src/content/styles.css': 'CSS for the injected privacy badge and toast (sih-* classes).',
  'src/offscreen/index.ts':
    'Offscreen document entry point. Three handlers: PROCESS_OFFSCREEN (legacy text sanitiser), OFFSCREEN_RUN_VISION, OFFSCREEN_SCAN_PII. Also owns LocalPrivacyPipeline.',
  'src/offscreen/visionDetector.ts':
    'ONNX inference. BlazeFace (DOM-guided crops + tiled sweep + full frame) and YOLOv8n, with NMS, cross-pass de-duplication, WebGPU→WASM fallback and per-model status tracking.',
  'src/offscreen/tensorUtils.ts':
    'Tensor maths. Aspect-preserving letterbox into NCHW Float32Array, the inverse box mapping, canvas caching, and legacy stretch helpers.',
  'src/offscreen/ocrEngine.ts':
    'Tesseract.js v7 OCR. Fully local asset resolution (no CDN), percentile contrast stretch, adaptive upscale/downscale, word + line extraction with viewport-space bounding boxes.',
  'src/offscreen/piiScanner.ts':
    'PII detection engine. Exact regex set, OCR-lenient confusable-tolerant set, DOM metadata heuristics, Luhn validation, OCR line reconstruction, and DOM/OCR cross-source merging.',
  'src/offscreen/offscreen.html': 'Minimal host page for the offscreen runtime.',
  'src/sidepanel/sidepanel.html': 'Host page for the React side panel. Loads Inter from Google Fonts and mounts #root.',
  'src/sidepanel/main.tsx': 'React bootstrap wrapped in StrictMode + a top-level ErrorBoundary.',
  'src/sidepanel/App.tsx':
    'Side-panel root. Holds chat state, resolves the active tab context, keyword-routes prompts to a local action, and mounts Header/ChatThread/InputBox/DevInspector.',
  'src/sidepanel/index.css': 'Tailwind entry + base layer, custom scrollbar, gemini-gradient-text and gemini-shimmer helpers.',
  'src/sidepanel/components/Header.tsx': 'Sticky header: brand, "Local Privacy Active" pulse, inspector/refresh/clear buttons.',
  'src/sidepanel/components/ChatThread.tsx':
    'Message list, empty-state starter prompts, per-message copy, on-device shield badge, redaction chips and the shimmer processing state.',
  'src/sidepanel/components/InputBox.tsx':
    'Auto-growing textarea with the active-tab context pill. Enter submits, Shift+Enter newlines. No mic.',
  'src/sidepanel/components/DevInspector.tsx':
    'Full-pipeline inspector modal: Summary / DOM / Vision / PII / OCR / Screenshot tabs, per-stage failure banners, on-page overlay controls and screenshot-relative box preview.',
  'src/sidepanel/components/ErrorBoundary.tsx':
    'Class error boundary with a reset button, so a render throw shows a message instead of a black panel.',
};

const DIR_PURPOSE = {
  'public/models': 'ONNX checkpoints copied verbatim into dist/models at build time.',
  'public/tesseract': 'Tesseract worker script, LSTM WASM cores and the English traineddata, all served from the extension origin.',
  'dist': 'Build output. Load unpacked from dist/ via chrome://extensions.',
  'dist/assets': 'Vite chunks plus every ONNX Runtime WASM/JS bundle, copied in two places so relative resolution works from both the offscreen HTML and the offscreen chunk.',
  'dist/src/offscreen': 'Compiled offscreen chunk plus a second copy of every ORT runtime file.',
  'dist/models': 'Copied ONNX checkpoints.',
  'dist/tesseract': 'Copied Tesseract runtime.',
  'dist/src/content': 'Compiled content script + its CSS.',
  'dist/src/background': 'Compiled service worker.',
  'dist/src/sidepanel': 'Compiled side-panel HTML shell.',
};

// ─── Authored analysis. This is the part a human (or AI) curates. ─────────────
const TEMPLATE = `## 1. What this project is

**Keyboard Warriors** — a Manifest V3 Chrome extension (v1.0.0) that performs *all* of its
AI/vision/OCR work **on-device**. There is no server call, no API key and no network request at
runtime. The product pitch is a "zero-leakage browser copilot": the extension reads the page it is
on, sanitises and analyses it locally, and shows the operator what it found.

The engineering reality is broader than the chat UI suggests. The interesting code is a
**multi-engine page-understanding pipeline** — DOM walking, ONNX object/face detection, on-device
OCR, and a high-precision PII scanner — fronted by a React side panel and a developer inspector.

---

## 2. Technology stack

| Layer | Choice | Version (from package.json) |
|---|---|---|
| Extension platform | Chrome Manifest V3 | — |
| UI | React + ReactDOM | \`^18.3.1\` |
| Build | Vite + @vitejs/plugin-react | \`^5.4.14\` / \`^4.3.4\` |
| Language | TypeScript (strict, \`noEmit\`) | \`^5.7.3\` |
| Styling | Tailwind CSS + PostCSS/autoprefixer | \`^3.4.17\` |
| Icons | lucide-react | \`^0.475.0\` |
| ML runtime | onnxruntime-web | \`^1.20.1\` |
| OCR | tesseract.js | \`^7.0.0\` |
| Class merging | clsx + tailwind-merge | \`^2.1.1\` / \`^2.6.0\` |
| Chrome types | @types/chrome | \`^0.0.306\` |

Model weights are **not** npm dependencies. \`scripts/download-models.mjs\` fetches them from
HuggingFace into \`public/models/\`, and the build copies that directory to \`dist/models/\`.

---

## 3. Architecture — the four execution surfaces

\`\`\`text
┌──────────────────────────────────────────────────────────────────────────┐
│  SIDE PANEL  (extension page, React)                                     │
│  src/sidepanel/sidepanel.html → main.tsx → App.tsx                      │
│  Header · ChatThread · InputBox · DevInspector (modal)                  │
└───────────────┬──────────────────────────────────────────────────────────┘
                │ chrome.runtime.sendMessage
                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  SERVICE WORKER  src/background/index.ts                                 │
│  • central IPC router (chrome.runtime.onMessage)                        │
│  • active tab resolution + chrome.tabs.captureVisibleTab                │
│  • offscreen document lifecycle (ensureOffscreenDocument)               │
│  • fans GET_SCREEN_AND_DOM into vision ‖ OCR+PII                        │
└───────┬───────────────────────────────────────────┬──────────────────────┘
        │ tabs.sendMessage                          │ runtime.sendMessage
        ▼                                           ▼
┌───────────────────────────────┐   ┌────────────────────────────────────────┐
│  CONTENT SCRIPT              │   │  OFFSCREEN DOCUMENT                   │
│  src/content/index.ts        │   │  src/offscreen/index.ts               │
│  + domExtractor.ts           │   │  ├─ visionDetector.ts  (BlazeFace,    │
│  EXTRACT_DOM → elements,     │   │  │                      YOLOv8n)       │
│  static text nodes, viewport │   │  ├─ ocrEngine.ts       (Tesseract.js) │
│  draws overlays, __KW_DEBUG__ │   │  ├─ piiScanner.ts     (PII engine)   │
└───────────────────────────────┘   │  └─ tensorUtils.ts    (letterbox)     │
                                    └────────────────────────────────────────┘
\`\`\`

The **offscreen document exists purely to satisfy CSP**. Extension pages run under
\`script-src 'self'; object-src 'self'\`, which forbids the CDN fetches Tesseract.js normally
performs and forbids \`blob:\` workers. The offscreen document is a real extension page, so local
assets resolve against \`chrome-extension://<id>/\` and the work happens away from the visible UI.

---

## 4. The headline pipeline: \`GET_SCREEN_AND_DOM\`

Triggered by the DevInspector "Run Pipeline" button. This is the most important flow in the repo.

\`\`\`
1. Background resolves the active tab
   - chrome.tabs.query({ active: true, lastFocusedWindow: true })
   - falls back to any http(s) tab, then to tabs[0]
   - rejects non-http(s) URLs (chrome://, edge://, about:blank) with an explicit error

2. In parallel:
   a. captureViewport(windowId) → PNG data URL via chrome.tabs.captureVisibleTab
      NOTE: this returns DEVICE pixels, not CSS pixels.
   b. chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_DOM' })
      - if the content script is missing ("Receiving end does not exist"),
        chrome.scripting.executeScript injects src/content/index.js and retries once
      - content script returns { elements, viewport, staticTextNodes }

3. ensureOffscreenDocument()
   - chrome.runtime.getContexts, then chrome.offscreen.hasDocument, then createDocument
   - a module-level creatingOffscreenPromise de-duplicates concurrent callers

4. In parallel again:
   a. OFFSCREEN_RUN_VISION  { screenshotUrl, viewport, extractedElements }
   b. OFFSCREEN_SCAN_PII    { screenshotUrl, domElements, staticTextNodes, viewport }

5. Background assembles ScreenAndDomPayload and responds.

6. Side panel stores it in DevInspector. The user can then push
   RENDER_DETECTION_OVERLAY back down to the content script to draw boxes on the live page.
\`\`\`

### Why the offscreen message types are suffixed \`OFFSCREEN_\`

\`MessageType\` splits into **public request types** (\`SCAN_PII\`, \`PROCESS_VISION\`) that only the
service worker handles, and **offscreen-only dispatch types** (\`OFFSCREEN_SCAN_PII\`,
\`OFFSCREEN_RUN_VISION\`) that only the offscreen document handles. If a document re-dispatched
under the type it already handles, it would recurse infinitely. If both documents handled the same
type, their \`sendResponse\` calls would race and the winner would be non-deterministic. Keeping
the two sets disjoint makes the routing a partition, not a negotiation.

---

## 5. The coordinate-system contract (get this wrong and everything looks broken)

Every layer — DOM extraction, vision inference, OCR and the overlay renderer — reports boxes in
**CSS viewport pixels**, where \`x === left\` and \`y === top\`.

The transformations that make this hold:

\`\`\`
captureVisibleTab  →  IMAGE pixels ( = CSS × devicePixelRatio )

tensorUtils.buildVisionTensor  →  letterboxed MODEL pixels
    model px = (source px − source.origin) × scale + pad

tensorUtils.mapNormalizedBox  →  back to IMAGE pixels
    (rejects boxes entirely inside the padding — those are grey-border artifacts)

visionDetector / ocrEngine  →  multiply by (viewport.width / naturalWidth)  →  CSS pixels

content.renderDetectionOverlay  →  position: fixed, so no scroll offset is added
\`\`\`

Consequences baked into the code:

- The overlay root is appended to **\`documentElement\`, not \`body\`**. A \`transform\`/\`filter\`/
  \`perspective\` on \`body\` would turn a \`position: fixed\` descendant into one positioned against
  \`body\`, silently shifting every box off the element it marks.
- Letterboxing is mandatory, not stylistic. Stretching a 1920×1080 screenshot into 640×640
  compresses the horizontal axis ~3×, which is the documented cause of "the box is reported but
  does not sit on the object".

---

## 6. Detection engines in detail

### 6.1 DOM extraction — \`domExtractor.ts\`

Selectors: \`input, button, select, textarea, a, img, [role=img|button|link|textbox|checkbox|
combobox|menuitem], [contenteditable]\`.

For each visible element it records: tagName, type, role, text, labelText, CSS selector, XPath,
viewport bbox, and 21 curated attributes (\`name\`, \`type\`, \`role\`, \`placeholder\`, all \`aria-*\`,
\`disabled\`, \`readonly\`, \`required\`, \`href\`, \`title\`, \`alt\`, \`value\`, \`data-testid\`).
A \`value\` on a \`type=password\` input is replaced with the literal \`[PROTECTED]\`.

- \`resolveInputLabelText\` tries six strategies in order: \`label[for]\` → wrapping \`<label>\` →
  \`aria-label\` → \`aria-labelledby\` → preceding sibling text (≤80 chars) → parent text (≤80 chars).
- \`evaluateElementVisibility\` returns a **reason** for every rejection:
  \`EXTENSION_OVERLAY\` | \`ZERO_DIMENSIONS\` | \`OUT_OF_VIEWPORT\` | \`CSS_HIDDEN\`.
- \`extractStaticPiiTextNodes\` separately harvests \`span, div, p, li, td, th, h1..h6\` nodes that
  are visible, childless of interactive elements, ≤300 chars, deduped, and match at least one of
  five PII regexes. Without this pass, PII rendered in ordinary prose would be invisible to the
  whole system because it lives in no form field.

### 6.2 Vision — \`visionDetector.ts\`

\`\`\`
BlazeFace   128×128   conf 0.5   IoU 0.3   max 20 detections   NMS 0.4
YOLOv8n     640×640   conf 0.25  NMS 0.45   COCO-80 → 5 UI labels
\`\`\`

- **Session loading** tries \`executionProviders: ['webgpu','wasm']\` first, then a pure-WASM retry.
  \`ort.env.wasm.numThreads = 1\` because extension pages are not cross-origin isolated, so
  \`SharedArrayBuffer\` is unavailable and threaded WASM would fail isolation mid-session.
- **Failures are recorded per model.** A missing YOLO checkpoint must not hide a working BlazeFace.
  \`VisionModelStatus\` carries \`loaded\`, \`executionProvider\`, \`error\` per model, and a stage that
  died outright sets \`visionMeta.error\` — because an empty box list reads as "found nothing".
- **BlazeFace score is read from offset 15** of each 16-float \`selectedBoxes\` row
  (\`[0..3]\` ymin/xmin/ymax/xmax, \`[4..13]\` 5 keypoints × 2, \`[14]\` unused, \`[15]\` score). It used
  to be hard-coded, which made every face look equally certain.
- **BlazeFace runs three passes, then merges:**
  1. DOM-guided crops — up to 15 elements that are \`IMG\`/\`PICTURE\`/\`role=img\`, or whose
     id/selector/class/alt/src matches \`/avatar|profile|user|author|thumb|photo|portrait|picture/i\`,
     or that are simply 16–300px squares. Highest precision, essentially free.
  2. A tiled sweep — 384px tiles at 25% overlap, capped at 24 tiles. This is what finds faces
     with no \`IMG\` ancestor: canvas avatars, video-call tiles, background-image faces.
  3. A whole-frame pass, kept for faces large enough to survive the downscale.
  Results are de-duplicated by label + IoU.
- **Tiles exist because BlazeFace is short-range.** A 40px avatar squashed from 1920px into a
  128px input becomes ~3px, which is why a naive single-pass configuration reports almost nothing.
- **YOLOv8n** decodes \`[1, 84, 8400]\`, takes the argmax class per anchor, requires score > 0.25,
  maps class 0 → \`person\`, a hand-written class table → \`ui_element\`/\`document\`/\`card\`, and
  falls back to \`ui_element\` above 0.35. Boxes are \`(cx ± w/2)\` converted to normalized space and
  passed back through \`mapNormalizedBox\` to undo the letterbox.
- \`resetSessions()\` clears the cache for memory management.

### 6.3 OCR — \`ocrEngine.ts\`

- All three runtime assets are pinned to the bundle: \`tesseract/worker.min.js\`,
  \`tesseract/core\`, \`tesseract/lang\`. \`workerBlobURL: false\` because MV3's default
  \`worker-src 'self'\` rejects a \`blob:\` worker. \`gzip: false\` because the bundled
  \`traineddata\` is uncompressed.
- \`verifyAssets()\` probes only the ~110KB worker script. The ~5MB language model is deliberately
  *not* pre-fetched — Tesseract downloads it moments later, so a speculative GET would fetch twice.
- \`worker.recognize(canvas, {}, { text: true, blocks: true })\` — the \`blocks: true\` is mandatory.
  The default output is \`{ text: true }\` only, which leaves \`data.blocks\` as \`null\` and silently
  yields zero word boxes. v7 also populates only \`data.blocks\`; \`data.words\` no longer exists.
- \`preprocessRegion\` does a 3-pass grayscale percentile stretch (Rec. 601 luma, 2nd/98th
  percentiles). Screenshots are dominated by flat UI backgrounds, so an untouched capture has a
  narrow luminance band that Tesseract binarizes poorly.
- \`chooseScale\` targets a 2800px longest edge, clamped to \`[0.5, 4]\`. It magnifies small captures
  (16px body text has an ~8px x-height; Tesseract wants ~30px) and **reduces** HiDPI captures,
  since \`captureVisibleTab\` returns image pixels.
- \`tessedit_pageseg_mode: PSM.SPARSE_TEXT\` because a web page is scattered multi-column text,
  not a single document block.
- Returns tokens (with viewport-mapped boxes), reconstructed lines, \`fullText\`, and an \`OCRMeta\`
  lifecycle record surfaced directly in the DevInspector.

### 6.4 PII — \`piiScanner.ts\`

Three independent sources are merged:

| Source | What it sees | Confidence |
|---|---|---|
| DOM metadata heuristics | \`type=password\`, \`autocomplete=cc-*\`, name/label/class keywords | 0.86 – 0.99 |
| DOM exact text + static text nodes | Real content, real selectors | 0.62 – 0.97 |
| OCR reconstructed lines | Text that exists only as pixels | 0.68 – 0.85 |

Design decisions worth preserving:

- **OCR is scanned as *lines*, not words.** Tesseract emits one token per word, so \`+91 98765
  43210\` arrives as three tokens. \`groupTokensIntoLines\` buckets tokens by vertical centre (median
  height × 0.6), orders them left-to-right, and inserts a space only when the measured gap exceeds
  45% of the glyph height. Each match is then projected onto the union of the boxes it covers, so a
  phone number split across three tokens highlights all three.
- **OCR gets a second, lenient pattern pass.** Visual recognition confuses \`0/O\`, \`1/l/I\`,
  \`5/S\`, \`8/B\`, \`2/Z\`, so digit patterns are widened to \`[0-9OoIlZSGB]\` and reported at lower
  confidence (0.68–0.72). \`EMAIL\` is excluded — OCR reads \`@\` reliably.
- **Overlap is resolved by character span, not bounding box.** A 16-digit card also satisfies the
  12-digit Aadhaar pattern on its first 12 digits. \`ranges\`/\`isCovered\` settle it exactly, because
  a DOM element's box covers its whole text run.
- **Context gating.** A bare 12-digit run is not an identity document. \`ID_CONTEXT\` (aadhaar,
  passport, tax id…) raises confidence to 0.94; \`NON_ID_CONTEXT\` (order, tracking, invoice, UTR,
  waybill…) suppresses it entirely — otherwise \`Track 987654321098\` reports as an Aadhaar number.
  Account numbers are similarly gated on \`ACCOUNT_CONTEXT\` within a 48-character window.
- **Card numbers are Luhn-validated.** Both the strict issuer-prefix pattern and the grouped
  \`(?:\\d[ -]?){12,18}\\d\` pattern must pass, which is what lets \`4111 1111 1111 1111\` be caught
  without matching every long number.
- **Indian formats are first-class**: \`PHONE_LANDLINE\` (3-4-4, e.g. \`080-2345-6789\`) and
  \`PHONE_MOBILE_55\` (5-5, e.g. \`98765 43210\`) exist in *both* the exact and lenient sets, because
  when only the lenient set knew the format the same number was found in an image but not in the
  DOM text of the same page — making the corroboration counts meaningless.
- \`CC_PREFIX\` only accepts a 1–3 digit country code when visibly marked with \`+\` or a separator;
  otherwise a 12-digit identifier gets re-read as \`1\` + \`234 5678 9012\`. \`NUM_START\` uses a
  lookbehind, not \`\\b\`, because there is no word boundary between a space and a \`+\`.
- **Cross-source merging.** When DOM and OCR flag the same value in the same region (overlap ratio
  > 0.3) the entries are **folded into one**, with \`sources\` recording both engines and DOM kept as
  the primary \`source\` because its text is exact and it carries a CSS selector. \`summarizePIIDetections\`
  then reports \`domFlagged\` / \`ocrFlagged\` (OCR-only) / \`ocrMatched\` (OCR contributed) /
  \`corroborated\` (both). The DevInspector reads \`sources\`, never the single \`source\`, when
  filtering — filtering on \`source === 'OCR'\` reported an empty column and made OCR look unused.
- \`normalizeValue\` strips non-alphanumerics and folds OCR-confusable letters (\`o/l→1\`, \`z→2\`,
  \`s→5\`, \`b→8\`, \`g→9\`, \`a→4\`, \`u→0\`) so the same value read two ways still merges.

---

## 7. Message routing reference

| Type | Handled by | Purpose |
|---|---|---|
| \`PING\` / \`PONG\` | background, content | Liveness probe |
| \`GET_TAB_CONTEXT\` | background (asks content), content answers | Title/URL/selection/meta/headings/800-char body snippet |
| \`TAB_CONTEXT_RESPONSE\` | side panel reads | — |
| \`EXTRACT_DOM\` | content | Elements + viewport + static PII text nodes (or a full audit if \`includeAudit\`) |
| \`GET_SCREEN_AND_DOM\` | background | **The full pipeline** — see §4 |
| \`CAPTURE_SCREENSHOT\` | background | Viewport PNG data URL only |
| \`OFFSCREEN_RUN_VISION\` | offscreen | BlazeFace + YOLOv8n inference |
| \`OFFSCREEN_SCAN_PII\` | offscreen | OCR + combined PII scan |
| \`SCAN_PII\` | background → re-dispatches as \`OFFSCREEN_SCAN_PII\` | Public entry to the PII stage |
| \`PROCESS_VISION\` | background | Reserved public entry to the vision stage |
| \`PROCESS_OFFSCREEN\` | background → offscreen | Legacy \`LocalPrivacyPipeline\` text sanitiser |
| \`EXECUTE_ACTION\` | background → content | \`SHOW_PRIVACY_TOAST\` / \`INSPECT_PAGE_PRIVACY\` |
| \`RENDER_DETECTION_OVERLAY\` | background → content | Draw vision/PII/OCR boxes on the live page |
| \`CLEAR_DETECTION_OVERLAY\` | background → content | Remove the overlay |

\`window.__KW_DEBUG__\` (content script) exposes \`audit()\`, \`highlight(ms)\`, \`clearHighlights()\`,
\`renderOverlay(payload)\`, \`clearOverlay()\` and \`getScreenAndDom()\` for DevTools use.

---

## 8. Overlay rendering and its legend

\`DETECTION_STYLE\` in \`content/index.ts\`:
\`face\` #FF2D78 (pink) · \`person\` #FFB020 (amber) · \`pii\` #E03131 (red) · \`ocr\` #0CA5E9 (cyan) ·
default #7048E8.

- PII boxes are **solid when corroborated by both engines** and **dashed when single-source**; the
  corroborated ones reuse the amber \`person\` colour so "both engines saw this" is visible on the
  page, not just in the panel.
- PII overlay labels show only the first 6 characters of the value — the overlay must not become a
  new source of leaked PII.
- \`MAX_OCR_BOXES = 300\`; beyond that a note reports "showing 300 of N".
- A colour legend is always drawn top-right with per-layer counts and the viewport size.
- **Escape** clears the overlay so it never blocks reading the page underneath.

---

## 9. Build pipeline (\`vite.config.ts\`)

Four Rollup inputs: \`sidepanel\`, \`offscreen\`, \`background\`, \`content\`.

Output naming is deliberate:
\`\`\`
background → src/background/index.js   (matches the manifest's service_worker)
content    → src/content/index.js      (matches content_scripts[0].js)
others     → assets/[name]-[hash].js
content CSS → src/content/styles.css
\`\`\`

The \`chrome-extension-builder\` plugin's \`closeBundle\` hook then:

1. Reads the root \`manifest.json\` and rewrites \`.ts\` → \`.js\` for
   \`background.service_worker\` and every \`content_scripts[].js\` entry, writing \`dist/manifest.json\`.
2. Copies \`src/content/styles.css\` → \`dist/src/content/styles.css\`.
3. Copies **every** \`.wasm\`/ \`.mjs\`/ \`.js\` from \`node_modules/onnxruntime-web/dist\` into **both**
   \`dist/assets/\` and \`dist/src/offscreen/\`. Two destinations exist because ORT resolves its
   runtime relative to whichever document is executing, and the offscreen chunk lives one directory
   deeper. This is the single largest source of build size (~120 MB).
4. Copies \`public/models/\` → \`dist/models/\`, creating an empty directory with a warning if
   \`npm run download-models\` was never run.

\`optimizeDeps.exclude: ['onnxruntime-web']\` and \`external: (id) => id.endsWith('.wasm')\` keep
Vite from trying to bundle binary WASM.

### Commands

\`\`\`bash
npm install                 # dependencies
npm run download-models     # fetch blazeface.onnx + yolov8n.onnx → public/models/
npm run build               # tsc && vite build  → dist/
npm run dev                 # vite dev server (side panel preview with mock fallbacks)
npm run memory              # regenerate this file
\`\`\`

Then: \`chrome://extensions\` → Developer mode → **Load unpacked** → select \`dist/\`.
Tabs opened before the extension was installed have no content script; refresh them.

---

## 10. Security and privacy properties

- \`host_permissions: ["<all_urls>"]\` — required for \`captureVisibleTab\` and DOM access.
- MV3 CSP: \`script-src 'self' 'wasm-unsafe-eval'; object-src 'self'\`. \`'wasm-unsafe-eval'\` is what
  permits ONNX Runtime to compile WASM; no remote code is ever allowed.
- Zero network egress at runtime. OCR assets, ONNX models and worker scripts are all bundled.
- Password input values are replaced with \`[PROTECTED]\` before they can enter any payload.
- Overlay PII labels truncate the value to 6 characters.
- On install, \`chrome.storage.local\` is seeded with \`privacyShieldEnabled: true\`,
  \`localModelActive: true\`, \`installedAt\`.
- \`chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })\` is set on install.
- Non-http(s) tabs are rejected with explicit errors rather than silently returning empty results.

---

## 11. Known constraints and sharp edges

1. **Build size.** The ORT WASM/JS copies are ~120 MB across \`dist/assets\` and
   \`dist/src/offscreen\`. This is intentional double-copying, not a bug.
2. **First pipeline run is slow.** ONNX sessions and the Tesseract worker both initialise lazily on
   the first request; the UI says so explicitly.
3. **Service worker sleep.** \`blazefaceSession\`/\`yolov8Session\`/\`ocrWorker\` live in offscreen or
   worker memory and are dropped when the document is torn down. \`resetSessions()\` and
   \`terminateOCRWorker()\` exist for explicit release.
4. **Faces are genuinely hard.** If a face is not reported, check the tile cap warning and
   \`visionMeta.statuses\` before assuming the page has no faces.
5. **Overlay needs the page not to be scrolled.** Boxes are viewport-fixed; a screenshot and an
   overlay from different scroll positions will not agree.
6. **\`eng.traineddata\` at the repo root is a stray 5.2 MB duplicate.** Safe to delete.
7. **\`extractTextFromCanvas\` is deprecated** — prefer \`runOCR\`, which also returns lines and metadata.
8. **The working tree was already dirty before this memory file existed.** \`dist/\` is committed to
   git, so build output shows up in diffs alongside source. Review carefully before committing.

---

## 12. File-by-file responsibilities

| File | Responsibility |
|---|---|
| \`manifest.json\` | MV3 manifest; TS entry points, permissions, CSP, web-accessible resources |
| \`vite.config.ts\` | 4 entry points, manifest rewriting, ORT asset duplication, model copying |
| \`package.json\` | Scripts and dependencies |
| \`tsconfig.json\` | Strict TS, \`noEmit\`, \`jsx: react-jsx\`, chrome types |
| \`tailwind.config.js\` | \`gemini-*\` palette, Inter stack, pulse-glow / gradient-flow |
| \`postcss.config.js\` | Tailwind + autoprefixer |
| \`scripts/download-models.mjs\` | Fetch ONNX checkpoints into \`public/models/\` |
| \`scripts/generate-project-memory.mjs\` | Regenerate this file |
| \`src/types/extension.ts\` | The shared type/message contract for all four surfaces |
| \`src/background/index.ts\` | IPC router, tab resolution, capture, offscreen lifecycle, fan-out |
| \`src/content/index.ts\` | Overlay injection/rendering, page context, \`__KW_DEBUG__\` |
| \`src/content/domExtractor.ts\` | Interactive-element extraction, labels, selectors, XPath, audit |
| \`src/content/styles.css\` | Privacy badge + toast styling |
| \`src/offscreen/index.ts\` | Offscreen router; \`LocalPrivacyPipeline\`; vision and PII handlers |
| \`src/offscreen/visionDetector.ts\` | BlazeFace + YOLOv8n inference, NMS, de-dup, per-model status |
| \`src/offscreen/ocrEngine.ts\` | Local Tesseract.js lifecycle, preprocessing, token/line extraction |
| \`src/offscreen/piiScanner.ts\` | Regex + lenient + heuristic PII detection, OCR line rebuild, merging |
| \`src/offscreen/tensorUtils.ts\` | Letterbox → NCHW tensor, inverse box mapping, canvas cache |
| \`src/offscreen/offscreen.html\` | Offscreen host page |
| \`src/sidepanel/sidepanel.html\` | Side-panel host page |
| \`src/sidepanel/main.tsx\` | React root + StrictMode + ErrorBoundary |
| \`src/sidepanel/App.tsx\` | Chat state, tab context, prompt routing, layout |
| \`src/sidepanel/index.css\` | Tailwind entry, scrollbar, gradient/shimmer helpers |
| \`src/sidepanel/components/Header.tsx\` | Brand, privacy pulse, inspector/refresh/clear |
| \`src/sidepanel/components/ChatThread.tsx\` | Messages, starter prompts, copy, redaction chips |
| \`src/sidepanel/components/InputBox.tsx\` | Auto-growing composer + active-tab pill |
| \`src/sidepanel/components/DevInspector.tsx\` | Six-tab pipeline inspector + on-page overlay control |
| \`src/sidepanel/components/ErrorBoundary.tsx\` | Render-error containment with reset |
| \`public/models/*.onnx\` | BlazeFace + YOLOv8n checkpoints |
| \`public/tesseract/**\` | Worker script, LSTM WASM cores, \`eng.traineddata\` |
| \`dist/**\` | Generated. Load unpacked from here. |

---

## 13. How to keep this file current

This document is generated. **Never hand-edit \`PROJECT_MEMORY.md\`** — the generator overwrites it.

\`\`\`bash
npm run memory          # or: node scripts/generate-project-memory.mjs
\`\`\`

Run it after **any** change to a file under \`src/\`, \`scripts/\`, \`public/\`, or to
\`manifest.json\` / \`vite.config.ts\` / \`package.json\` / \`tsconfig.json\` /
\`tailwind.config.js\` / \`postcss.config.js\`. The run appends an entry to the Change Log naming
exactly which files were added, modified or removed.

To add new *knowledge* (not just new content), edit the \`TEMPLATE\` constant in
\`scripts/generate-project-memory.mjs\` and re-run.

---

## 14. Change Log

Newest first. Each entry lists the files that differed from the previous generation.

<!-- CHANGELOG:BEGIN -->
<!-- CHANGELOG:END -->

---

## 15. Complete file inventory

Every file in the project (excluding \`.git/\` and \`node_modules/\`), with size, SHA-256 and role.
Rows marked **binary** or **generated** are catalogued rather than embedded — see §16.

<!-- INVENTORY:BEGIN -->
<!-- INVENTORY:END -->

---

## 16. Full source content

Verbatim content of every text file in the project. Binary assets and oversized bundles are
catalogued in §15 instead.

<!-- CONTENT:BEGIN -->
<!-- CONTENT:END -->

<!-- MANIFEST:BEGIN -->
<!-- MANIFEST:END -->
`;

// ─── Filesystem walk ──────────────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.') {
      // keep nothing hidden; the only hidden dir that matters (.git) is skipped anyway
      if (entry.isDirectory() && entry.name === '.git') continue;
    }
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function isBinaryPath(rel) {
  return BINARY_EXT.has(rel.slice(rel.lastIndexOf('.')).toLowerCase());
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** Pick a fence longer than any run of backticks present in `content`. */
function fenceFor(content) {
  let longest = 0;
  const runs = content.match(/`+/g) || [];
  for (const r of runs) longest = Math.max(longest, r.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

function gitInfo() {
  const run = (args) => {
    try {
      return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return '';
    }
  };
  const log = run(['log', '-1', '--pretty=%h|%s|%cI']);
  const [hash, subject, date] = log ? log.split('|') : [];
  return {
    hash: hash || 'unknown',
    subject: subject || 'no commits',
    date: date || 'unknown',
    branch: run(['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown',
    dirty: run(['status', '--porcelain']).length > 0,
  };
}

// ─── Read previous state ──────────────────────────────────────────────────────
/**
 * Extract the body between a marker pair, ignoring anything inside a fenced code block.
 *
 * This is load-bearing, not defensive. Section 16 embeds this very script verbatim, so the
 * literal marker strings appear a second time inside a fenced block. A plain indexOf would
 * pair section 14's real block with section 16's embedded copy and return nonsense — which
 * silently reduced the previous-state manifest to a single bogus entry and made every run
 * report the whole project as "added".
 */
function extractBlock(text, startMarker, endMarker) {
  const lines = text.split(/\r?\n/);
  let fence = null;
  let start = -1;
  const body = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = /^ {0,3}(`{3,})/.exec(line);

    if (fenceMatch) {
      const ticks = fenceMatch[1];
      if (fence === null) {
        fence = ticks;
      } else if (ticks.length >= fence.length && line.slice(fenceMatch.index + ticks.length).trim() === '') {
        fence = null;
      }
      continue;
    }

    // Only un-fenced lines can be real markers.
    if (fence !== null) continue;

    if (start === -1) {
      if (line.trim() === startMarker) start = i;
    } else if (line.trim() === endMarker) {
      return body.join('\n').trim();
    } else {
      body.push(line);
    }
  }

  return start === -1 ? '' : body.join('\n').trim();
}

let previousManifest = new Map();
let previousChangelog = [];

if (existsSync(OUT_FILE)) {
  const prev = readFileSync(OUT_FILE, 'utf8');
  const manifestBlock = extractBlock(prev, MARKER.manifestStart, MARKER.manifestEnd);
  for (const line of manifestBlock.split(/\r?\n/)) {
    // "<64-hex sha256>  <relative/path>" — split on the first run of two or more spaces so a
    // path containing spaces still round-trips.
    const m = /^([0-9a-f]{64})\s{2,}(\S.*)$/.exec(line.trim());
    if (!m) continue;
    // Key MUST be the path: the diff below looks up previousManifest by path.
    previousManifest.set(m[2].trim(), m[1].trim());
  }
  if (previousManifest.size === 0 && manifestBlock) {
    console.warn(`[memory] previous manifest had ${manifestBlock.split(/\r?\n/).length} line(s) but none parsed; treating this run as a baseline.`);
  }
  const clBlock = extractBlock(prev, MARKER.changelogStart, MARKER.changelogEnd);
  // Entries are re-joined on blank lines, so normalise each one: strip outer whitespace and
  // collapse 3+ blank lines to 2. Without this the list grows a blank line per regeneration.
  previousChangelog = clBlock
    ? clBlock
        .split(/\n(?=### )/)
        .map((entry) => entry.trim().replace(/\n{3,}/g, '\n\n'))
        .filter(Boolean)
    : [];
}

// ─── Build current state ──────────────────────────────────────────────────────
const files = walk(ROOT).filter((f) => resolve(f) !== OUT_FILE);
const records = [];

for (const abs of files) {
  const rel = relative(ROOT, abs).split(sep).join('/');
  const buf = readFileSync(abs);
  records.push({
    rel,
    abs,
    size: buf.length,
    hash: sha256(buf),
    buffer: buf,
    binary: isBinaryPath(rel),
  });
}

records.sort((a, b) => a.rel.localeCompare(b.rel));

const currentManifest = new Map(records.map((r) => [r.rel, r.hash]));

// ─── Diff against previous run ────────────────────────────────────────────────
const added = [];
const modified = [];
const removed = [];

for (const [rel, hash] of currentManifest) {
  if (!previousManifest.has(rel)) {
    added.push(rel);
  } else if (previousManifest.get(rel) !== hash) {
    modified.push(rel);
  }
}
for (const rel of previousManifest.keys()) {
  if (!currentManifest.has(rel)) removed.push(rel);
}

const hasPrevious = previousManifest.size > 0;
const changed = added.length + modified.length + removed.length > 0;

if (hasPrevious) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const lines = [`### ${now} — memory regenerated`, ''];
  lines.push(
    `${records.length} file(s) catalogued · ${added.length} added · ${modified.length} modified · ${removed.length} removed.`
  );
  const section = (title, files) => {
    if (!files.length) return;
    lines.push('', `**${title} (${files.length})**`, '', ...files.map((f) => `- \`${f}\``));
  };
  section('Added', added);
  section('Modified', modified);
  section('Removed', removed);
  if (!changed) lines.push('', '_No file content changed since the previous generation._');
  previousChangelog.unshift(lines.join('\n'));
  previousChangelog = previousChangelog.slice(0, MAX_CHANGELOG_ENTRIES);
} else {
  previousChangelog.unshift(
    '### Baseline — memory file created. Every project file catalogued and embedded below.'
  );
}

// ─── Inventory ────────────────────────────────────────────────────────────────
function purposeFor(rel, size, binary) {
  if (PATH_PURPOSE[rel]) return PATH_PURPOSE[rel];
  if (rel.startsWith('dist/')) return 'Generated build output. Committed to git.';
  if (rel.startsWith('public/')) return 'Static asset bundled into the extension.';
  if (rel.startsWith('src/')) return 'Application source.';
  if (rel.startsWith('scripts/')) return 'Build/dev tooling.';
  if (binary) return 'Binary asset.';
  return 'Project file.';
}

function dirPurposeFor(rel) {
  const parts = rel.split('/');
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join('/');
    if (DIR_PURPOSE[prefix]) return DIR_PURPOSE[prefix];
  }
  return null;
}

const inventoryRows = records.map((r) => {
  const embedded = !r.binary && r.size < INLINE_MAX_BYTES;
  const kind = r.binary ? 'binary' : embedded ? 'embedded' : 'generated';
  let purpose = purposeFor(r.rel, r.size, r.binary);
  if (purpose === 'Project file.') purpose = dirPurposeFor(r.rel) || purpose;
  return `| \`${r.rel}\` | ${humanSize(r.size)} | ${r.hash.slice(0, 16)} | ${kind} | ${purpose.replace(/\|/g, '\\|')} |`;
});

// ─── Content embedding ────────────────────────────────────────────────────────
const contentBlocks = [];
for (const r of records) {
  if (r.binary || r.size >= INLINE_MAX_BYTES) continue;
  const text = r.buffer.toString('utf8');
  const fence = fenceFor(text);
  let lang = '';
  if (r.rel.endsWith('.ts') || r.rel.endsWith('.tsx')) lang = 'ts';
  else if (r.rel.endsWith('.js') || r.rel.endsWith('.mjs')) lang = 'js';
  else if (r.rel.endsWith('.json')) lang = 'json';
  else if (r.rel.endsWith('.css')) lang = 'css';
  else if (r.rel.endsWith('.html')) lang = 'html';
  contentBlocks.push(
    `### \`${r.rel}\`\n\n${humanSize(r.size)} · sha256 \`${r.hash.slice(0, 16)}\` · ${r.rel.split('/').length - 1} level(s) deep\n\n${fence}${lang}\n${text}\n${fence}\n`
  );
}

const omitted = records.filter((r) => r.binary || r.size >= INLINE_MAX_BYTES);
const totalBytes = records.reduce((n, r) => n + r.size, 0);
const git = gitInfo();

// ─── Assemble ─────────────────────────────────────────────────────────────────
let doc = TEMPLATE;

/*
 * Substitute a marker pair's body.
 *
 * Returns the new document; every call passes a *function* replacement rather than a string,
 * because the embedded source contains `$&`, `` $` ``, `$'`, `$$` and `$1` inside regexes and
 * template literals (piiScanner.ts alone has `(?<![A-Za-z0-9])`, `${ANY_DIGIT_CLASS}` and `$1`).
 * In a string replacement those are substitution directives and whole sections vanish.
 */
function fill(doc, markerStart, markerEnd, body, label, minLines) {
  const needle = markerStart + '\n' + markerEnd;
  const at = doc.indexOf(needle);
  if (at === -1) {
    throw new Error(`[memory] template is missing the marker pair for ${label}`);
  }
  const next = doc.slice(0, at) + markerStart + '\n' + body + '\n' + markerEnd + doc.slice(at + needle.length);

  // Verify against the slice we just wrote rather than re-parsing the whole document: the
  // embedded script repeats every marker literal, so any later text search is ambiguous.
  const written = next.slice(at + markerStart.length + 1, at + markerStart.length + 1 + body.length);
  if (written !== body) {
    throw new Error(`[memory] ${label} body was not written verbatim`);
  }
  if (minLines && (body ? body.split(/\r?\n/).length : 0) < minLines) {
    throw new Error(`[memory] ${label} block holds ${body.split(/\r?\n/).length} line(s), expected >= ${minLines}`);
  }
  return next;
}

/*
 * ORDERING INVARIANT — the blocks must be filled bottom-up.
 *
 * Filling CONTENT inserts this script's own source into section 16, and that source contains
 * all four marker pairs verbatim (as string literals in MARKER and inside TEMPLATE). From then
 * on `indexOf(needle)` for any *earlier* block still resolves to its real occurrence, because
 * sections 14 and 15 physically precede section 16 — but a pair at or after the insertion point
 * becomes ambiguous and gets clobbered.
 *
 * Filling MANIFEST → CONTENT → INVENTORY → CHANGELOG therefore keeps exactly one unambiguous
 * first occurrence at every step. Filling top-down silently writes each body into the middle of
 * the embedded script, which is what this guard exists to prevent.
 */
doc = fill(doc, MARKER.manifestStart, MARKER.manifestEnd,
  records.map((r) => `${r.hash}  ${r.rel}`).join('\n'), 'MANIFEST', records.length);

doc = fill(doc, MARKER.contentStart, MARKER.contentEnd, [
  `**Embedded:** ${contentBlocks.length} file(s).`,
  '',
  `**Catalogued only (${omitted.length}):**`,
  '',
  ...omitted.map(
    (r) =>
      `- \`${r.rel}\` — ${humanSize(r.size)}, sha256 \`${r.hash.slice(0, 16)}\`, ` +
      `${r.binary ? 'binary asset' : `generated bundle above the ${humanSize(INLINE_MAX_BYTES)} inline cap`}`
  ),
  '',
  '---',
  '',
  ...contentBlocks,
].join('\n'), 'CONTENT', contentBlocks.length);

doc = fill(doc, MARKER.inventoryStart, MARKER.inventoryEnd, [
  `**Totals:** ${records.length} files · ${humanSize(totalBytes)} on disk · ` +
    `${contentBlocks.length} embedded verbatim · ${omitted.length} catalogued only.`,
  '',
  '| File | Size | SHA-256 | Kind | Role |',
  '|---|---|---|---|---|',
  ...inventoryRows,
].join('\n'), 'INVENTORY', records.length + 3);

doc = fill(doc, MARKER.changelogStart, MARKER.changelogEnd,
  previousChangelog.join('\n\n'), 'CHANGELOG');

const header = [
  '# PROJECT MEMORY — Keyboard Warriors',
  '',
  '> **This file is generated. Do not hand-edit it.**',
  '> Regenerate with `npm run memory` (`node scripts/generate-project-memory.mjs`).',
  '> To add knowledge, edit the `TEMPLATE` constant in that script and re-run.',
  '>',
  `> Generated: ${new Date().toISOString()}`,
  `> Repository: ${ROOT}`,
  `> Git: \`${git.hash}\` — ${git.subject} (branch \`${git.branch}\`, ${git.dirty ? 'dirty working tree' : 'clean'})`,
  '',
  '---',
  '',
].join('\n');

writeFileSync(OUT_FILE, header + doc, 'utf8');

console.log(`[memory] wrote ${relative(ROOT, OUT_FILE)}`);
console.log(`[memory] ${records.length} files catalogued, ${contentBlocks.length} embedded, ${omitted.length} catalogued only`);
console.log(`[memory] ${humanSize(totalBytes)} of project content · git ${git.hash}${git.dirty ? ' (dirty)' : ''}`);
console.log(`[memory] change log: +${added.length} ~${modified.length} -${removed.length}`);