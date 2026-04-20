// segmentation.js
// Uses selfie_multiclass_256x256 which segments: background(0), hair(1),
// body-skin(2), face-skin(3), clothes(4), others(5).
// We use class 1 (hair) confidence mask — precise, no eyebrows/shirt/skin.
// Falls back to selfie_segmenter + HSL extraction if multi-class fails.

const WASM_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';

// Primary: multiclass model gives hair as its own class
const MODEL_MULTICLASS = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';
// Fallback: binary person segmenter (definitely works)
const MODEL_SELFIE     = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';

// Android GPU drivers are highly inconsistent — MediaPipe's WebGL delegate
// produces corrupt masks on many devices (entire frame scores high confidence).
// Force CPU (WASM) delegate on Android; GPU delegate stays for iOS / desktop.
const IS_ANDROID = /Android/i.test(navigator.userAgent);
const DELEGATE   = IS_ANDROID ? 'CPU' : 'GPU';

let _busy        = false;
let _useMulti    = true;   // switch to false if multiclass gives no hair
let _failCount   = 0;      // consecutive frames with no hair from multiclass

// ─── HSL fallback helpers ─────────────────────────────────────────────────────

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return [h, s, l];
}

function isSkin(r, g, b) {
  const [h, s, l] = rgbToHsl(r, g, b);
  return (h < 0.10 || h > 0.92) && s > 0.07 && s < 0.75 && l > 0.28 && l < 0.82;
}

// Pixel canvas for reading source pixels
let _pixelCanvas = null, _pixelCtx = null;

function getPixels(canvas) {
  const w = canvas.width, h = canvas.height;
  if (!_pixelCanvas || _pixelCanvas.width !== w || _pixelCanvas.height !== h) {
    _pixelCanvas = document.createElement('canvas');
    _pixelCanvas.width  = w;
    _pixelCanvas.height = h;
    _pixelCtx = _pixelCanvas.getContext('2d', { willReadFrequently: true });
  }
  _pixelCtx.drawImage(canvas, 0, 0);
  return _pixelCtx.getImageData(0, 0, w, h).data;
}

// ─── Hair extraction from person mask (fallback) ──────────────────────────────

function extractHairFromPerson(personMask, pixels, width, height) {
  const hair = new Float32Array(width * height);

  // Estimate face region: scan for skin pixels to find approximate face bbox
  // Hair is above the chin → restrict coloring to top 70% of detected person
  let topPersonY = height, bottomPersonY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (personMask[y * width + x] > 0.4) {
        if (y < topPersonY)    topPersonY    = y;
        if (y > bottomPersonY) bottomPersonY = y;
      }
    }
  }
  const personH  = bottomPersonY - topPersonY;
  // Hair zone: top of person down to ~60% of person height (above chin)
  const hairMaxY = topPersonY + personH * 0.62;

  for (let y = topPersonY; y < Math.min(height, hairMaxY); y++) {
    for (let x = 0; x < width; x++) {
      const i   = y * width + x;
      const pv  = personMask[i];
      if (pv < 0.35) continue;

      const pi = i * 4;
      const r = pixels[pi], g = pixels[pi+1], b = pixels[pi+2];

      // Skip skin pixels (face, neck)
      if (isSkin(r, g, b)) continue;

      const [, s, l] = rgbToHsl(r, g, b);
      const isDark      = l < 0.42;
      const isColoured  = s > 0.3 && l < 0.72;
      const isLightHair = l >= 0.42 && l < 0.85 && s < 0.22;
      const isWhite     = l >= 0.85 && s < 0.12;

      if (isDark || isColoured || isLightHair || isWhite) {
        hair[i] = pv;
      }
    }
  }

  // 3×3 box blur
  const out = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (hair[i] === 0) continue;
      let s = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          s += hair[(y+dy)*width+(x+dx)];
      out[i] = s / 9;
    }
  }
  return out;
}

