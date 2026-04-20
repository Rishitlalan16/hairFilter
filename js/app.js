// app.js — Main controller: render loop, state management, event wiring

import { Camera }          from './camera.js';
import { initSegmenter, segmentFrame, segmentImage } from './segmentation.js';
import { HairRenderer }    from './renderer.js';
import { computeHairBounds, computeHairHBounds, EFFECT } from './effects.js';
import { hexToHsl, hexToRgb, COLOR_PRESETS } from './colors.js';
import { analyzeSkinTone, initFaceDetector } from './skin-analysis.js';
import { downloadFrame, shareFrame }  from './share.js';
import {
  showToast,
  initBottomSheet, initTabs,
  openSheet, closeSheet,
  renderAllSwatches,
  renderTrendingSwatches,
  renderBeardSwatches,
  renderRecommendations, initCompareSlider,
} from './ui.js';

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  mode:          'camera',      // 'camera' | 'photo'
  color1Hex:     '#5C3317',     // chocolate brown default
  intensity:     0.50,
  effectMode:    EFFECT.SOLID,
  hairBounds:    [0.0, 1.0],   // vertical [minY, maxY] normalised
  hairHBounds:   [0.0, 1.0],   // horizontal [minX, maxX] normalised
  running:       false,
  frameCount:    0,
  lastMask:      null,
  lastBeardMask: null,
  photoImage:    null,
  skinUndertone: null,
  // Beard
  beardEnabled:    false,
  beardColor1Hex:  '#2C1810',
  beardIntensity:  0.70,
};

// ─── DOM refs ────────────────────────────────────────────────────────────────

const videoEl           = document.getElementById('camera-feed');
const renderCanvas      = document.getElementById('render-canvas');
const fileInput         = document.getElementById('file-input');
const loaderEl          = document.getElementById('loader');
const appEl             = document.getElementById('app');
const loadingMsg        = document.getElementById('loading-msg');
const btnCameraMode     = document.getElementById('btn-camera-mode');
const btnPhotoMode      = document.getElementById('btn-photo-mode');
const btnFlip           = document.getElementById('btn-flip');
const btnCapture        = document.getElementById('btn-capture');
const btnUpload         = document.getElementById('btn-upload');
const btnDownload       = document.getElementById('btn-download');
const btnShare          = document.getElementById('btn-share');
const btnAnalyze        = document.getElementById('btn-analyze');
const btnOpenPanel      = document.getElementById('btn-open-panel');
const btnClosePanel     = document.getElementById('btn-close-panel');
const btnBeardToggle    = document.getElementById('btn-beard-toggle');
const intensitySlider         = document.getElementById('intensity-slider');
const mobileIntensitySlider   = document.getElementById('mobile-intensity-slider');
const beardIntensitySlider    = document.getElementById('beard-intensity-slider');
const beardOptionsDiv   = document.getElementById('beard-options');
const compareWrapper    = document.getElementById('compare-wrapper');
const compareOrigImg    = document.getElementById('compare-original-img');

// ─── Globals ──────────────────────────────────────────────────────────────────

let camera    = null;
let segmenter = null;
let renderer  = null;

// Intermediate canvas — MediaPipe reads from this, not the <video> element.
// Downsampled to SEG_MAX_DIM before segmentation. MediaPipe runs internally at
// 256×256 regardless of input size — feeding anything larger just wastes time
// on downsampling. Cap at 256 on all devices for minimum latency.
const IS_ANDROID  = /Android/i.test(navigator.userAgent);
const SEG_MAX_DIM = 256;
const segCanvas = document.createElement('canvas');
const segCtx    = segCanvas.getContext('2d');
// Full-resolution snapshot taken at inference time — passed to the renderer so
// it can display the frame that matches its mask (eliminates colour lag).
const captureCanvas = document.createElement('canvas');
const captureCtx    = captureCanvas.getContext('2d');

// ─── Temporal mask smoothing ──────────────────────────────────────────────────
// No EMA — raw mask is clamped then blurred each frame for zero lag.

let _clampBuf      = null;
let _smoothBlurBuf = null;
let _beardClampBuf = null;
let _beardBlurBuf  = null;

