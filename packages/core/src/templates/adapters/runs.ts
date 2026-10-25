import type { Segment } from "../render.js";

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
    if (source.slice(seg.start, seg.end) !== seg.output) {
      out[pieceAt(seg.start)] += seg.output;
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