// ─── Beard extraction — inverse face-skin + multi-class fusion ───────────────
//
// WHY PREVIOUS APPROACHES FAILED:
//   The model assigns low class-1 (hair) confidence to beard pixels because it
//   was trained primarily on scalp hair. Waiting for a strong positive hair signal
//   means most beards go undetected.
//
// THE FIX — use what the model IS confident about:
//   Face-skin (class 3) scores HIGH on clean skin (0.70–0.95) and LOW on beard
//   hair (0.05–0.30). So in the lower-face zone:
//
//     "pixel is beard" ≈ "pixel is NOT face-skin AND NOT background AND NOT neck"
//
//   Signal = max(0, SKIN_THRESH − faceSkin[i])
//   This is reliably strong for any beard density because it inverts a model
//   output that already works well.
//
//   We then combine this with the direct hair/others signals so dense beards
//   that DO score on class 1 get the highest possible confidence value.
//
//   Clean-shaven face: faceSkin ≈ 0.75-0.90  → notSkin ≈ 0   → no mask  ✓
//   Bearded pixel:     faceSkin ≈ 0.05-0.25  → notSkin ≈ 0.35-0.55 → mask ✓
//   Background/neck:   bgConf/bodySkin high  → skipped via guard     ✓

function extractBeardMask(masks, width, height) {
  if (!masks || masks.length < 4) return null;

  const bgConf     = masks[0].getAsFloat32Array(); // background — exclusion guard
  const hairConf   = masks[1].getAsFloat32Array(); // hair class  — dense beard boost
  const bodySkin   = masks[2].getAsFloat32Array(); // body-skin   — neck exclusion
  const faceSkin   = masks[3].getAsFloat32Array(); // face-skin   — primary inverse signal
  const othersConf = masks.length > 5 ? masks[5].getAsFloat32Array() : null; // stubble boost

  // ── Step 1: face bounding box from face-skin ──────────────────────────────
  let faceMinY = height, faceMaxY = 0, faceMinX = width, faceMaxX = 0;
  for (let i = 0; i < faceSkin.length; i++) {
    if (faceSkin[i] > 0.10) {
      const y = (i / width) | 0;
      const x = i % width;
      if (y < faceMinY) faceMinY = y;
      if (y > faceMaxY) faceMaxY = y;
      if (x < faceMinX) faceMinX = x;
      if (x > faceMaxX) faceMaxX = x;
    }
  }
  if (faceMinY >= faceMaxY) return null;

  const faceH = faceMaxY - faceMinY;
  const faceW = faceMaxX - faceMinX;

  // ── Step 2: beard zone — lower 55% of face + chin overhang + sideburn pad ─
  const zoneTopY = Math.floor(faceMinY + faceH * 0.45);
  const zoneBotY = Math.min(height - 1, faceMaxY + Math.floor(faceH * 0.12));
  const padX     = Math.floor(faceW * 0.05);
  const zoneMinX = Math.max(0, faceMinX - padX);
  const zoneMaxX = Math.min(width - 1, faceMaxX + padX);

  // ── Step 3: fuse inverse face-skin signal with direct hair/others ─────────
  const SKIN_THRESH = 0.60; // faceSkin below this in beard zone → beard pixel

  const beard = new Float32Array(width * height);
  let maxVal = 0;

  for (let y = zoneTopY; y <= zoneBotY; y++) {
    for (let x = zoneMinX; x <= zoneMaxX; x++) {
      const i = y * width + x;

      if (bgConf[i]   > 0.30) continue; // background — no beard here
      if (bodySkin[i] > 0.40) continue; // neck / shoulder — exclude

      const fs = faceSkin[i];
      const hv = hairConf[i];
      const ov = othersConf ? othersConf[i] : 0;

      // Inverse face-skin: strong where face-skin is absent (beard hairs)
      const notSkin = Math.max(0, SKIN_THRESH - fs) * (1 / SKIN_THRESH); // normalise 0→1

      // Direct hair/others class: dense beards often score here too
      const direct = Math.max(hv, ov * 0.85);

      // Fuse: weighted combination so both signals reinforce each other
      const val = Math.max(notSkin * 0.80, direct, (notSkin * 0.5 + direct * 0.5));

      if (val > 0.05) {
        beard[i] = val;
        if (val > maxVal) maxVal = val;
      }
    }
  }

  // Reject only if truly nothing found (clean-shaven or no face in frame)
  if (maxVal < 0.08) return null;

  return beard;
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export async function initSegmenter(onReady) {
  const { ImageSegmenter, FilesetResolver } = await import(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs'
  );
  const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);

  // Try multiclass first
  let segmenter;
  try {
    segmenter = await ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_MULTICLASS, delegate: DELEGATE },
      runningMode: 'IMAGE',
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    });
    console.log('[seg] Using selfie_multiclass model, delegate:', DELEGATE);
  } catch (e) {
    console.warn('[seg] multiclass model failed, using selfie_segmenter fallback:', e);
    _useMulti = false;
    segmenter = await ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_SELFIE, delegate: DELEGATE },
      runningMode: 'IMAGE',
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    });
  }

  if (onReady) onReady();
  return segmenter;
}

