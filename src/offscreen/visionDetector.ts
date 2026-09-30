import * as ort from 'onnxruntime-web';
import {
  loadImage,
  buildVisionTensor,
  mapNormalizedBox,
  clampSourceRect,
  type SourceRect,
  type LetterboxInfo,
} from './tensorUtils';
import type {
  BoundingBox,
  VisionDetection,
  VisionModelStatus,
  ExtractedElement,
} from '../types/extension';

// ─── 4. WASM & Execution Provider Setup ───────────────────────────────────────
// Set ONNX WASM asset path explicitly as required
ort.env.wasm.wasmPaths = './';
// Extension pages are not cross-origin isolated, so SharedArrayBuffer is unavailable.
// Without this ORT attempts threaded WASM, fails to isolate, and falls back mid-session.
ort.env.wasm.numThreads = 1;

// ─── Model Configuration ─────────────────────────────────────────────────────
const BLAZEFACE_MODEL_URL = chrome.runtime.getURL('models/blazeface.onnx');
const BLAZEFACE_INPUT_SIZE = 128;
const BLAZEFACE_CONF_THRESHOLD = 0.5;
const BLAZEFACE_IOU_THRESHOLD = 0.3;
const BLAZEFACE_MAX_DETECTIONS = 20n;
const BLAZEFACE_NMS_IOU = 0.4;

/**
 * `selectedBoxes` rows are 16 floats wide:
 *   [0..3]  ymin, xmin, ymax, xmax   (normalized to the model input)
 *   [4..13] 5 facial keypoints × 2
 *   [14]    unused
 *   [15]    detection score
 * The score used to be hard-coded, which made every face look equally certain and made
 * a threshold on the reported confidence meaningless.
 */
const BLAZEFACE_SCORE_OFFSET = 15;
const BLAZEFACE_BOX_STRIDE = 16;

const YOLOV8_MODEL_URL = chrome.runtime.getURL('models/yolov8n.onnx');
const YOLOV8_INPUT_SIZE = 640;
const YOLOV8_CONF_THRESHOLD = 0.25; // Confidence score > 0.25
const YOLOV8_IOU_THRESHOLD = 0.45;

/**
 * YOLOv8 Class Index mapping (COCO-80 ordering):
 * - Map class index 0 ('person') to label 'person'
 * - Map other common UI/document categories to respective labels
 */
const YOLOV8_CLASS_MAP: Record<number, VisionDetection['label']> = {
  0: 'person',      // Requirement: class 0 is person
  24: 'ui_element', // backpack
  26: 'ui_element', // handbag
  28: 'ui_element', // suitcase
  56: 'ui_element', // chair
  57: 'ui_element', // couch
  62: 'ui_element', // tv / monitor
  63: 'ui_element', // laptop
  64: 'ui_element', // mouse
  65: 'ui_element', // remote
  66: 'ui_element', // keyboard
  67: 'ui_element', // cell phone
  73: 'document',   // book
  74: 'ui_element', // clock
  76: 'card',       // scissors / card
  77: 'ui_element', // teddy bear
};

/**
 * Sliding-tile geometry for the full-frame face pass.
 *
 * BlazeFace is a short-range detector: it expects a face to occupy a meaningful share of
 * a 128×128 input. A 1920×1080 screenshot squashed into that input shrinks a 40px avatar
 * to ~3px, which is why a single full-frame pass reports almost nothing. Tiling keeps each
 * face at a workable scale; overlapping tiles keep faces on a seam from being cut in half.
 */
const FACE_TILE_PX = 384;
const FACE_TILE_OVERLAP = 0.25;
const FACE_TILE_MAX = 24;
/** Below this the box is a texture artifact rather than a face. */
const FACE_MIN_PX = 10;

// ─── Session Cache ────────────────────────────────────────────────────────────
let blazefaceSession: ort.InferenceSession | null = null;
let yolov8Session: ort.InferenceSession | null = null;
let sessionsInitialized = false;
let initializationError: string | null = null;
let blazefaceError: string | undefined;
let yolov8Error: string | undefined;

/**
 * Create an InferenceSession attempting WebGPU first, then falling back to WASM
 */
