import { createWorker, Worker, OEM, PSM } from 'tesseract.js';
import { loadImage } from './tensorUtils';
import type { BoundingBox, ExtractedOCRToken, ExtractedOCRLine, OCRMeta } from '../types/extension';

/**
 * OCR Engine for Keyboard Warriors
 *
 * Provides fully on-device optical character recognition via Tesseract.js running
 * inside the offscreen document.
 *
 * ── Why every runtime asset is resolved locally ─────────────────────────────
 * MV3 extension pages run under `script-src 'self'; object-src 'self'`. Tesseract.js
 * defaults to pulling three artifacts from public CDNs, all of which are blocked:
 *   • worker.min.js         → https://cdn.jsdelivr.net/npm/tesseract.js@…/worker.min.js
 *   • tesseract-core*.js    → https://cdn.jsdelivr.net/npm/tesseract.js-core@…
 *   • eng.traineddata       → https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/…
 * On top of that `workerBlobURL` defaults to `true`, which builds a `blob:` worker —
 * also rejected by the default `worker-src 'self'`. Every path below therefore points
 * at files shipped inside the extension bundle (see `public/tesseract/`).
 *
 * Note: `worker.recognize()` defaults its output to `{ text: true }` only, which leaves
 * `data.blocks` as `null`. Word-level bounding boxes require explicitly requesting
 * `{ text: true, blocks: true }`; without it the pipeline silently returns zero tokens.
 */

// ─── Asset locations (mirrored from public/tesseract/) ────────────────────────
const WORKER_ASSET = 'tesseract/worker.min.js';
const CORE_ASSET_DIR = 'tesseract/core';
const LANG_ASSET_DIR = 'tesseract/lang';

export interface OCRRunOptions {
  /** Regions (viewport coordinates) to crop and OCR individually. Omit for a full-frame pass. */
  croppedBBoxes?: BoundingBox[];
  /**
   * Explicit resampling factor, overriding the automatic choice. Leave undefined to
   * let the engine size each region so its longest edge meets `maxDimension`.
   */
  scale?: number;
  /** Target longest edge of the processed image, in pixels. */
  maxDimension?: number;
  /** Words below this confidence are dropped from the token list. */
  minConfidence?: number;
  onProgress?: (meta: OCRMeta) => void;
}

export interface OCRRunResult {
  tokens: ExtractedOCRToken[];
  lines: ExtractedOCRLine[];
  fullText: string;
  meta: OCRMeta;
}

// ─── Worker lifecycle ─────────────────────────────────────────────────────────

let ocrWorker: Worker | null = null;
let initPromise: Promise<Worker | null> | null = null;

let status: OCRMeta = createMeta('idle', 'OCR engine not started yet');

function createMeta(
  state: OCRMeta['status'],
  stage: string,
  patch: Partial<OCRMeta> = {}
): OCRMeta {
  return {
    status: state,
    stage,
    progress: 0,
    tokenCount: 0,
    lineCount: 0,
    fullText: '',
    meanConfidence: 0,
    durationMs: 0,
    scale: 1,
    engine: 'Tesseract.js v7 (WASM, LSTM)',
    assets: {
      worker: '',
      core: '',
      lang: '',
    },
    error: undefined,
    ...patch,
  };
}

function updateStatus(patch: Partial<OCRMeta>): OCRMeta {
  status = { ...status, ...patch };
  return status;
}

/** Current engine status, safe to call at any time. */
export function getOCRStatus(): OCRMeta {
  return status;
}

/**
 * Resolve a bundled asset to an absolute URL.
 * `chrome.runtime.getURL` is authoritative inside the extension; the relative form keeps
 * the Vite dev server working, since `public/` is served from the server root.
 */
function resolveAssetUrl(relativePath: string): string {
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    return chrome.runtime.getURL(relativePath);
  }
  return new URL(`../../${relativePath}`, document.baseURI).href;
}

/**
 * Verify the OCR worker script is reachable, so a missing file reports a precise error
 * instead of an opaque "Failed to construct Worker".
 *
 * Only the ~110 KB worker script is probed. The language model is ~5 MB and Tesseract
 * fetches it itself moments later, so a speculative GET here would download it twice;
 * its failures are instead caught and annotated in `describeWorkerError`.
 */