function _boxBlurMask(src, dst, w, h) {
  const inv9 = 1 / 9;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      dst[i] = (
        src[(y-1)*w + (x-1)] + src[(y-1)*w + x] + src[(y-1)*w + (x+1)] +
        src[ y   *w + (x-1)] + src[ y   *w + x] + src[ y   *w + (x+1)] +
        src[(y+1)*w + (x-1)] + src[(y+1)*w + x] + src[(y+1)*w + (x+1)]
      ) * inv9;
    }
  }
  for (let x = 0; x < w; x++) {
    dst[x]           = src[x];
    dst[(h-1)*w + x] = src[(h-1)*w + x];
  }
  for (let y = 0; y < h; y++) {
    dst[y*w]       = src[y*w];
    dst[y*w + w-1] = src[y*w + w-1];
  }
}

function smoothMaskInPlace(newMask, w, h) {
  const n = newMask.length;
  if (!_clampBuf      || _clampBuf.length      !== n) _clampBuf      = new Float32Array(n);
  if (!_smoothBlurBuf || _smoothBlurBuf.length !== n) _smoothBlurBuf = new Float32Array(n);

  const CLAMP = 0.13;
  for (let i = 0; i < n; i++) {
    _clampBuf[i] = newMask[i] < CLAMP ? 0 : newMask[i];
  }
  _boxBlurMask(_clampBuf, _smoothBlurBuf, w, h);
  return _smoothBlurBuf;
}

function smoothBeardMask(newMask, w, h) {
  const n = newMask.length;
  if (!_beardClampBuf || _beardClampBuf.length !== n) _beardClampBuf = new Float32Array(n);
  if (!_beardBlurBuf  || _beardBlurBuf.length  !== n) _beardBlurBuf  = new Float32Array(n);

  // Lower clamp than scalp hair — beard confidence is weaker, preserve more pixels
  const CLAMP = 0.05;
  for (let i = 0; i < n; i++) {
    _beardClampBuf[i] = newMask[i] < CLAMP ? 0 : newMask[i];
  }
  _boxBlurMask(_beardClampBuf, _beardBlurBuf, w, h);
  return _beardBlurBuf;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  updateLoadingMsg('Loading AI models…');

  // ── 1. MediaPipe segmenter ────────────────────────────────────────────────
  try {
    segmenter = await initSegmenter(() => {
      updateLoadingMsg('Starting camera…');
    });
    console.log('[boot] Segmenter ready');
  } catch (err) {
    console.error('[boot] Segmenter init failed:', err);
    showError('Could not load AI model. Please check your connection and refresh.');
    return;
  }

  // ── 2. Renderer ───────────────────────────────────────────────────────────
  try {
    renderer = new HairRenderer(renderCanvas);
    console.log('[boot] Renderer ready');
    await renderer.loadNoise('assets/noise-256.png');
  } catch (err) {
    console.error('[boot] Renderer init failed:', err);
    showError('Your device does not support canvas rendering. Please try a different browser.');
    return;
  }

  // ── 3. Camera ─────────────────────────────────────────────────────────────
  camera = new Camera(videoEl);
  try {
    updateLoadingMsg('Starting camera…');
    const { width, height } = await camera.start();
    console.log('[boot] Camera ready', width, 'x', height);
    resizeCanvas(width, height);
  } catch (err) {
    console.warn('[boot] Camera unavailable:', err);
    setMode('photo');
    showToast('Camera unavailable — upload a photo to try on colours');
  }

  // Apply initial state to renderer
  applyStateToRenderer();

  // Init UI
  initBottomSheet();
  initTabs(onTabChange);
  renderAllSwatches(onPrimaryColorSelect, state.color1Hex);
  renderTrendingSwatches(onPrimaryColorSelect, state.color1Hex);
  renderBeardSwatches(onBeardColorSelect, state.beardColor1Hex);

  // Wire events
  wireEvents();

  // Show app
  loaderEl.hidden = true;
  appEl.hidden = false;

  // Start render loop
  if (state.mode === 'camera') startRenderLoop();
}

// ─── Render Loop ──────────────────────────────────────────────────────────────
// Intentionally synchronous — never awaits anything.
// On Android, MediaPipe CPU inference blocks the main thread for 80-200ms.
// By decoupling rendering from segmentation, the render loop runs at full
// 60fps between inference calls instead of being gated by inference speed.

function startRenderLoop() {
  state.running = true;
  requestAnimationFrame(renderLoop);
  segmentLoop(); // runs independently alongside the render loop
}

function stopRenderLoop() {
  state.running = false;
}

function renderLoop() {
  if (!state.running) return;
  try {
    renderer.updateVideoTexture(videoEl);
    renderer.draw();
  } catch (err) {
    console.warn('[renderLoop] draw error:', err.message);
  }
  state.frameCount++;
  requestAnimationFrame(renderLoop);
}

