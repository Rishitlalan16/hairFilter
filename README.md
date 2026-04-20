# Keshananda Hair Filter

An AI-powered virtual hair color try-on app that runs entirely in the browser. See how different hair colors look on you in real time using your camera, or upload a photo to try before you dye.

---

## Features

- **Live camera mode** — real-time hair color preview with front/back camera support
- **Photo upload mode** — upload any image and compare before/after with a slider
- **28 color presets** — organized across blacks, blondes, reds, and fashion colors
- **Custom color picker** — choose any color with adjustable intensity
- **Effect styles** — Full, E-Girl (front streaks), Underlayer (peekaboo), Side Streak
- **Skin tone analysis** — detects your undertone and recommends flattering shades
- **Download & share** — save your look or share it directly from mobile

---

## Tech Stack

- Vanilla JavaScript (ES Modules)
- [MediaPipe](https://ai.google.dev/edge/mediapipe/solutions/guide) — AI hair segmentation (`selfie_multiclass_256x256`)
- WebGL canvas for GPU-accelerated rendering
- No frameworks, no build step

---

## Getting Started

```bash
npm install
npm run dev
```

Then open [http://localhost:3333](http://localhost:3333) and allow camera access.

---

## How It Works

Hair segmentation runs in a loop independent of the render loop — MediaPipe extracts a per-pixel hair mask from each camera frame, which is then composited with the chosen color and effect mode on a WebGL canvas at 60fps.

On Android, the app automatically drops to 720×480 and switches to CPU-based (WASM) segmentation to avoid GPU driver issues. On iOS and desktop, it runs at 1280×720 with GPU segmentation.

---

## Project Structure

```
├── index.html
├── css/
│   ├── style.css
│   └── animations.css
├── js/
│   ├── app.js          # Main controller & render loop
│   ├── camera.js       # Camera access & resolution negotiation
│   ├── segmentation.js # MediaPipe hair/beard mask extraction
│   ├── effects.js      # Effect mode logic & bounds computation
│   ├── renderer.js     # WebGL compositing
│   ├── colors.js       # Color presets & conversion utilities
│   ├── ui.js           # DOM & interactions
│   ├── share.js        # Download & Web Share API
│   └── skin-analysis.js
└── assets/
    └── noise-256.png
```

---

## Browser Support

Works on any modern browser that supports `getUserMedia`, WebGL, and WebAssembly. Best experienced on Chrome (desktop or Android) and Safari (iOS).