async function verifyAssets(): Promise<{ worker: string; core: string; lang: string }> {
  const worker = resolveAssetUrl(WORKER_ASSET);
  const core = resolveAssetUrl(CORE_ASSET_DIR);
  const lang = resolveAssetUrl(`${LANG_ASSET_DIR}/eng.traineddata`);

  const res = await fetch(worker);
  if (!res.ok) {
    throw new Error(
      `Tesseract worker script is unreachable at ${worker} (HTTP ${res.status}). ` +
        `Run "npm run build" and reload the extension so public/tesseract/ is copied to dist/.`
    );
  }

  return { worker, core, lang };
}

/**
 * Turn a raw Tesseract startup failure into an actionable message.
 * Tesseract reports asset problems as bare network errors, which are otherwise opaque.
 */
function describeWorkerError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const hint =
    'Run "npm run build" and reload the extension so public/tesseract/ is copied to dist/tesseract/.';

  if (/traineddata|language model|Network error while fetching/i.test(message)) {
    return `${message} (missing or unreadable language model — ${hint})`;
  }
  if (/importScripts|tesseract-core|worker/i.test(message)) {
    return `${message} (missing or unreadable Tesseract core/worker — ${hint})`;
  }
  return message;
}

/**
 * Lazily initialize and reuse a single Tesseract worker instance.
 * All options are pinned to bundled, local assets — no network access at any point.
 */