// ─── Segmentation Loop ────────────────────────────────────────────────────────
// Runs independently of the render loop.
// After each inference call, yields back to the event loop via setTimeout so
// the render loop gets several clean frames (smooth video) between blocks.
// On Android: 80ms yield → render loop fires ~5 clean frames before next block.
// On iOS/desktop: 0ms yield → same behaviour as before (GPU is async anyway).

async function segmentLoop() {
  while (state.running) {
    if (camera?.ready && segmenter) {
      try {
        const ratio = camera.height / camera.width;
        const segW  = Math.min(camera.width,  SEG_MAX_DIM);
        const segH  = Math.round(segW * ratio);
        const cw    = renderCanvas.width;
        const ch    = renderCanvas.height;

        // ── 1. Snapshot the current frame at BOTH resolutions simultaneously ──
        // The full-res snapshot will be displayed together with the mask that
        // MediaPipe computes from this exact moment — colour stays stuck to hair.
        if (captureCanvas.width !== cw || captureCanvas.height !== ch) {
          captureCanvas.width  = cw;
          captureCanvas.height = ch;
        }
        captureCtx.drawImage(videoEl, 0, 0, cw, ch);

        if (segCanvas.width !== segW || segCanvas.height !== segH) {
          segCanvas.width  = segW;
          segCanvas.height = segH;
        }
        segCtx.drawImage(videoEl, 0, 0, segW, segH);

        const sw = segCanvas.width;
        const sh = segCanvas.height;

        // ── 2. Run inference (takes 10–200ms depending on device) ─────────────
        const result = await segmentFrame(segmenter, segCanvas, performance.now());
        if (result) {
          // ── 3. Pair captured frame + mask — they are from the same instant ──
          renderer.updateCapturedFrame(captureCanvas);

          const { hair, beard } = result;

          if (hair) {
            state.lastMask = hair;
            const finalHair = smoothMaskInPlace(hair, sw, sh);
            updateHairBounds(finalHair, sw, sh);
            renderer.updateMaskTexture(finalHair, sw, sh);
          }

          if (beard) {
            state.lastBeardMask = beard;
            const finalBeard = smoothBeardMask(beard, sw, sh);
            renderer.updateBeardMaskTexture(finalBeard, sw, sh);
          }
        }
      } catch (err) {
        console.warn('[segmentLoop] error:', err.message);
      }
    }

    // Yield between inference calls so the render loop can paint clean frames.
    await new Promise(r => setTimeout(r, IS_ANDROID ? 16 : 0));
  }
}

// ─── Photo Mode ───────────────────────────────────────────────────────────────