async function createSessionWithFallback(modelUrl: string): Promise<ort.InferenceSession | null> {
  // Try WebGPU first
  try {
    const session = await ort.InferenceSession.create(modelUrl, {
      executionProviders: ['webgpu', 'wasm'],
      graphOptimizationLevel: 'all',
      executionMode: 'sequential',
    });
    console.log(`[VisionDetector] Loaded session with WebGPU/WASM for ${modelUrl}`);
    return session;
  } catch (webgpuErr: any) {
    console.warn(`[VisionDetector] WebGPU session creation failed for ${modelUrl}, falling back to WASM:`, webgpuErr?.message || webgpuErr);
    try {
      const session = await ort.InferenceSession.create(modelUrl, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
        executionMode: 'sequential',
      });
      console.log(`[VisionDetector] Loaded session with WASM fallback for ${modelUrl}`);
      return session;
    } catch (wasmErr: any) {
      console.error('[Offscreen Vision Error] Both WebGPU and WASM session creation failed for', modelUrl, wasmErr);
      return null;
    }
  }
}

/**
 * Load both ONNX sessions once. Subsequent calls are no-ops.
 *
 * Each model's failure is recorded separately: a missing YOLO checkpoint must not hide a
 * working BlazeFace, and neither failure should surface as a silently empty result.
 */
async function initializeSessions(): Promise<void> {
  if (sessionsInitialized) return;
  if (initializationError) throw new Error(initializationError);

  console.log('[VisionDetector] Initializing ONNX vision sessions...');
  const [bfSession, y8Session] = await Promise.all([
    createSessionWithFallback(BLAZEFACE_MODEL_URL).catch((err) => {
      blazefaceError = err?.message || String(err);
      return null;
    }),
    createSessionWithFallback(YOLOV8_MODEL_URL).catch((err) => {
      yolov8Error = err?.message || String(err);
      return null;
    })
  ]);

  blazefaceSession = bfSession;
  yolov8Session = y8Session;
  sessionsInitialized = true;

  if (!blazefaceSession && !yolov8Session) {
    blazefaceError = blazefaceError
      ?? 'BlazeFace model failed to load. Verify dist/models/blazeface.onnx exists.';
    yolov8Error = yolov8Error
      ?? 'YOLOv8n model failed to load. Verify dist/models/yolov8n.onnx exists.';
    initializationError = 'Both ONNX models failed to load. Please verify models exist in dist/models/';
    throw new Error(initializationError);
  }
}

// ─── Bounding Box Helpers & NMS ───────────────────────────────────────────────

/** Build the canonical `BoundingBox` from a CSS-pixel rect, clamped to the viewport. */
function toViewportBox(
  rect: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number }
): BoundingBox {
  const left = Math.max(0, Math.min(viewport.width, Math.round(rect.x)));
  const top = Math.max(0, Math.min(viewport.height, Math.round(rect.y)));
  const right = Math.max(0, Math.min(viewport.width, Math.round(rect.x + rect.width)));
  const bottom = Math.max(0, Math.min(viewport.height, Math.round(rect.y + rect.height)));

  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);

  return { x: left, y: top, left, top, width, height, right, bottom };
}

function iou(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): number {
  const ax2 = a.x + a.width;
  const ay2 = a.y + a.height;
  const bx2 = b.x + b.width;
  const by2 = b.y + b.height;

  const interX1 = Math.max(a.x, b.x);
  const interY1 = Math.max(a.y, b.y);
  const interX2 = Math.min(ax2, bx2);
  const interY2 = Math.min(ay2, by2);

  if (interX2 <= interX1 || interY2 <= interY1) return 0;

  const intersection = (interX2 - interX1) * (interY2 - interY1);
  const aArea = a.width * a.height;
  const bArea = b.width * b.height;
  return intersection / (aArea + bArea - intersection);
}

interface RawBox {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
  classIdx: number;
  label: VisionDetection['label'];
}

function applyNMS(boxes: RawBox[], iouThreshold: number): RawBox[] {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const kept: RawBox[] = [];

  for (const candidate of sorted) {
    const suppressed = kept.some(
      (existing) => existing.classIdx === candidate.classIdx && iou(existing, candidate) > iouThreshold
    );
    if (!suppressed) {
      kept.push(candidate);
    }
  }

  return kept;
}

function deduplicateDetections(detections: VisionDetection[], iouThreshold: number): VisionDetection[] {
  const sorted = [...detections].sort((a, b) => b.confidence - a.confidence);
  const kept: VisionDetection[] = [];

  for (const candidate of sorted) {
    const suppressed = kept.some(
      (existing) => existing.label === candidate.label && iou(existing.bbox, candidate.bbox) > iouThreshold
    );
    if (!suppressed) {
      kept.push(candidate);
    }
  }

  return kept;
}

