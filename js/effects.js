// effects.js — Hair placement bounding-box computation

/**
 * Scan the mask (Float32Array, row-major) for the top and bottom
 * Y coordinates of hair pixels. Returns normalized [0,1] values
 * used for UNDERLAYER placement in the renderer.
 */
export function computeHairBounds(maskData, width, height, threshold = 0.15) {
  let minY = height;
  let maxY = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (maskData[y * width + x] > threshold) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        break;
      }
    }
  }

  if (minY > maxY) return [0.0, 1.0];

  const pad = (maxY - minY) * 0.05;
  return [
    Math.max(0, (minY - pad) / height),
    Math.min(1, (maxY + pad) / height),
  ];
}

/**
 * EFFECT MODE CONSTANTS — must match switch in renderer.js _applyColour.
 */
export const EFFECT = {
  SOLID:         0,
  FRONT_STREAKS: 1,  // E-girl / face-framing — outermost hair columns
  UNDERLAYER:    2,  // Peekaboo — bottom 40% of hair
  SIDE_STREAK:   3,  // One bold streak on the right side
};

/**
 * Compute the leftmost and rightmost X coordinates of the hair region.
 * Returns normalized [0,1] values used as hairBoundsX in the renderer.
 */
export function computeHairHBounds(maskData, width, height, threshold = 0.15) {
  let minX = width;
  let maxX = 0;

  for (let y = 0; y < height; y++) {
    const rowBase = y * width;
    for (let x = 0; x < width; x++) {
      if (maskData[rowBase + x] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }

  if (minX > maxX) return [0.0, 1.0];
  const pad = (maxX - minX) * 0.03;
  return [
    Math.max(0, (minX - pad) / width),
    Math.min(1, (maxX + pad) / width),
  ];
}
