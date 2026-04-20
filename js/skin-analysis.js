// skin-analysis.js — Face detection + skin tone undertone classification

const WASM_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite';

let detector = null;

export async function initFaceDetector() {
  if (detector) return detector;
  const { FilesetResolver, FaceDetector } = await import(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs'
  );
  const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
  detector = await FaceDetector.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: MODEL_URL,
      delegate: 'GPU',
    },
    runningMode: 'IMAGE',
    minDetectionConfidence: 0.4,
  });
  return detector;
}

/**
 * Analyze skin tone from a canvas/image element.
 * Returns { undertone: 'warm'|'cool'|'neutral', avgRgb: [r,g,b] } or null.
 */
export async function analyzeSkinTone(sourceEl) {
  if (!detector) await initFaceDetector();

  // Draw source onto a temp canvas so we can sample pixels
  const tmpCanvas = document.createElement('canvas');
  const w = sourceEl.videoWidth || sourceEl.naturalWidth || sourceEl.width;
  const h = sourceEl.videoHeight || sourceEl.naturalHeight || sourceEl.height;
  tmpCanvas.width  = Math.min(w, 640);
  tmpCanvas.height = Math.min(h, 480);
  const ctx = tmpCanvas.getContext('2d');
  ctx.drawImage(sourceEl, 0, 0, tmpCanvas.width, tmpCanvas.height);

  const result = detector.detect(tmpCanvas);
  if (!result.detections || result.detections.length === 0) return null;

  const box = result.detections[0].boundingBox;
  const bx = box.originX / w * tmpCanvas.width;
  const by = box.originY / h * tmpCanvas.height;
  const bw = box.width   / w * tmpCanvas.width;
  const bh = box.height  / h * tmpCanvas.height;

  // Sample three regions: forehead, left cheek, right cheek
  const regions = [
    { x: bx + bw * 0.3, y: by + bh * 0.1, size: 20 },  // forehead
    { x: bx + bw * 0.1, y: by + bh * 0.5, size: 16 },  // left cheek
    { x: bx + bw * 0.7, y: by + bh * 0.5, size: 16 },  // right cheek
  ];

  let rSum = 0, gSum = 0, bSum = 0, count = 0;
  for (const reg of regions) {
    const px = Math.max(0, Math.round(reg.x));
    const py = Math.max(0, Math.round(reg.y));
    const sz = reg.size;
    try {
      const imgData = ctx.getImageData(px, py, sz, sz);
      const d = imgData.data;
      for (let i = 0; i < d.length; i += 4) {
        rSum += d[i];
        gSum += d[i+1];
        bSum += d[i+2];
        count++;
      }
    } catch (_) { /* cross-origin guard */ }
  }

  if (count === 0) return null;
  const avgR = rSum / count / 255;
  const avgG = gSum / count / 255;
  const avgB = bSum / count / 255;

  const [, bStar] = rgbToLab(avgR, avgG, avgB);
  // bStar > 0 means yellowish (warm), bStar < 0 means bluish (cool)
  const undertone = bStar > 12 ? 'warm' : bStar < 2 ? 'cool' : 'neutral';

  return {
    undertone,
    avgRgb: [Math.round(avgR*255), Math.round(avgG*255), Math.round(avgB*255)],
  };
}

// ── LAB conversion ────────────────────────────────────────────────────────────

function rgbToLab(r, g, b) {
  const lin = v => v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92;
  const rl = lin(r), gl2 = lin(g), bl = lin(b);
  const x = (rl * 0.4124564 + gl2 * 0.3575761 + bl * 0.1804375) / 0.95047;
  const y = (rl * 0.2126729 + gl2 * 0.7151522 + bl * 0.0721750) / 1.00000;
  const z = (rl * 0.0193339 + gl2 * 0.1191920 + bl * 0.9503041) / 1.08883;
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const L  = 116 * f(y) - 16;
  const bStar = 200 * (f(y) - f(z));
  return [L, bStar];
}
