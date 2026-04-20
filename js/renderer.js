// renderer.js — High-fidelity Canvas 2D hair & beard colour renderer
//
// OVERLAY-CACHE ARCHITECTURE (key Android performance fix):
//   getImageData + pixel loop is very expensive on Android CPU.
//   Previously it ran every frame (60fps). Now it only runs when the mask
//   or a colour/intensity setting actually changes (~10fps on Android).
//
//   Each frame:
//     1. drawImage(video)        — fast, GPU
//     2. drawImage(overlayCache) — fast, GPU composite
//
//   On mask/settings change only:
//     1. getImageData(video)     — slow, but rare
//     2. pixel loop → overlay    — slow, but rare
//     3. putImageData(overlay)   — slow, but rare
//
//   This reduces expensive CPU ops ~6× on Android with no visual difference.

import { EFFECT } from './effects.js';

// ─── HSL helpers ─────────────────────────────────────────────────────────────

function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
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

function hue2rgb(p, q, t) {
  if (t < 0) t += 1; if (t > 1) t -= 1;
  if (t < 1/6) return p + (q - p) * 6 * t;
  if (t < 0.5) return q;
  if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
  return p;
}

function hslToRgb(h, s, l) {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1/3) * 255),
    Math.round(hue2rgb(p, q, h)       * 255),
    Math.round(hue2rgb(p, q, h - 1/3) * 255),
  ];
}

