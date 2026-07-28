/**
 * Deterministic box (area-average) downsampling over RGBA (issue #118
 * Phase 1). Pure IEEE-754 arithmetic — no canvas, no platform resampler —
 * so a given input and target produce identical bytes on every host.
 *
 * Color is averaged alpha-premultiplied: a transparent pixel must not bleed
 * its RGB into the average (diagram edges would darken otherwise).
 */
export function boxResampleRgba(
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): Uint8Array {
  if (targetWidth >= sourceWidth && targetHeight >= sourceHeight) return source;
  const target = new Uint8Array(targetWidth * targetHeight * 4);
  const scaleX = sourceWidth / targetWidth;
  const scaleY = sourceHeight / targetHeight;
  for (let ty = 0; ty < targetHeight; ty += 1) {
    const y0 = ty * scaleY;
    const y1 = Math.min((ty + 1) * scaleY, sourceHeight);
    const rowStart = Math.floor(y0);
    const rowEnd = Math.ceil(y1);
    for (let tx = 0; tx < targetWidth; tx += 1) {
      const x0 = tx * scaleX;
      const x1 = Math.min((tx + 1) * scaleX, sourceWidth);
      const colStart = Math.floor(x0);
      const colEnd = Math.ceil(x1);
      let r = 0; let g = 0; let b = 0; let a = 0; let area = 0;
      for (let sy = rowStart; sy < rowEnd; sy += 1) {
        const coverY = Math.min(sy + 1, y1) - Math.max(sy, y0);
        if (coverY <= 0) continue;
        for (let sx = colStart; sx < colEnd; sx += 1) {
          const coverX = Math.min(sx + 1, x1) - Math.max(sx, x0);
          if (coverX <= 0) continue;
          const weight = coverX * coverY;
          const src = (sy * sourceWidth + sx) * 4;
          const alpha = source[src + 3]!;
          const alphaWeight = weight * alpha;
          r += source[src]! * alphaWeight;
          g += source[src + 1]! * alphaWeight;
          b += source[src + 2]! * alphaWeight;
          a += alphaWeight;
          area += weight;
        }
      }
      const dst = (ty * targetWidth + tx) * 4;
      if (a > 0) {
        target[dst] = Math.min(255, Math.round(r / a));
        target[dst + 1] = Math.min(255, Math.round(g / a));
        target[dst + 2] = Math.min(255, Math.round(b / a));
      }
      target[dst + 3] = area > 0 ? Math.min(255, Math.round(a / area)) : 0;
    }
  }
  return target;
}

/** Drop the alpha channel: RGBA → interleaved RGB (for JPEG re-encoding). */
export function rgbaToRgb(pixels: Uint8Array): Uint8Array {
  const count = pixels.byteLength / 4;
  const rgb = new Uint8Array(count * 3);
  for (let i = 0, src = 0, dst = 0; i < count; i += 1, src += 4, dst += 3) {
    rgb[dst] = pixels[src]!;
    rgb[dst + 1] = pixels[src + 1]!;
    rgb[dst + 2] = pixels[src + 2]!;
  }
  return rgb;
}