export async function getOCRWorker(): Promise<Worker | null> {
  if (ocrWorker) return ocrWorker;
  if (initPromise) return initPromise;

  updateStatus(createMeta('loading', 'Resolving local OCR assets', { progress: 0.05 }));

  initPromise = (async () => {
    try {
      const assets = await verifyAssets();
      updateStatus({
        stage: 'Starting Tesseract worker (WASM core + eng.traineddata)',
        progress: 0.2,
        assets,
      });

      const worker = await createWorker('eng', OEM.LSTM_ONLY, {
        workerPath: assets.worker,
        corePath: assets.core,
        langPath: assets.lang.replace(/\/eng\.traineddata$/, ''),
        // The bundled .traineddata is stored uncompressed.
        gzip: false,
        // A blob: worker is rejected by the MV3 default CSP (worker-src 'self').
        workerBlobURL: false,
        // Match the bundled LSTM-only core and language data.
        legacyCore: false,
        legacyLang: false,
        errorHandler: (err: unknown) => {
          console.error('[OCREngine] Worker error:', err);
          updateStatus({ status: 'error', stage: 'Worker error', error: String(err) });
        },
        logger: (m: { status?: string; progress?: number }) => {
          if (m?.status) {
            updateStatus({
              stage: m.status,
              progress: 0.2 + 0.3 * (m.progress ?? 0),
            });
          }
        },
      });

      ocrWorker = worker;
      updateStatus({
        status: 'ready',
        stage: 'Tesseract worker ready',
        progress: 0.5,
      });

      // Web pages are scattered, multi-column text rather than a single document block,
      // so SPARSE_TEXT segments far better than the AUTO default. Word-level boxes are
      // requested on every recognize() call below, since the default output is text only.
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SPARSE_TEXT,
        preserve_interword_spaces: '1',
      });

      console.log('[OCREngine] Worker ready using local assets', assets);
      return worker;
    } catch (err: any) {
      const message = describeWorkerError(err);
      console.error('[OCREngine Error] Failed to initialize Tesseract worker:', err);
      updateStatus(
        createMeta('error', 'OCR worker initialization failed', {
          error: message,
          durationMs: 0,
        })
      );
      return null;
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

// ─── Image preprocessing ──────────────────────────────────────────────────────

/**
 * Render a source region to a canvas, converting to grayscale and stretching
 * contrast between the 2nd and 98th luminance percentiles.
 *
 * Screenshots are dominated by flat UI backgrounds, so an untouched capture has a very
 * narrow luminance band and Tesseract binarizes it poorly. The percentile stretch maps
 * that band across the full 0–255 range before recognition.
 */
function preprocessRegion(
  source: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  targetWidth: number,
  targetHeight: number
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(targetWidth));
  canvas.height = Math.max(1, Math.round(targetHeight));

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Failed to acquire 2D context for OCR preprocessing');

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  const pixelCount = canvas.width * canvas.height;

  // Pass 1: luminance histogram (256 buckets) for percentile calculation.
  const histogram = new Uint32Array(256);
  const luminance = new Uint8ClampedArray(pixelCount);

  for (let i = 0; i < pixelCount; i++) {
    const o = i * 4;
    // Rec. 601 luma.
    const y = (data[o] * 299 + data[o + 1] * 587 + data[o + 2] * 114) / 1000;
    const v = y < 0 ? 0 : y > 255 ? 255 : y;
    luminance[i] = v;
    histogram[v | 0]++;
  }

  // Pass 2: resolve the 2nd/98th percentile cutoffs.
  const lowTarget = pixelCount * 0.02;
  const highTarget = pixelCount * 0.98;
  let cumulative = 0;
  let low = 0;
  let high = 255;
  let lowFound = false;

  for (let v = 0; v < 256; v++) {
    cumulative += histogram[v];
    if (!lowFound && cumulative >= lowTarget) {
      low = v;
      lowFound = true;
    }
    if (cumulative >= highTarget) {
      high = v;
      break;
    }
  }

  const range = Math.max(1, high - low);
  const scaleFactor = 255 / range;

  // Pass 3: write stretched grayscale back as neutral gray RGB.
  for (let i = 0; i < pixelCount; i++) {
    const o = i * 4;
    let v = (luminance[i] - low) * scaleFactor;
    if (v < 0) v = 0;
    else if (v > 255) v = 255;
    data[o] = v;
    data[o + 1] = v;
    data[o + 2] = v;
    data[o + 3] = 255;
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/** Hard ceiling on magnification, to bound cost when magnifying a tiny region. */
const MAX_SCALE = 4;
/** Hard floor on reduction, so a very large capture is not shrunk into illegibility. */
const MIN_SCALE = 0.5;

/**
 * Choose the resampling factor for a region.
 *
 * The goal is to land the region's longest edge on `maxDimension`, which is where
 * Tesseract's accuracy plateaus. This has to work in both directions:
 *
 *  • Small captures are magnified, because 16px body text has an ~8px x-height and
 *    Tesseract wants roughly 30px.
 *  • HiDPI captures are *reduced*. `captureVisibleTab` returns image pixels, so a
 *    1920px-wide viewport at devicePixelRatio 2 arrives as 3840px. Processing that at
 *    1:1 would triple the pixel count for no accuracy gain.
 *
 * `requested` overrides the calculation outright, for callers that need a specific factor.
 */
function chooseScale(width: number, height: number, requested: number, maxDimension: number): number {
  if (Number.isFinite(requested) && requested > 0) {
    return Math.max(MIN_SCALE, Math.min(requested, MAX_SCALE));
  }

  const longest = Math.max(width, height, 1);
  const fit = maxDimension / longest;
  return Math.max(MIN_SCALE, Math.min(fit, MAX_SCALE));
}

// ─── Result parsing ───────────────────────────────────────────────────────────

interface RawWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

interface RawLine {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number } | null;
  words: RawWord[];
}

/**
 * Flatten a Tesseract result into lines and words.
 * v7 only populates `data.blocks`; the legacy `data.words` field no longer exists.
 */
function parsePage(data: any): { lines: RawLine[]; words: RawWord[] } {
  const lines: RawLine[] = [];
  const words: RawWord[] = [];

  for (const block of data?.blocks ?? []) {
    for (const paragraph of block?.paragraphs ?? []) {
      for (const line of paragraph?.lines ?? []) {
        const lineWords: RawWord[] = (line?.words ?? []).filter(
          (w: RawWord) => typeof w?.text === 'string'
        );
        words.push(...lineWords);
        lines.push({
          text: (line?.text ?? lineWords.map((w) => w.text).join(' ')).trim(),
          confidence: line?.confidence ?? 0,
          bbox: line?.bbox ?? null,
          words: lineWords,
        });
      }
    }
  }

  return { lines, words };
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * runOCR
 *
 * Runs OCR over a captured screenshot and returns tokens with viewport-mapped
 * bounding boxes, the reconstructed text, and a status/meta record.
 *
 * @param screenshotUrl - Base64 PNG data URL from `chrome.tabs.captureVisibleTab`
 * @param viewport     - Current viewport metrics used to map image pixels to CSS pixels
 */
export async function runOCR(
  screenshotUrl: string,
  viewport?: { width: number; height: number },
  options: OCRRunOptions = {}
): Promise<OCRRunResult> {
  const startedAt = performance.now();
  const minConfidence = options.minConfidence ?? 30;
  const maxDimension = options.maxDimension ?? 2800;

  const empty = (patch: Partial<OCRMeta>): OCRRunResult => ({
    tokens: [],
    lines: [],
    fullText: '',
    meta: updateStatus(
      createMeta('error', patch.stage ?? 'OCR failed', {
        durationMs: Math.round(performance.now() - startedAt),
        error: patch.error ?? 'Unknown OCR failure',
        assets: status.assets,
      })
    ),
  });

  if (!screenshotUrl) {
    return empty({ stage: 'No screenshot supplied', error: 'screenshotUrl was empty' });
  }

  const worker = await getOCRWorker();
  if (!worker) {
    return empty({
      stage: 'OCR worker unavailable',
      error: status.error || 'Tesseract worker could not be initialized.',
    });
  }

  updateStatus(
    createMeta('running', 'Preprocessing screenshot', {
      progress: 0.55,
      assets: status.assets,
    })
  );
  options.onProgress?.(status);

  try {
    const img = await loadImage(screenshotUrl);
    const naturalWidth = img.naturalWidth || 1;
    const naturalHeight = img.naturalHeight || 1;

    const vpWidth = viewport?.width || naturalWidth;
    const vpHeight = viewport?.height || naturalHeight;

    // Image pixels → CSS viewport pixels.
    const vpScaleX = vpWidth / naturalWidth;
    const vpScaleY = vpHeight / naturalHeight;

    const scale = chooseScale(naturalWidth, naturalHeight, options.scale ?? 0, maxDimension);

    const tokens: ExtractedOCRToken[] = [];
    const lines: ExtractedOCRLine[] = [];
    const textChunks: string[] = [];

    /** OCR one prepared region and map its words back to viewport coordinates. */
    const recognizeRegion = async (
      canvas: HTMLCanvasElement,
      // Maps a pixel in the processed canvas to a viewport coordinate.
      project: (x: number, y: number) => { x: number; y: number },
      processedToViewportScale: { x: number; y: number },
      label: string
    ) => {
      const result = await worker.recognize(
        canvas,
        {},
        // `blocks: true` is mandatory — without it Tesseract returns no word geometry.
        { text: true, blocks: true }
      );

      const { lines: rawLines, words: rawWords } = parsePage(result.data);

      for (const rawLine of rawLines) {
        if (!rawLine.text) continue;
        textChunks.push(rawLine.text);

        if (rawLine.bbox) {
          const topLeft = project(rawLine.bbox.x0, rawLine.bbox.y0);
          const w = Math.round((rawLine.bbox.x1 - rawLine.bbox.x0) * processedToViewportScale.x);
          const h = Math.round((rawLine.bbox.y1 - rawLine.bbox.y0) * processedToViewportScale.y);
          lines.push({
            text: rawLine.text,
            confidence: Math.round(rawLine.confidence),
            bbox: {
              x: Math.round(topLeft.x),
              y: Math.round(topLeft.y),
              left: Math.round(topLeft.x),
              top: Math.round(topLeft.y),
              width: w,
              height: h,
              right: Math.round(topLeft.x) + w,
              bottom: Math.round(topLeft.y) + h,
            },
          });
        }
      }

      for (const word of rawWords) {
        const text = word.text?.trim();
        if (!text || word.confidence < minConfidence) continue;

        const left = Math.round(project(word.bbox.x0, word.bbox.y0).x);
        const top = Math.round(project(word.bbox.x0, word.bbox.y0).y);
        const width = Math.round((word.bbox.x1 - word.bbox.x0) * processedToViewportScale.x);
        const height = Math.round((word.bbox.y1 - word.bbox.y0) * processedToViewportScale.y);

        tokens.push({
          text,
          confidence: Math.round(word.confidence),
          bbox: {
            x: left,
            y: top,
            left,
            top,
            width,
            height,
            right: left + width,
            bottom: top + height,
          },
        });
      }

      console.debug(
        `[OCREngine] ${label}: ${rawWords.length} words, ${rawLines.length} lines ` +
          `(${(result.data.confidence ?? 0).toFixed(1)}% mean confidence)`
      );
      return result.data.confidence ?? 0;
    }

    let meanConfidence = 0;

    if (options.croppedBBoxes && options.croppedBBoxes.length > 0) {
      // Region-targeted pass: cap the crop count to keep latency predictable.
      const targets = options.croppedBBoxes.slice(0, 12);
      let processed = 0;

      for (const [index, crop] of targets.entries()) {
        if (crop.width < 12 || crop.height < 12) continue;

        const sx = Math.max(0, Math.min(naturalWidth - 1, crop.left / vpScaleX));
        const sy = Math.max(0, Math.min(naturalHeight - 1, crop.top / vpScaleY));
        const sw = Math.max(1, Math.min(naturalWidth - sx, crop.width / vpScaleX));
        const sh = Math.max(1, Math.min(naturalHeight - sy, crop.height / vpScaleY));

        // Crops are small regions, so the same rule (longest edge → maxDimension,
        // magnification capped) sizes them correctly without a special case.
        const cropScale = chooseScale(sw, sh, options.scale ?? 0, maxDimension);
        const canvas = preprocessRegion(
          img, sx, sy, sw, sh, sw * cropScale, sh * cropScale
        );

        try {
          meanConfidence += await recognizeRegion(
            canvas,
            (x, y) => ({
              x: crop.left + (x / cropScale) * vpScaleX,
              y: crop.top + (y / cropScale) * vpScaleY,
            }),
            { x: (1 / cropScale) * vpScaleX, y: (1 / cropScale) * vpScaleY },
            `crop ${index}`
          );
          processed++;
        } catch (cropErr) {
          console.warn('[OCREngine] Crop OCR failed:', cropErr);
        }
      }

      if (processed > 0) meanConfidence /= processed;
    } else {
      // Full-frame pass.
      updateStatus(
        createMeta('running', 'Recognizing text (full frame)', {
          progress: 0.7,
          scale,
          assets: status.assets,
        })
      );
      options.onProgress?.(status);

      const canvas = preprocessRegion(
        img, 0, 0, naturalWidth, naturalHeight,
        naturalWidth * scale, naturalHeight * scale
      );

      meanConfidence = await recognizeRegion(
        canvas,
        (x, y) => ({ x: x * vpScaleX / scale, y: y * vpScaleY / scale }),
        { x: vpScaleX / scale, y: vpScaleY / scale },
        'full-frame'
      );
    }

    const fullText = textChunks.join('\n');
    const durationMs = Math.round(performance.now() - startedAt);

    const meta = updateStatus(
      createMeta('done', `Extracted ${tokens.length} words in ${durationMs}ms`, {
        progress: 1,
        tokenCount: tokens.length,
        lineCount: lines.length,
        fullText,
        meanConfidence: Math.round(meanConfidence),
        durationMs,
        scale,
        assets: status.assets,
      })
    );

    console.groupCollapsed(`[OCREngine] ${meta.stage}`);
    console.log('Full text:\n', fullText || '(empty)');
    if (tokens.length) {
      console.table(
        tokens.slice(0, 50).map((t, i) => ({
          '#': i + 1,
          Text: t.text,
          Confidence: `${t.confidence}%`,
          'BBox (x,y,w,h)': `[${t.bbox.x}, ${t.bbox.y}, ${t.bbox.width}x${t.bbox.height}]`,
        }))
      );
      if (tokens.length > 50) console.log(`… and ${tokens.length - 50} more tokens`);
    }
    console.groupEnd();

    return { tokens, lines, fullText, meta };
  } catch (err: any) {
    console.error('[OCREngine Error] Text extraction failed:', err);
    return empty({
      stage: 'OCR runtime failure',
      error: err?.message || String(err),
    });
  }
}

/**
 * Backwards-compatible wrapper returning only tokens.
 * @deprecated Prefer `runOCR`, which also returns reconstructed text and status metadata.
 */
export async function extractTextFromCanvas(
  screenshotUrl: string,
  croppedBBoxes?: BoundingBox[],
  viewport?: { width: number; height: number }
): Promise<ExtractedOCRToken[]> {
  const { tokens } = await runOCR(screenshotUrl, viewport, { croppedBBoxes });
  return tokens;
}

/**
 * Terminate the OCR worker to release its WASM heap and worker thread.
 */
export async function terminateOCRWorker(): Promise<void> {
  if (ocrWorker) {
    try {
      await ocrWorker.terminate();
    } catch (e) {
      console.warn('[OCREngine] Termination error:', e);
    }
    ocrWorker = null;
  }
  updateStatus(createMeta('idle', 'OCR engine terminated'));
}