function smoothstep(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// ─── HairRenderer ─────────────────────────────────────────────────────────────

export class HairRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d', { willReadFrequently: true });
    if (!this.ctx) throw new Error('Canvas 2D not supported');

    // Work canvas — used to sample video pixels for luminance when rebuilding overlay
    this._workCanvas = document.createElement('canvas');
    this._workCtx    = this._workCanvas.getContext('2d', { willReadFrequently: true });

    // Overlay canvas — cached coloured hair/beard layer, composited each frame
    this._overlayCanvas = document.createElement('canvas');
    this._overlayCtx    = this._overlayCanvas.getContext('2d');
    this._overlayImgData = null; // reused ImageData buffer

    // Captured frame — the exact video frame that was sent to MediaPipe for
    // the current mask. Displaying this instead of live video ensures the
    // colour overlay is always perfectly aligned with the hair (zero visual lag).
    this._capturedFrame    = document.createElement('canvas');
    this._capturedFrameCtx = this._capturedFrame.getContext('2d');
    this._hasCapturedFrame = false;

    // ── Hair state ────────────────────────────────────────────────────────────
    this.color1HSL   = [0.07, 0.55, 0.20];
    this.intensity   = 0.50;
    this.effectMode  = EFFECT.SOLID;
    this.hairBoundsY = [0.0, 1.0];
    this.hairBoundsX = [0.0, 1.0];
    this.mirrorX     = true;

    this._mask   = null;
    this._maskW  = 0;
    this._maskH  = 0;
    this._source = null;
    this._maskDirty = false;

    // ── Beard state ───────────────────────────────────────────────────────────
    this.beardEnabled   = false;
    this.beardColor1HSL = [0.07, 0.58, 0.14];
    this.beardIntensity = 0.70;

    this._beardMask  = null;
    this._beardMaskW = 0;
    this._beardMaskH = 0;
    this._beardDirty = false;
  }

  async loadNoise(_url) { /* no-op */ }

  updateVideoTexture(source) { this._source = source; }

  updateMaskTexture(data, w, h) {
    this._mask  = data;
    this._maskW = w;
    this._maskH = h;
    this._maskDirty = true;
  }

  updateBeardMaskTexture(data, w, h) {
    this._beardMask  = data;
    this._beardMaskW = w;
    this._beardMaskH = h;
    this._beardDirty = true;
  }

  // Store the exact video frame that was passed to MediaPipe for this mask.
  // draw() will display this instead of live video so colour is always in sync.
  updateCapturedFrame(canvas) {
    if (this._capturedFrame.width  !== canvas.width ||
        this._capturedFrame.height !== canvas.height) {
      this._capturedFrame.width  = canvas.width;
      this._capturedFrame.height = canvas.height;
    }
    this._capturedFrameCtx.drawImage(canvas, 0, 0);
    this._hasCapturedFrame = true;
  }

  // Call after changing any colour / intensity / effect / bounds property so
  // the overlay is rebuilt on the next draw() call.
  markDirty() {
    this._maskDirty  = true;
    this._beardDirty = true;
  }

  draw() {
    const { canvas, ctx, _source } = this;
    if (!_source) return;
    const cw = canvas.width, ch = canvas.height;

    // ── Resize auxiliary canvases if output size changed ──────────────────
    if (this._workCanvas.width !== cw || this._workCanvas.height !== ch) {
      this._workCanvas.width     = cw;
      this._workCanvas.height    = ch;
      this._overlayCanvas.width  = cw;
      this._overlayCanvas.height = ch;
      this._overlayImgData = null;
      this._maskDirty  = true;
      this._beardDirty = true;
    }

    const hasHair  = this._mask  && this._mask.length  > 0;
    const hasBeard = this.beardEnabled && this._beardMask && this._beardMask.length > 0;

    // ── Rebuild overlay only when mask or settings changed ────────────────
    if (this._maskDirty || this._beardDirty) {
      if (hasHair || hasBeard) {
        // Sample the CAPTURED frame (not live video) so luminance matches the
        // exact frame the mask was computed from — overlay aligns perfectly.
        const pixelSrc = this._hasCapturedFrame ? this._capturedFrame : _source;
        this._workCtx.drawImage(pixelSrc, 0, 0, cw, ch);
        const srcPixels = this._workCtx.getImageData(0, 0, cw, ch).data;

        // Reuse or allocate overlay ImageData
        if (!this._overlayImgData ||
            this._overlayImgData.width !== cw ||
            this._overlayImgData.height !== ch) {
          this._overlayImgData = this._overlayCtx.createImageData(cw, ch);
        }
        this._overlayImgData.data.fill(0); // clear to transparent

        if (hasHair)  this._buildHairOverlay(srcPixels, this._overlayImgData.data, cw, ch);
        if (hasBeard) this._buildBeardOverlay(srcPixels, this._overlayImgData.data, cw, ch);

        this._overlayCtx.putImageData(this._overlayImgData, 0, 0);
      } else {
        // No masks — clear stale overlay
        this._overlayCtx.clearRect(0, 0, cw, ch);
      }
      this._maskDirty  = false;
      this._beardDirty = false;
    }

    // ── Every frame: display captured frame + GPU-composited overlay ─────
    // Using the captured frame (not live video) guarantees the overlay is
    // always drawn on top of the exact frame it was computed from — the
    // colour is physically stuck to the hair regardless of movement speed.
    // Falls back to live video until the first segmentation completes.
    const displaySrc = this._hasCapturedFrame ? this._capturedFrame : _source;
    ctx.save();
    if (this.mirrorX) {
      ctx.translate(cw, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(displaySrc, 0, 0, cw, ch);
    ctx.drawImage(this._overlayCanvas, 0, 0);
    ctx.restore();
  }

  // ── Build hair colour overlay ─────────────────────────────────────────────
  // Writes luminance-adjusted target colour into `overlay` with alpha encoding
  // the mask weight. source-over compositing in draw() blends it onto video.

  _buildHairOverlay(pixels, overlay, cw, ch) {
    const mask       = this._mask;
    const maskW      = this._maskW;
    const maskH      = this._maskH;
    const intensity  = this.intensity;
    const effectMode = this.effectMode;
    const col1       = this.color1HSL;
    const [by0, by1] = this.hairBoundsY;
    const [bx0, bx1] = this.hairBoundsX;

    const scaleX = maskW / cw;
    const scaleY = maskH / ch;

    const c1 = hslToRgb(col1[0], col1[1], col1[2]);
    const c1r = c1[0], c1g = c1[1], c1b = c1[2];
    const c1y = 0.299 * c1r + 0.587 * c1g + 0.114 * c1b;

    for (let y = 0; y < ch; y++) {
      const normY = y / ch;

      for (let x = 0; x < cw; x++) {
        const mx   = Math.min(maskW - 1, Math.floor(x * scaleX));
        const my   = Math.min(maskH - 1, Math.floor(y * scaleY));
        const mval = mask[my * maskW + mx];

        if (mval < 0.06) continue;

        const maskWeight = smoothstep(0.15, 0.55, mval);
        if (maskWeight < 0.01) continue;

        // ── Spatial placement gate ────────────────────────────────────────
        let placementAlpha = 1.0;

        if (effectMode === EFFECT.UNDERLAYER) {
          const span  = by1 - by0;
          const start = by0 + span * 0.60;
          if (normY < start) continue;
          placementAlpha = smoothstep(start, start + Math.max(span * 0.06, 0.02), normY);

        } else if (effectMode === EFFECT.FRONT_STREAKS) {
          const normX = x / cw;
          const hairW = bx1 - bx0;
          if (hairW > 0.02) {
            const leftEdge  = bx0 + hairW * 0.22;
            const rightEdge = bx1 - hairW * 0.22;
            if (normX > leftEdge && normX < rightEdge) continue;
            placementAlpha = normX <= leftEdge
              ? 1 - smoothstep(bx0, leftEdge, normX)
              : smoothstep(rightEdge, bx1, normX);
          }

        } else if (effectMode === EFFECT.SIDE_STREAK) {
          const normX = x / cw;
          const hairW = bx1 - bx0;
          if (hairW > 0.02) {
            const streakStart = bx1 - hairW * 0.22;
            if (normX < streakStart) continue;
            placementAlpha = smoothstep(
              streakStart,
              Math.min(bx1, streakStart + hairW * 0.06),
              normX
            );
          }
        }

        const pi = (y * cw + x) * 4;
        const r  = pixels[pi];
        const g  = pixels[pi + 1];
        const b  = pixels[pi + 2];

        const yl = 0.299 * r + 0.587 * g + 0.114 * b;

        let cr, cg, cb;
        if (c1y > 4) {
          const scale = Math.min(3.2, yl / c1y);
          cr = Math.min(255, c1r * scale);
          cg = Math.min(255, c1g * scale);
          cb = Math.min(255, c1b * scale);
        } else {
          cr = c1r; cg = c1g; cb = c1b;
        }

        const hv = Math.imul(x * 374761393 ^ y * 1664525, 1013904223) >>> 0;
        const sv = 0.88 + (hv & 0xFF) / 255 * 0.24;
        cr = Math.min(255, cr * sv + 0.5 | 0);
        cg = Math.min(255, cg * sv + 0.5 | 0);
        cb = Math.min(255, cb * sv + 0.5 | 0);

        const alpha = maskWeight * intensity * placementAlpha;

        // Store colour + alpha in overlay; draw() composites via source-over
        overlay[pi]     = cr;
        overlay[pi + 1] = cg;
        overlay[pi + 2] = cb;
        overlay[pi + 3] = Math.min(255, alpha * 255 + 0.5 | 0);
      }
    }
  }

  // ── Build beard colour overlay ────────────────────────────────────────────

  _buildBeardOverlay(pixels, overlay, cw, ch) {
    const mask      = this._beardMask;
    const maskW     = this._beardMaskW;
    const maskH     = this._beardMaskH;
    const intensity = this.beardIntensity;
    const col       = this.beardColor1HSL;

    const scaleX = maskW / cw;
    const scaleY = maskH / ch;

    const [tr, tg, tb] = hslToRgb(col[0], col[1], col[2]);
    const ty = 0.299 * tr + 0.587 * tg + 0.114 * tb;

    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const mx   = Math.min(maskW - 1, Math.floor(x * scaleX));
        const my   = Math.min(maskH - 1, Math.floor(y * scaleY));
        const mval = mask[my * maskW + mx];

        if (mval < 0.04) continue;

        const maskWeight = smoothstep(0.06, 0.42, mval);
        if (maskWeight < 0.01) continue;

        const pi = (y * cw + x) * 4;
        const r  = pixels[pi];
        const g  = pixels[pi + 1];
        const b  = pixels[pi + 2];

        const yl = 0.299 * r + 0.587 * g + 0.114 * b;

        let cr, cg, cb;
        if (ty > 4) {
          const scale = Math.min(3.2, yl / ty);
          cr = Math.min(255, tr * scale);
          cg = Math.min(255, tg * scale);
          cb = Math.min(255, tb * scale);
        } else {
          cr = tr; cg = tg; cb = tb;
        }

        const hv = Math.imul(x * 374761393 ^ y * 1664525, 1013904223) >>> 0;
        const sv = 0.80 + (hv & 0xFF) / 255 * 0.32;
        cr = Math.min(255, cr * sv + 0.5 | 0);
        cg = Math.min(255, cg * sv + 0.5 | 0);
        cb = Math.min(255, cb * sv + 0.5 | 0);

        const alpha = maskWeight * intensity;

        overlay[pi]     = cr;
        overlay[pi + 1] = cg;
        overlay[pi + 2] = cb;
        overlay[pi + 3] = Math.min(255, alpha * 255 + 0.5 | 0);
      }
    }
  }

  resize(w, h) {
    this.canvas.width  = w;
    this.canvas.height = h;
    this._overlayImgData = null;
    this._maskDirty  = true;
    this._beardDirty = true;
  }

  captureFrame() {
    this.draw();
    return this.canvas.toDataURL('image/jpeg', 0.93);
  }
}
