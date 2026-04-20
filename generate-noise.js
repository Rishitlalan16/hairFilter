// generate-noise.js — Run with Node.js to produce assets/noise-256.png
// Usage: node generate-noise.js
// Requires: npm install pngjs (one-time)

const { PNG } = require('pngjs');
const fs = require('fs');
const path = require('path');

const SIZE = 256;

// ── Permutation table (Ken Perlin's reference) ───────────────────────────────
const P = new Uint8Array(512);
const perm = [151,160,137,91,90,15,131,13,201,95,96,53,194,233,7,225,140,36,
  103,30,69,142,8,99,37,240,21,10,23,190,6,148,247,120,234,75,0,26,197,62,94,
  252,219,203,117,35,11,32,57,177,33,88,237,149,56,87,174,20,125,136,171,168,
  68,175,74,165,71,134,139,48,27,166,77,146,158,231,83,111,229,122,60,211,133,
  230,220,105,92,41,55,46,245,40,244,102,143,54,65,25,63,161,1,216,80,73,209,
  76,132,187,208,89,18,169,200,196,135,130,116,188,159,86,164,100,109,198,173,
  186,3,64,52,217,226,250,124,123,5,202,38,147,118,126,255,82,85,212,207,206,
  59,227,47,16,58,17,182,189,28,42,223,183,170,213,119,248,152,2,44,154,163,70,
  221,153,101,155,167,43,172,9,129,22,39,253,19,98,108,110,79,113,224,232,178,
  185,112,104,218,246,97,228,251,34,242,193,238,210,144,12,191,179,162,241,81,
  51,145,235,249,14,239,107,49,192,214,31,181,199,106,157,184,84,204,176,115,
  121,50,45,127,4,150,254,138,236,205,93,222,114,67,29,24,72,243,141,128,195,
  78,66,215,61,156,180];
for (let i = 0; i < 256; i++) P[i] = P[i + 256] = perm[i];

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function lerp(a, b, t) { return a + t * (b - a); }
function grad(hash, x, y) {
  const h = hash & 3;
  const u = h < 2 ? x : y;
  const v = h < 2 ? y : x;
  return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
}

function noise2d(x, y) {
  const X = Math.floor(x) & 255;
  const Y = Math.floor(y) & 255;
  x -= Math.floor(x);
  y -= Math.floor(y);
  const u = fade(x), v = fade(y);
  const a  = P[X]   + Y, aa = P[a],   ab = P[a+1];
  const b  = P[X+1] + Y, ba = P[b],   bb = P[b+1];
  return lerp(
    lerp(grad(P[aa], x, y),   grad(P[ba], x-1, y),   u),
    lerp(grad(P[ab], x, y-1), grad(P[bb], x-1, y-1), u),
    v
  );
}

// Multi-octave fractal noise
function fbm(x, y, octaves = 5) {
  let val = 0, amp = 0.5, freq = 1, max = 0;
  for (let i = 0; i < octaves; i++) {
    val += noise2d(x * freq, y * freq) * amp;
    max += amp;
    amp  *= 0.5;
    freq *= 2.0;
  }
  return val / max;
}

// ── Generate PNG ───────────────────────────────────────────────────────────

const png = new PNG({ width: SIZE, height: SIZE, colorType: 2 });

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const nx = x / SIZE * 4;
    const ny = y / SIZE * 4;
    const v  = Math.round((fbm(nx, ny) * 0.5 + 0.5) * 255);
    const i  = (y * SIZE + x) * 3;
    png.data[i]   = v;
    png.data[i+1] = v;
    png.data[i+2] = v;
  }
}

const outPath = path.join(__dirname, 'assets', 'noise-256.png');
const buf = PNG.sync.write(png);
fs.writeFileSync(outPath, buf);
console.log('✓ Written', outPath);
