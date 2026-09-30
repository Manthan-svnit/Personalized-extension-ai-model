/**
 * Tensor Preprocessing Utilities for Keyboard Warriors Vision Pipeline
 * Renders screenshots or cropped sub-rectangles onto offscreen <canvas> elements
 * and converts them into normalized NCHW Float32Array tensors compatible with ONNX models.
 *
 * ── Why letterboxing, not stretching ─────────────────────────────────────────
 * Both bundled models take a square input (`images`: 1×3×640×640 for YOLOv8n,
 * `image`: 1×3×128×128 for BlazeFace) and both were trained on *aspect-preserving*
 * letterboxed images. Drawing a 1920×1080 screenshot straight into a 640×640 canvas
 * compresses the horizontal axis by ~3×, so every object reaches the network with the
 * wrong aspect ratio and the wrong relative scale — the dominant cause of "the face is
 * reported but the box does not sit on the face".
 *
 * `buildVisionTensor` therefore scales the region by a single uniform factor and centres
 * it on a padded square, then hands back the geometry needed to invert the mapping:
 *
 *     model px  = (source px - source.origin) * scale + pad
 *     source px  = (model px - pad) / scale + source.origin
 *
 * Keeping the forward and inverse transforms in one place is what lets boxes be reported
 * in CSS viewport pixels regardless of which of the three input forms was used
 * (full frame, DOM-guided crop, or sliding tile).
 */

/** A rectangle in source-image pixel coordinates. */
export interface SourceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Geometry of the aspect-preserving resize applied to reach the model's square input. */
export interface LetterboxInfo {
  /** Region of the source image that was fed to the model, in image pixels. */
  source: SourceRect;
  /** Model input edge length (640, 128, …). */
  modelSize: number;
  /** Uniform source→model scale factor. */
  scale: number;
  /** Padded (letterbox) margins in model pixels, centred. */
  padX: number;
  padY: number;
  /** Size of the *content* inside the padded square, in model pixels. */
  contentWidth: number;
  contentHeight: number;
}

/** A box in normalized [0,1] model coordinates, as emitted by the ONNX graphs. */
export interface NormalizedBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface VisionTensor {
  tensor: Float32Array;
  letterbox: LetterboxInfo;
}

/**
 * Convert a base64 image data URL to an HTMLImageElement, waiting for it to load.
 */
export function loadImage(base64Image: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(new Error(`Failed to load image: ${String(err)}`));
    img.src = base64Image;
  });
}

// ─── Canvas reuse ──────────────────────────────────────────────────────────────

/**
 * Canvases are cached per edge length. The vision pipeline draws the full frame plus
 * several tiles per pass, and allocating a fresh 640×640 canvas (and its backing store)
 * for each of them is a measurable share of total inference time.
 */
const canvasCache = new Map<number, HTMLCanvasElement>();

function getCanvas(size: number): HTMLCanvasElement {
  const cached = canvasCache.get(size);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('Failed to get 2D context from canvas');
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  canvasCache.set(size, canvas);
  return canvas;
}

// ─── Letterboxing ──────────────────────────────────────────────────────────────

/** Clamp a requested region to the real image bounds. */
export function clampSourceRect(
  img: HTMLImageElement,
  region: SourceRect
): SourceRect {
  const naturalWidth = img.naturalWidth || 1;
  const naturalHeight = img.naturalHeight || 1;

  const x = Math.max(0, Math.min(naturalWidth - 1, Math.round(region.x)));
  const y = Math.max(0, Math.min(naturalHeight - 1, Math.round(region.y)));
  const width = Math.max(1, Math.min(naturalWidth - x, Math.round(region.width)));
  const height = Math.max(1, Math.min(naturalHeight - y, Math.round(region.height)));

  return { x, y, width, height };
}

/** Compute the uniform scale and centred padding that fit `region` into a `modelSize` square. */
export function computeLetterbox(region: SourceRect, modelSize: number): LetterboxInfo {
  const scale = Math.min(modelSize / region.width, modelSize / region.height);
  const contentWidth = region.width * scale;
  const contentHeight = region.height * scale;

  return {
    source: region,
    modelSize,
    scale,
    padX: (modelSize - contentWidth) / 2,
    padY: (modelSize - contentHeight) / 2,
    contentWidth,
    contentHeight,
  };
}

/**
 * Render a source region into a square canvas using letterboxing, then convert to a
 * normalized RGB NCHW Float32Array `[1, 3, modelSize, modelSize]`.
 */