/** Tile offsets along one axis, guaranteeing the far edge is covered. */
function axisPositions(total: number, tile: number, step: number): number[] {
  if (total <= tile) return [0];

  const positions: number[] = [];
  for (let pos = 0; pos + tile < total; pos += step) {
    positions.push(pos);
  }
  positions.push(total - tile);
  return [...new Set(positions)];
}

/** Overlapping tiles covering the whole frame, capped for predictable latency. */
function buildTileRegions(
  width: number,
  height: number,
  tile: number,
  overlap: number
): SourceRect[] {
  const step = Math.max(1, Math.round(tile * (1 - overlap)));
  const regions: SourceRect[] = [];

  for (const y of axisPositions(height, tile, step)) {
    for (const x of axisPositions(width, tile, step)) {
      regions.push({
        x,
        y,
        width: Math.min(tile, width),
        height: Math.min(tile, height),
      });
      if (regions.length >= FACE_TILE_MAX) return regions;
    }
  }

  return regions;
}

// ─── BlazeFace Inference ──────────────────────────────────────────────────────

interface BlazeFaceRawResult {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  score: number;
}

/**
 * Run BlazeFace on a single 128x128 Float32Array tensor.
 * garavv/blazeface-onnx requires 4 input tensors:
 *   - image: Float32Tensor [1, 3, 128, 128]
 *   - conf_threshold: Float32Tensor [0.5]
 *   - max_detections: Int64Tensor [20]
 *   - iou_threshold: Float32Tensor [0.3]
 *
 * The graph performs NMS internally, so every returned row is already above
 * `conf_threshold`; the only work left is unpacking and validating the geometry.
 */
async function runBlazeFaceOnTensor(
  tensorData: Float32Array
): Promise<BlazeFaceRawResult[]> {
  if (!blazefaceSession) return [];

  try {
    const imageTensor = new ort.Tensor('float32', tensorData, [1, 3, BLAZEFACE_INPUT_SIZE, BLAZEFACE_INPUT_SIZE]);
    const confTensor = new ort.Tensor('float32', new Float32Array([BLAZEFACE_CONF_THRESHOLD]), [1]);
    const maxDetTensor = new ort.Tensor('int64', new BigInt64Array([BLAZEFACE_MAX_DETECTIONS]), [1]);
    const iouTensor = new ort.Tensor('float32', new Float32Array([BLAZEFACE_IOU_THRESHOLD]), [1]);

    const results = await blazefaceSession.run({
      image: imageTensor,
      conf_threshold: confTensor,
      max_detections: maxDetTensor,
      iou_threshold: iouTensor,
    });

    const output = results['selectedBoxes'];
    if (!output || !output.data) return [];

    const data = output.data as Float32Array;
    const dims = output.dims;
    // `selectedBoxes` is [1, N, 16]; tolerate a transposed export by reading the last dim.
    const numDetections = dims[dims.length - 2] || 0;
    const rowLength = dims[dims.length - 1] || BLAZEFACE_BOX_STRIDE;
    const detected: BlazeFaceRawResult[] = [];

    for (let i = 0; i < numDetections; i++) {
      const offset = i * rowLength;
      const ymin = data[offset];
      const xmin = data[offset + 1];
      const ymax = data[offset + 2];
      const xmax = data[offset + 3];
      const score = data[offset + BLAZEFACE_SCORE_OFFSET];

      if (!Number.isFinite(ymin) || !Number.isFinite(xmin) || !Number.isFinite(ymax) || !Number.isFinite(xmax)) {
        continue;
      }

      // Unused rows are zero-padded; a positive score is the only reliable membership test.
      const hasScore = Number.isFinite(score) && score > 0;
      if (!hasScore) continue;
      if (xmax <= xmin || ymax <= ymin) continue;
      if (score < BLAZEFACE_CONF_THRESHOLD) continue;

      detected.push({
        xmin: Math.max(0, Math.min(1, xmin)),
        ymin: Math.max(0, Math.min(1, ymin)),
        xmax: Math.max(0, Math.min(1, xmax)),
        ymax: Math.max(0, Math.min(1, ymax)),
        score: Math.round(score * 1000) / 1000,
      });
    }

    return detected;
  } catch (err: any) {
    const message = err?.message || String(err);
    console.error('[Offscreen Vision Error] BlazeFace inference failed:', err);
    blazefaceError = message;
    return [];
  }
}

