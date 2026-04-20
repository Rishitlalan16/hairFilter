// share.js — Download and Web Share API integration

/**
 * Download the current canvas frame as a JPEG.
 */
export function downloadFrame(canvas, filename = 'keshananda-hair-tryout.jpg') {
  canvas.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, 'image/jpeg', 0.92);
}

/**
 * Share the current canvas frame using the Web Share API (mobile) or
 * fallback to copy a data URL to clipboard.
 */
export async function shareFrame(canvas) {
  canvas.toBlob(async blob => {
    const file = new File([blob], 'my-new-hair.jpg', { type: 'image/jpeg' });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          files:  [file],
          title:  'My new hair colour — Keshananda',
          text:   'Check out my new hair look from Keshananda! ✨',
        });
        return;
      } catch (_) {
        // User cancelled or share failed — fall through to clipboard
      }
    }

    // Clipboard fallback
    try {
      await navigator.clipboard.writeText(canvas.toDataURL('image/jpeg', 0.92));
      showToast('Image copied to clipboard');
    } catch (_) {
      showToast('Tap and hold the image to save it');
    }
  }, 'image/jpeg', 0.92);
}

function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('visible');
  setTimeout(() => el.classList.remove('visible'), 3000);
}