async function processPhoto(file) {
  const img = new Image();
  img.src = URL.createObjectURL(file);
  await new Promise(r => img.onload = r);

  // Limit resolution
  const MAX = 1920;
  let { naturalWidth: w, naturalHeight: h } = img;
  if (w > MAX || h > MAX) {
    const scale = MAX / Math.max(w, h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }

  const tmpCanvas = document.createElement('canvas');
  tmpCanvas.width  = w;
  tmpCanvas.height = h;
  tmpCanvas.getContext('2d').drawImage(img, 0, 0, w, h);

  state.photoImage = tmpCanvas;
  resizeCanvas(w, h);
  renderer.mirrorX = false;

  if (compareOrigImg) {
    compareOrigImg.src = tmpCanvas.toDataURL('image/jpeg', 0.85);
    compareOrigImg.style.width  = '100%';
    compareOrigImg.style.height = '100%';
  }

  showToast('Analysing…');
  renderer.updateVideoTexture(tmpCanvas);

  const result = await segmentImage(segmenter, tmpCanvas);
  if (!result || !result.hair) {
    showToast('No hair detected — try a clearer photo');
    // Still apply beard if detected in the photo
    if (result?.beard) {
      const finalBeard = smoothBeardMask(result.beard, w, h);
      renderer.updateBeardMaskTexture(finalBeard, w, h);
    }
    renderer.draw();
    showPhotoActions();
    return;
  }

  const { hair, beard } = result;

  state.lastMask = hair;
  updateHairBounds(hair, w, h);
  const finalHair = smoothMaskInPlace(hair, w, h);
  renderer.updateMaskTexture(finalHair, w, h);

  if (beard) {
    state.lastBeardMask = beard;
    const finalBeard = smoothBeardMask(beard, w, h);
    renderer.updateBeardMaskTexture(finalBeard, w, h);
  }

  renderer.draw();
  showPhotoActions();
  if (compareWrapper) compareWrapper.hidden = false;
  initCompareSlider();
}

function showPhotoActions() {
  if (btnDownload) btnDownload.hidden = false;
  if (btnShare)    btnShare.hidden    = false;
  if (btnCapture)  btnCapture.hidden  = true;
}

// ─── Mode switching ───────────────────────────────────────────────────────────

function setMode(mode) {
  state.mode = mode;

  if (mode === 'camera') {
    stopRenderLoop();
    videoEl.hidden           = false;
    if (compareWrapper) compareWrapper.hidden = true;
    if (btnCapture)     btnCapture.hidden     = false;
    if (btnDownload)    btnDownload.hidden     = true;
    if (btnShare)       btnShare.hidden        = true;
    if (btnFlip)        btnFlip.hidden         = false;
    renderer.mirrorX = true;
    camera.start().then(({ width, height }) => {
      resizeCanvas(width, height);
      startRenderLoop();
    }).catch(() => showToast('Camera unavailable'));
  } else {
    stopRenderLoop();
    if (camera) camera.stop();
    videoEl.hidden = true;
    if (btnFlip)    btnFlip.hidden    = true;
    if (btnCapture) btnCapture.hidden = true;
    if (!state.photoImage && document.readyState === 'complete') {
      setTimeout(() => fileInput.click(), 100);
    }
  }

  btnCameraMode?.classList.toggle('active', mode === 'camera');
  btnPhotoMode?.classList.toggle('active',  mode === 'photo');
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

function wireEvents() {
  // Panel open / close
  btnOpenPanel?.addEventListener('click',  () => openSheet());
  btnClosePanel?.addEventListener('click', () => closeSheet());

  // Mode buttons
  btnCameraMode?.addEventListener('click', () => setMode('camera'));
  btnPhotoMode?.addEventListener('click',  () => setMode('photo'));

  // Flip camera
  btnFlip?.addEventListener('click', async () => {
    stopRenderLoop();
    try {
      const { width, height } = await camera.flip();
      resizeCanvas(width, height);
    } catch (_) {
      showToast('Could not flip camera');
    }
    startRenderLoop();
  });

  // Capture (download current frame)
  btnCapture?.addEventListener('click', () => {
    if (!renderer) return;
    const dataUrl = renderer.captureFrame();
    triggerDownload(dataUrl, 'colormate-hair.jpg');
  });

  // Upload
  btnUpload?.addEventListener('click', () => {
    setMode('photo');
    fileInput.click();
  });

  fileInput?.addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (file) processPhoto(file);
    fileInput.value = '';
  });

  // Download / Share
  btnDownload?.addEventListener('click', () => downloadFrame(renderCanvas));
  btnShare?.addEventListener('click',    () => shareFrame(renderCanvas));

  // Hair intensity — shared handler used by both panel slider and mobile vertical slider
  function applyIntensity(value) {
    state.intensity = value / 100;
    if (renderer) { renderer.intensity = state.intensity; renderer.markDirty(); }
    if (state.mode === 'photo' && state.lastMask) renderer.draw();
    // Keep both sliders in sync
    if (intensitySlider)       intensitySlider.value       = value;
    if (mobileIntensitySlider) mobileIntensitySlider.value = value;
  }

  intensitySlider?.addEventListener('input',       e => applyIntensity(parseInt(e.target.value)));
  mobileIntensitySlider?.addEventListener('input', e => applyIntensity(parseInt(e.target.value)));

  // Effect mode buttons
  document.querySelectorAll('[data-effect]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-effect]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const effectName = btn.dataset.effect.toUpperCase();
      state.effectMode = EFFECT[effectName] ?? EFFECT.SOLID;
      if (renderer) { renderer.effectMode = state.effectMode; renderer.markDirty(); }
      if (state.mode === 'photo' && state.lastMask) renderer.draw();
    });
  });

  // Beard toggle
  btnBeardToggle?.addEventListener('click', () => {
    state.beardEnabled = !state.beardEnabled;
    if (renderer) { renderer.beardEnabled = state.beardEnabled; renderer.markDirty(); }
    btnBeardToggle.textContent = state.beardEnabled ? 'ON' : 'OFF';
    btnBeardToggle.classList.toggle('on', state.beardEnabled);
    if (beardOptionsDiv) beardOptionsDiv.hidden = !state.beardEnabled;
    if (state.mode === 'photo') renderer.draw();
  });

  // Beard intensity slider
  beardIntensitySlider?.addEventListener('input', e => {
    state.beardIntensity = parseInt(e.target.value) / 100;
    if (renderer) { renderer.beardIntensity = state.beardIntensity; renderer.markDirty(); }
    if (state.mode === 'photo') renderer.draw();
  });

  // Custom beard color picker
  document.getElementById('custom-beard-color')?.addEventListener('input', e => {
    onBeardColorSelect({ name: 'Custom', hex: e.target.value });
  });

  // Skin analysis
  btnAnalyze?.addEventListener('click', async () => {
    btnAnalyze.disabled = true;
    btnAnalyze.textContent = 'Analysing…';
    try {
      const source = state.mode === 'camera' ? videoEl : state.photoImage;
      if (!source) {
        showToast('Take a photo or use camera first');
        return;
      }
      await initFaceDetector();
      const result = await analyzeSkinTone(source);
      if (!result) {
        showToast('Face not detected — please ensure your face is visible');
        return;
      }
      state.skinUndertone = result.undertone;
      renderRecommendations(result.undertone, color => {
        onPrimaryColorSelect(color);
        renderAllSwatches(onPrimaryColorSelect, state.color1Hex);
        showToast(`${color.name} selected`);
      });
    } catch (err) {
      console.error(err);
      showToast('Analysis failed — please try again');
    } finally {
      btnAnalyze.disabled = false;
      btnAnalyze.textContent = 'Analyse My Skin Tone';
    }
  });

  // Custom hair color picker
  document.getElementById('custom-color-1')?.addEventListener('input', e => {
    onPrimaryColorSelect({ name: 'Custom', hex: e.target.value });
  });

  // Pause render loop when tab hidden
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopRenderLoop();
    else if (state.mode === 'camera' && !state.running) startRenderLoop();
  });
}