/**
 * Run BlazeFace over one region of the screenshot and return faces in CSS viewport pixels.
 *
 * `region` is expressed in image pixels; `imageToViewport` converts back to the CSS pixel
 * space that the DOM, OCR and overlay layers all use.
 */
async function detectFacesInRegion(
  img: HTMLImageElement,
  region: SourceRect,
  viewport: { width: number; height: number },
  imageToViewport: { x: number; y: number },
  label: string
): Promise<VisionDetection[]> {
  if (!blazefaceSession) return [];

  const { tensor, letterbox } = buildVisionTensor(img, region, BLAZEFACE_INPUT_SIZE);
  const rawFaces = await runBlazeFaceOnTensor(tensor);
  const detections: VisionDetection[] = [];

  for (const face of rawFaces) {
    const mapped = mapNormalizedBox(
      { x0: face.xmin, y0: face.ymin, x1: face.xmax, y1: face.ymax },
      letterbox
    );
    if (!mapped) continue;

    // Image pixels → CSS viewport pixels.
    const viewportRect = {
      x: mapped.x * imageToViewport.x,
      y: mapped.y * imageToViewport.y,
      width: mapped.width * imageToViewport.x,
      height: mapped.height * imageToViewport.y,
    };

    if (viewportRect.width < FACE_MIN_PX || viewportRect.height < FACE_MIN_PX) continue;

    detections.push({
      label: 'face',
      confidence: face.score,
      bbox: toViewportBox(viewportRect, viewport),
      source: 'BlazeFace',
    });
  }

  if (detections.length > 0) {
    console.debug(
      `[VisionDetector] ${label}: ${detections.length} face(s) ` +
        `in [${region.width}×${region.height}] @ ${region.x},${region.y}`
    );
  }

  return detections;
}

/**
 * Run BlazeFace with DOM-guided smart cropping, a tiled full-frame sweep, and a whole-frame
 * pass, then merge the results with NMS.
 */
async function runBlazeFaceDetection(
  img: HTMLImageElement,
  viewport: { width: number; height: number },
  extractedElements: ExtractedElement[] = []
): Promise<VisionDetection[]> {
  if (!blazefaceSession) return [];

  const detections: VisionDetection[] = [];

  // Image pixels per CSS pixel. `captureVisibleTab` returns device pixels, so this is
  // devicePixelRatio on a normal display and the value stays 1 in the letterbox maths.
  const scaleX = (img.naturalWidth || viewport.width) / viewport.width;
  const scaleY = (img.naturalHeight || viewport.height) / viewport.height;
  const imageToViewport = { x: 1 / (scaleX || 1), y: 1 / (scaleY || 1) };

  // 1. DOM-guided candidate regions: avatars, profile pictures, thumbnails and other small
  //    image-like elements. Highest precision source, and it is essentially free.
  const candidateElements = extractedElements.filter((el) => {
    const isImg = el.tagName === 'IMG' || el.tagName === 'PICTURE' || el.role === 'img';
    const hasAvatarHint = /avatar|profile|user|author|thumb|photo|portrait|picture/i.test(
      `${el.id} ${el.selector} ${el.attributes['class'] || ''} ${el.attributes['alt'] || ''} ${el.attributes['src'] || ''}`
    );
    const isSmallElement = el.bbox.width <= 300 && el.bbox.height <= 300 && el.bbox.width >= 16 && el.bbox.height >= 16;

    return (isImg || hasAvatarHint || isSmallElement) && el.bbox.width > 0 && el.bbox.height > 0;
  }).slice(0, 15); // Process up to 15 candidates for fast execution

  for (const el of candidateElements) {
    try {
      const region = clampSourceRect(img, {
        x: el.bbox.left * scaleX,
        y: el.bbox.top * scaleY,
        width: el.bbox.width * scaleX,
        height: el.bbox.height * scaleY,
      });

      if (region.width < BLAZEFACE_INPUT_SIZE / 8 || region.height < BLAZEFACE_INPUT_SIZE / 8) continue;

      detections.push(
        ...(await detectFacesInRegion(img, region, viewport, imageToViewport, `element ${el.tagName}#${el.id || '?'}`))
      );
    } catch (cropErr: any) {
      console.error('[Offscreen Vision Error] Failed processing cropped face candidate:', cropErr);
    }
  }

  // 2. Tiled sweep. This is what finds faces that have no IMG ancestor at all — canvas
  //    avatars, video-call tiles, background-image faces, and faces inside larger pictures.
  const tiles = buildTileRegions(img.naturalWidth, img.naturalHeight, FACE_TILE_PX, FACE_TILE_OVERLAP);
  if (tiles.length >= FACE_TILE_MAX) {
    console.warn(
      `[VisionDetector] Tiled face pass truncated to ${FACE_TILE_MAX} tiles of a ` +
        `${img.naturalWidth}×${img.naturalHeight} capture.`
    );
  }

  for (const [index, tile] of tiles.entries()) {
    try {
      detections.push(...(await detectFacesInRegion(img, tile, viewport, imageToViewport, `tile ${index + 1}/${tiles.length}`)));
    } catch (tileErr: any) {
      console.error('[Offscreen Vision Error] Tiled face inference failed:', tileErr);
    }
  }

  // 3. Whole-frame pass, kept for faces small enough to survive the downscale.
  try {
    detections.push(
      ...(await detectFacesInRegion(
        img,
        { x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight },
        viewport,
        imageToViewport,
        'full-frame'
      ))
    );
  } catch (fullFrameErr: any) {
    console.error('[Offscreen Vision Error] Full-frame BlazeFace inference error:', fullFrameErr);
  }

  // 4. Deduplicate overlapping face boxes across every pass.
  return deduplicateDetections(detections, BLAZEFACE_NMS_IOU);
}

