import type { RenderWarning, Segment } from "../render.js";

/** A run's line and column say nothing about where it sits in the page or description. */
export const withoutPosition = ({ line: _line, column: _column, ...w }: RenderWarning): RenderWarning => w;

/**
 * Maps rendered segments of a joined run back onto its pieces (ADF text
 * nodes, storage text tokens). Unchanged segments keep their characters where
 * they were, so marks stay put; a changed segment goes entirely into the piece
 * where it starts.
 */
export function distribute(pieces: string[], segments: Segment[]): string[] {
  const starts: number[] = [];
  let at = 0;
  for (const piece of pieces) {
    starts.push(at);
    at += piece.length;
  }
  const source = pieces.join("");
  const out = pieces.map(() => "");
  const pieceAt = (offset: number) => {
    let i = 0;
    while (i + 1 < starts.length && starts[i + 1]! <= offset && pieces[i + 1] !== undefined) i++;
    return i;
  };
  for (const seg of segments) {
    const slice = source.slice(seg.start, seg.end);
    if (slice !== seg.output) {
      // Text that only lost characters (`~` trimming, `\` before `{{`) keeps the
      // rest in place, so marks on it survive; anything else goes to its start.
      const kept = seg.kind === "content" ? keptOffsets(slice, seg.output) : undefined;
      if (kept) for (const i of kept) out[pieceAt(seg.start + i)] += slice[i];
      else out[pieceAt(seg.start)] += seg.output;
      continue;
    }
    for (let i = 0; i < pieces.length; i++) {
      const from = Math.max(seg.start, starts[i]!);
      const to = Math.min(seg.end, starts[i]! + pieces[i]!.length);
      if (from < to) out[i] += source.slice(from, to);
    }
  }
  return out;
}

/** Offsets in `slice` of the characters `output` keeps, when `output` is `slice` with some deleted; else undefined. */
function keptOffsets(slice: string, output: string): number[] | undefined {
  const kept: number[] = [];
  let j = 0;
  for (let i = 0; i < slice.length && j < output.length; i++) {
    if (slice[i] === output[j]) {
      kept.push(i);
      j++;
    }
  }
  return j === output.length ? kept : undefined;
}