export function buildVisionTensor(
  img: HTMLImageElement,
  region: SourceRect,
  modelSize: number
): VisionTensor {
  const source = clampSourceRect(img, region);
  const letterbox = computeLetterbox(source, modelSize);
  const canvas = getCanvas(modelSize);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Failed to get 2D context from canvas');

  // Pad with mid-grey. Black padding makes dark-on-dark content blend into the border;
  // grey is neutral for the contrast stretch the OCR pass applies and for the detectors.
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, modelSize, modelSize);

  ctx.drawImage(
    img,
    source.x,
    source.y,
    source.width,
    source.height,
    Math.round(letterbox.padX),
    Math.round(letterbox.padY),
    Math.round(letterbox.contentWidth),
    Math.round(letterbox.contentHeight)
  );

  const imageData = ctx.getImageData(0, 0, modelSize, modelSize);
  const { data } = imageData;
  const pixelCount = modelSize * modelSize;

  // RGBA HWC → RGB NCHW, normalized to [0, 1]
  const tensor = new Float32Array(1 * 3 * pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const srcIdx = i * 4;
    tensor[i] = data[srcIdx] / 255.0;
    tensor[i + pixelCount] = data[srcIdx + 1] / 255.0;
    tensor[i + 2 * pixelCount] = data[srcIdx + 2] / 255.0;
  }

  return { tensor, letterbox };
}

/**
 * Invert the letterbox: turn a normalized model-space box back into source-image pixels.
 *
 * Boxes that fall entirely inside the padding are rejected, so a detector cannot report a
 * face that is really just the grey border of its own input.
 */
export function mapNormalizedBox(
  box: NormalizedBox,
  letterbox: LetterboxInfo
): { x: number; y: number; width: number; height: number } | null {
  const { modelSize, scale, padX, padY, source } = letterbox;

  const modelX0 = box.x0 * modelSize - padX;
  const modelY0 = box.y0 * modelSize - padY;
  const modelX1 = box.x1 * modelSize - padX;
  const modelY1 = box.y1 * modelSize - padY;

  // Wholly outside the real content → padding artifact, not a detection.
  if (modelX1 <= 0 || modelY1 <= 0 || modelX0 >= letterbox.contentWidth || modelY0 >= letterbox.contentHeight) {
    return null;
  }

  const x0 = Math.max(0, Math.min(letterbox.contentWidth, modelX0)) / scale;
  const y0 = Math.max(0, Math.min(letterbox.contentHeight, modelY0)) / scale;
  const x1 = Math.max(0, Math.min(letterbox.contentWidth, modelX1)) / scale;
  const y1 = Math.max(0, Math.min(letterbox.contentHeight, modelY1)) / scale;

  const width = x1 - x0;
  const height = y1 - y0;
  if (width <= 1 || height <= 1) return null;

  return {
    x: source.x + x0,
    y: source.y + y0,
    width,
    height,
  };
}

// ─── Legacy helpers ────────────────────────────────────────────────────────────

/**
 * Stretch a full image into a square tensor, ignoring aspect ratio.
 * Kept for callers that genuinely want a plain resize; the detectors use
 * `buildVisionTensor` instead.
 */
export function imageToTensor(
  img: HTMLImageElement,
  targetWidth: number,
  targetHeight: number
): Float32Array {
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Failed to get 2D context from canvas');

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

  const { data } = ctx.getImageData(0, 0, targetWidth, targetHeight);
  const pixelCount = targetWidth * targetHeight;

  const tensor = new Float32Array(1 * 3 * pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const srcIdx = i * 4;
    tensor[i] = data[srcIdx] / 255.0;
    tensor[i + pixelCount] = data[srcIdx + 1] / 255.0;
    tensor[i + 2 * pixelCount] = data[srcIdx + 2] / 255.0;
  }

  return tensor;
}

/**
 * cropImageToTensor
 *
 * Extracts a sub-rectangle and letterboxes it into a square tensor, preserving aspect
 * ratio. Returns the geometry alongside the tensor so callers can map detections back.
 */
export function cropImageToTensor(
  img: HTMLImageElement,
  crop: { x: number; y: number; width: number; height: number },
  targetWidth: number,
  targetHeight: number
): VisionTensor {
  if (targetWidth !== targetHeight) {
    // The models are square; fall back to a plain stretch for a non-square request.
    return {
      tensor: imageToTensor(img, targetWidth, targetHeight),
      letterbox: {
        source: clampSourceRect(img, crop),
        modelSize: targetWidth,
        scale: 1,
        padX: 0,
        padY: 0,
        contentWidth: targetWidth,
        contentHeight: targetHeight,
      },
    };
  }

  return buildVisionTensor(img, crop, targetWidth);
}

/**
 * screenshotToTensor
 *
 * Renders a base64 screenshot onto an offscreen canvas and returns
 * a normalized NCHW Float32Array tensor.
 */
export async function screenshotToTensor(
  base64Image: string,
  targetWidth: number,
  targetHeight: number
): Promise<Float32Array> {
  const img = await loadImage(base64Image);
  return imageToTensor(img, targetWidth, targetHeight);
}

/**
 * Get original image dimensions from a base64 URL
 */
export async function getImageDimensions(
  base64Image: string
): Promise<{ width: number; height: number }> {
  const img = await loadImage(base64Image);
  return { width: img.naturalWidth, height: img.naturalHeight };
}