// ─── YOLOv8n Inference ────────────────────────────────────────────────────────

/**
 * Run YOLOv8n general object detection on a 640x640 letterboxed input.
 * Output tensor shape: [1, 84, 8400]
 * - Map class index 0 ('person') to label 'person'
 * - Filter confidence score > 0.25
 */
async function runYolov8n(
  img: HTMLImageElement,
  viewport: { width: number; height: number }
): Promise<VisionDetection[]> {
  if (!yolov8Session) return [];

  try {
    const { tensor, letterbox } = buildVisionTensor(
      img,
      { x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight },
      YOLOV8_INPUT_SIZE
    );
    const inputName = yolov8Session.inputNames[0] || 'images';
    const inputTensor = new ort.Tensor('float32', tensor, [1, 3, YOLOV8_INPUT_SIZE, YOLOV8_INPUT_SIZE]);

    const results = await yolov8Session.run({ [inputName]: inputTensor });
    const outputName = yolov8Session.outputNames[0] || 'output0';
    const output = results[outputName];

    if (!output || !output.data) return [];

    const data = output.data as Float32Array;
    const dims = output.dims; // [1, 84, 8400]
    const numAnchors = dims[2] || 8400;
    const numFeatures = dims[1] || 84;
    const numClasses = numFeatures - 4;

    // Model pixels per image pixel, so boxes can be reported in CSS viewport pixels.
    const pxToViewportX = 1 / ((img.naturalWidth || viewport.width) / viewport.width);
    const pxToViewportY = 1 / ((img.naturalHeight || viewport.height) / viewport.height);

    const rawBoxes: RawBox[] = [];

    for (let a = 0; a < numAnchors; a++) {
      let maxScore = 0;
      let maxClassIdx = -1;

      for (let c = 0; c < numClasses; c++) {
        const score = data[(4 + c) * numAnchors + a];
        if (score > maxScore) {
          maxScore = score;
          maxClassIdx = c;
        }
      }

      // Requirement: confidence score > 0.25
      if (maxScore <= YOLOV8_CONF_THRESHOLD) continue;

      let label: VisionDetection['label'] | null = null;
      if (maxClassIdx === 0) {
        label = 'person'; // Requirement: Map class index 0 (person) to label 'person'
      } else if (maxClassIdx in YOLOV8_CLASS_MAP) {
        label = YOLOV8_CLASS_MAP[maxClassIdx];
      } else if (maxScore > 0.35) {
        label = 'ui_element';
      }

      if (!label) continue;

      const cx = data[0 * numAnchors + a];
      const cy = data[1 * numAnchors + a];
      const w  = data[2 * numAnchors + a];
      const h  = data[3 * numAnchors + a];

      // Boxes are in model pixels; undo the letterbox to get image pixels.
      const mapped = mapNormalizedBox(
        { x0: (cx - w / 2) / YOLOV8_INPUT_SIZE, y0: (cy - h / 2) / YOLOV8_INPUT_SIZE, x1: (cx + w / 2) / YOLOV8_INPUT_SIZE, y1: (cy + h / 2) / YOLOV8_INPUT_SIZE },
        letterbox
      );
      if (!mapped) continue;

      rawBoxes.push({
        x: mapped.x,
        y: mapped.y,
        width: mapped.width,
        height: mapped.height,
        score: maxScore,
        classIdx: maxClassIdx,
        label,
      });
    }

    const kept = applyNMS(rawBoxes, YOLOV8_IOU_THRESHOLD);
    const detections: VisionDetection[] = [];

    for (const box of kept) {
      detections.push({
        label: box.label,
        confidence: Math.round(box.score * 1000) / 1000,
        bbox: toViewportBox(
          {
            x: box.x * pxToViewportX,
            y: box.y * pxToViewportY,
            width: box.width * pxToViewportX,
            height: box.height * pxToViewportY,
          },
          viewport
        ),
        source: 'YOLOv8',
      });
    }

    return detections.filter((d) => d.bbox.width > 0 && d.bbox.height > 0);
  } catch (err: any) {
    const message = err?.message || String(err);
    console.error('[Offscreen Vision Error] YOLOv8n inference failed:', err);
    yolov8Error = message;
    return [];
  }
}

