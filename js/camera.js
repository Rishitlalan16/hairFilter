// camera.js — getUserMedia wrapper with resolution negotiation and flip support

export class Camera {
  constructor(videoEl) {
    this.video = videoEl;
    this.stream = null;
    this.facingMode = 'user';
  }

  async start() {
    // Android CPUs vary wildly — cap at 720×480 to keep the pixel-loop fast.
    // iOS and desktop stay at 1280×720 for full-quality output.
    const isAndroid = /Android/i.test(navigator.userAgent);
    const constraints = {
      video: {
        facingMode: this.facingMode,
        width:  { ideal: isAndroid ? 720  : 1280, min: isAndroid ? 480 : 640 },
        height: { ideal: isAndroid ? 480  : 720,  min: isAndroid ? 360 : 480 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (_) {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }

    this.video.srcObject = this.stream;

    // Wait for metadata — but it may have already fired (race condition guard)
    if (this.video.readyState < HTMLMediaElement.HAVE_METADATA) {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          // Even if event never fires, proceed if stream tracks are active
          resolve();
        }, 5000);

        this.video.addEventListener('loadedmetadata', () => {
          clearTimeout(timeout);
          resolve();
        }, { once: true });

        this.video.addEventListener('error', (e) => {
          clearTimeout(timeout);
          reject(e);
        }, { once: true });
      });
    }

    // play() can throw if document not focused; swallow — autoplay attr handles it
    try {
      await this.video.play();
    } catch (e) {
      console.warn('video.play() rejected (autoplay policy):', e);
    }

    // Give the video one tick to populate videoWidth/videoHeight
    if (!this.video.videoWidth) {
      await new Promise(r => setTimeout(r, 100));
    }

    return {
      width:  this.video.videoWidth  || 640,
      height: this.video.videoHeight || 480,
    };
  }

  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    this.video.srcObject = null;
  }

  async flip() {
    this.stop();
    this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';
    return this.start();
  }

  get width()  { return this.video.videoWidth  || 640; }
  get height() { return this.video.videoHeight || 480; }
  get ready()  { return this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA; }
}