// ─── Per-frame segmentation ───────────────────────────────────────────────────

// Returns { hair: Float32Array|null, beard: Float32Array|null } or null when busy.
export function segmentFrame(segmenter, canvas, _ts) {
  if (_busy) return Promise.resolve(null);
  _busy = true;

  return new Promise(resolve => {
    segmenter.segment(canvas, result => {
      _busy = false;
      const masks = result.confidenceMasks;
      if (!masks || masks.length === 0) { resolve(null); return; }

      let hairData  = null;
      let beardData = null;

      if (_useMulti) {
        // selfie_multiclass: class 1 = hair
        if (masks.length > 1) {
          const raw = masks[1].getAsFloat32Array();
          let maxV = 0;
          for (let i = 0; i < raw.length; i++) if (raw[i] > maxV) maxV = raw[i];

          if (maxV > 0.15) {
            // Sanity: real hair occupies at most ~30% of a frame.
            // If >55% of pixels have high confidence the GPU produced a corrupt mask.
            let highCount = 0;
            for (let i = 0; i < raw.length; i++) if (raw[i] > 0.40) highCount++;
            if (highCount > raw.length * 0.55) { resolve({ hair: null, beard: null }); return; }

            const hairRaw = raw.slice();

            // Occlusion: subtract body-skin (class 2) to prevent finger colouring
            if (masks.length > 2) {
              const skin = masks[2].getAsFloat32Array();
              for (let i = 0; i < hairRaw.length; i++) {
                const s = skin[i];
                if (s > 0.25) hairRaw[i] *= Math.max(0, 1 - (s - 0.25) * 3.0);
              }
            }

            hairData = hairRaw;
            _failCount = 0;
          } else {
            _failCount++;
            if (_failCount > 10) {
              console.warn('[seg] switching to selfie_segmenter fallback');
              _useMulti = false;
            }
          }
        }

        // Always attempt beard extraction in multiclass mode (face-skin class 3)
        beardData = extractBeardMask(masks, canvas.width, canvas.height);

      } else {
        // Selfie segmenter fallback: class 0 = person confidence, no beard extraction
        const personMask = masks[0].getAsFloat32Array();
        let maxP = 0;
        for (let i = 0; i < personMask.length; i++) if (personMask[i] > maxP) maxP = personMask[i];

        if (maxP > 0.3) {
          const pixels = getPixels(canvas);
          hairData = extractHairFromPerson(personMask, pixels, canvas.width, canvas.height);
        }
      }

      resolve({ hair: hairData, beard: beardData });
    });
  });
}

export async function segmentImage(segmenter, canvas) {
  _busy = false;
  return segmentFrame(segmenter, canvas, 0);
}