// ─── Public Inference Entry ───────────────────────────────────────────────────

export interface RunInferenceResult {
  detections: VisionDetection[];
  modelsUsed: string[];
  statuses: VisionModelStatus[];
  faceCount: number;
  objectCount: number;
  processingTimeMs: number;
  error?: string;
}

/**
 * runInference
 *
 * Runs BlazeFace (DOM-guided crops + tiled sweep + full frame) and YOLOv8n on a viewport
 * screenshot, applies NMS, and returns combined vision detections in CSS viewport pixels —
 * the same coordinate space the DOM extractor and the OCR pass report, so all three layers
 * can be overlaid and de-duplicated against each other.
 */
export async function runInference(
  screenshotUrl: string,
  viewport: { width: number; height: number; devicePixelRatio: number },
  extractedElements: ExtractedElement[] = []
): Promise<RunInferenceResult> {
  const startTime = performance.now();
  const modelsUsed: string[] = [];

  try {
    await initializeSessions();

    const img = await loadImage(screenshotUrl);

    // Concurrently run BlazeFace and YOLOv8n
    const [faceDetections, objectDetections] = await Promise.all([
      blazefaceSession
        ? runBlazeFaceDetection(img, viewport, extractedElements)
        : Promise.resolve([] as VisionDetection[]),
      yolov8Session
        ? runYolov8n(img, viewport)
        : Promise.resolve([] as VisionDetection[])
    ]);

    if (blazefaceSession) modelsUsed.push('BlazeFace');
    if (yolov8Session)    modelsUsed.push('YOLOv8n');

    const allDetections = [...faceDetections, ...objectDetections];

    const statuses: VisionModelStatus[] = [
      {
        model: 'BlazeFace',
        loaded: !!blazefaceSession,
        error: blazefaceSession ? blazefaceError : (blazefaceError ?? 'Model not loaded'),
      },
      {
        model: 'YOLOv8n',
        loaded: !!yolov8Session,
        error: yolov8Session ? yolov8Error : (yolov8Error ?? 'Model not loaded'),
      },
    ];

    const processingTimeMs = Math.round(performance.now() - startTime);

    console.log(
      `[VisionDetector] Inference complete: ${allDetections.length} detections ` +
        `(${faceDetections.length} faces, ${objectDetections.length} objects/persons) ` +
        `in ${processingTimeMs}ms`
    );

    return {
      detections: allDetections,
      modelsUsed,
      statuses,
      faceCount: faceDetections.length,
      objectCount: objectDetections.length,
      processingTimeMs,
    };
  } catch (err: any) {
    const message = err?.message || String(err);
    console.error('[Offscreen Vision Error] runInference error:', err);
    return {
      detections: [],
      modelsUsed,
      statuses: [
        { model: 'BlazeFace', loaded: !!blazefaceSession, error: blazefaceError },
        { model: 'YOLOv8n', loaded: !!yolov8Session, error: yolov8Error },
      ],
      faceCount: 0,
      objectCount: 0,
      processingTimeMs: Math.round(performance.now() - startTime),
      error: message,
    };
  }
}

/**
 * Reset cached ONNX sessions (useful for memory management)
 */
export function resetSessions(): void {
  blazefaceSession = null;
  yolov8Session = null;
  sessionsInitialized = false;
  initializationError = null;
  blazefaceError = undefined;
  yolov8Error = undefined;
}
