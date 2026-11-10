/** Private helpers shared by the text, text-assembly and reading-order modules. */
import type { PdfNormalizedRect } from "./contracts.js";
import type { PdfTextDirection } from "./text.js";

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function unionRects(
  rects: Array<PdfNormalizedRect | null | undefined>,
): PdfNormalizedRect | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of rects) {
    if (!rect) continue;
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width);
    bottom = Math.max(bottom, rect.y + rect.height);
  }
  if (left === Infinity) return null;
  return {
    x: round(left),
    y: round(top),
    width: round(Math.max(0, right - left)),
    height: round(Math.max(0, bottom - top)),
  };
}

export function textDirection(value: string): PdfTextDirection {
  let ltr = 0;
  let rtl = 0;
  for (const character of value) {
    if (/\p{Script=Arabic}|\p{Script=Hebrew}/u.test(character)) rtl += 1;
    else if (/\p{Letter}|\p{Number}/u.test(character)) ltr += 1;
  }
  if (rtl > ltr) return "rtl";
  if (ltr > 0) return "ltr";
  return "neutral";
}