// ─── Color selection callbacks ────────────────────────────────────────────────

function onPrimaryColorSelect(color) {
  state.color1Hex = color.hex;
  if (renderer) { renderer.color1HSL = hexToHsl(color.hex); renderer.markDirty(); }
  const picker = document.getElementById('custom-color-1');
  if (picker) picker.value = color.hex;
  if (state.mode === 'photo' && state.lastMask) renderer.draw();
}

function onBeardColorSelect(color) {
  state.beardColor1Hex = color.hex;
  if (renderer) { renderer.beardColor1HSL = hexToHsl(color.hex); renderer.markDirty(); }
  const picker = document.getElementById('custom-beard-color');
  if (picker) picker.value = color.hex;
  if (state.mode === 'photo') renderer.draw();
}

function applyStateToRenderer() {
  if (!renderer) return;
  renderer.color1HSL      = hexToHsl(state.color1Hex);
  renderer.intensity      = state.intensity;
  renderer.effectMode     = state.effectMode;
  renderer.beardEnabled   = state.beardEnabled;
  renderer.beardColor1HSL = hexToHsl(state.beardColor1Hex);
  renderer.beardIntensity = state.beardIntensity;
  // Sync mobile slider to initial state value
  const pct = Math.round(state.intensity * 100);
  if (mobileIntensitySlider) mobileIntensitySlider.value = pct;
}

// ─── Hair bounds helper ───────────────────────────────────────────────────────

function updateHairBounds(mask, w, h) {
  const needsV = state.effectMode === EFFECT.UNDERLAYER;
  const needsH = state.effectMode === EFFECT.FRONT_STREAKS
              || state.effectMode === EFFECT.SIDE_STREAK;

  if (needsV) {
    state.hairBounds     = computeHairBounds(mask, w, h);
    renderer.hairBoundsY = state.hairBounds;
    renderer.markDirty();
  }
  if (needsH) {
    state.hairHBounds    = computeHairHBounds(mask, w, h);
    renderer.hairBoundsX = state.hairHBounds;
    renderer.markDirty();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resizeCanvas(w, h) {
  renderCanvas.width  = w;
  renderCanvas.height = h;
  if (renderer) renderer.resize(w, h);
}

function updateLoadingMsg(msg) {
  if (loadingMsg) loadingMsg.textContent = msg;
}

function showError(msg) {
  if (loaderEl) {
    loaderEl.innerHTML = `
      <div class="loader-error">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#C9A84C" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <p>${msg}</p>
        <button onclick="location.reload()">Try Again</button>
      </div>`;
  }
}

function triggerDownload(dataUrl, filename) {
  const a = document.createElement('a');
  a.href     = dataUrl;
  a.download = filename;
  a.click();
}

function onTabChange(tab) {
  if (tab === 'foryou') initFaceDetector().catch(() => {});
}

// ─── Start ────────────────────────────────────────────────────────────────────

boot().catch(err => {
  console.error('Boot error:', err);
});
