/**
 * Minimal read-only PDF object reader.
 *
 * PDFium exposes the structure tree only through page-scoped views, so a child
 * that lives on another page is indistinguishable from a broken one. This
 * reader resolves indirect objects directly from the file so the full
 * StructTreeRoot can be traversed with stable object identity.
 *
 * Scope is deliberately narrow: classic and stream cross-reference sections
 * (including /Prev chains and hybrid /XRefStm), object streams, FlateDecode with
 * PNG/TIFF predictors, and a full-file object scan when the cross-reference
 * data is unusable. Encrypted documents are rejected by the caller before this
 * reader runs. It is pure TypeScript and runs unchanged in Node, Bun and
 * browsers.
 */
import { Inflate, Unzlib } from "fflate";

export interface PdfRef {
  kind: "ref";
  num: number;
  gen: number;
}
export interface PdfName {
  kind: "name";
  value: string;
  /** The name's bytes after #-unescaping, for byte-exact rewriting. */
  raw: Uint8Array;
}
export interface PdfString {
  kind: "string";
  bytes: Uint8Array;
}
export interface PdfDict {
  kind: "dict";
  entries: Map<string, PdfValue>;
}
export interface PdfStream {
  kind: "stream";
  dict: PdfDict;
  raw: Uint8Array;
}
export type PdfValue =
  | null
  | boolean
  | number
  | PdfRef
  | PdfName
  | PdfString
  | PdfDict
  | PdfStream
  | PdfValue[];

export class PdfObjectError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PdfObjectError";
  }
}

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const MAX_NESTING = 64;

type Token =
  | { t: "num"; v: number; raw: string }
  | { t: "name"; v: string; raw: Uint8Array }
  | { t: "str"; v: Uint8Array }
  | { t: "kw"; v: string }
  | { t: "punct"; v: "[" | "]" | "<<" | ">>" }
  | { t: "eof" };

class Lexer {
  pos: number;
  constructor(readonly bytes: Uint8Array, start = 0) {
    this.pos = start;
  }

  private skipSpace(): void {
    const b = this.bytes;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (WHITESPACE.has(c)) {
        this.pos++;
      } else if (c === 0x25) {
        while (this.pos < b.length && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) this.pos++;
      } else {
        return;
      }
    }
  }

  next(): Token {
    this.skipSpace();
    const b = this.bytes;
    if (this.pos >= b.length) return { t: "eof" };
    const c = b[this.pos];
    if (c === 0x5b || c === 0x5d) {
      this.pos++;
      return { t: "punct", v: c === 0x5b ? "[" : "]" };
    }
    if (c === 0x3c) {
      if (b[this.pos + 1] === 0x3c) {
        this.pos += 2;
        return { t: "punct", v: "<<" };
      }
      return { t: "str", v: this.hexString() };
    }
    if (c === 0x3e && b[this.pos + 1] === 0x3e) {
      this.pos += 2;
      return { t: "punct", v: ">>" };
    }
    if (c === 0x28) return { t: "str", v: this.literalString() };
    if (c === 0x2f) {
      const raw = this.name();
      return { t: "name", v: utf8OrLatin1(raw), raw };
    }
    const start = this.pos;
    while (this.pos < b.length && !WHITESPACE.has(b[this.pos]) && !DELIMITERS.has(b[this.pos])) this.pos++;
    if (this.pos === start) {
      // Stray delimiter such as ')' or '}': consume it so parsing always advances.
      this.pos++;
      return { t: "kw", v: String.fromCharCode(c) };
    }
    const raw = latin1(b.subarray(start, this.pos));
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(raw)) return { t: "num", v: Number(raw), raw };
    return { t: "kw", v: raw };
  }

  private name(): Uint8Array {
    const b = this.bytes;
    this.pos++;
    const out: number[] = [];
    while (this.pos < b.length && !WHITESPACE.has(b[this.pos]) && !DELIMITERS.has(b[this.pos])) {
      const c = b[this.pos];
      if (c === 0x23 && isHex(b[this.pos + 1]) && isHex(b[this.pos + 2])) {
        out.push(parseInt(String.fromCharCode(b[this.pos + 1], b[this.pos + 2]), 16));
        this.pos += 3;
      } else {
        out.push(c);
        this.pos++;
      }
    }
    return Uint8Array.from(out);
  }

  private hexString(): Uint8Array {
    const b = this.bytes;
    this.pos++;
    const digits: number[] = [];
    while (this.pos < b.length && b[this.pos] !== 0x3e) {
      if (isHex(b[this.pos])) digits.push(hexValue(b[this.pos]));
      this.pos++;
    }
    this.pos++;
    if (digits.length % 2 === 1) digits.push(0);
    const out = new Uint8Array(digits.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = (digits[2 * i] << 4) | digits[2 * i + 1];
    return out;
  }

  private literalString(): Uint8Array {
    const b = this.bytes;
    this.pos++;
    const out: number[] = [];
    let depth = 1;
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 0x5c) {
        const e = b[this.pos++];
        const simple: Record<number, number> = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12, 0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c };
        if (e in simple) out.push(simple[e]);
        else if (e === 0x0d) {
          if (b[this.pos] === 0x0a) this.pos++;
        } else if (e === 0x0a) {
          // line continuation
        } else if (e >= 0x30 && e <= 0x37) {
          let v = e - 0x30;
          for (let i = 0; i < 2 && b[this.pos] >= 0x30 && b[this.pos] <= 0x37; i++) v = v * 8 + (b[this.pos++] - 0x30);
          out.push(v & 0xff);
        } else if (e !== undefined) out.push(e);
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        if (--depth === 0) break;
        out.push(c);
      } else {
        out.push(c);
      }
    }
    return Uint8Array.from(out);
  }
}

/** Parses one value; `stream` bodies are attached by the caller that knows the object context. */
class Parser {
  private peeked: Token[] = [];
  constructor(readonly lexer: Lexer) {}

  token(): Token {
    return this.peeked.shift() ?? this.lexer.next();
  }

  peek(n = 0): Token {
    while (this.peeked.length <= n) this.peeked.push(this.lexer.next());
    return this.peeked[n];
  }

  /** Byte offset after the last consumed token (valid only when nothing is peeked). */
  get position(): number {
    if (this.peeked.length > 0) throw new PdfObjectError("pdf-objects/internal", "position read with peeked tokens");
    return this.lexer.pos;
  }

  value(depth = 0): PdfValue {
    if (depth > MAX_NESTING) throw new PdfObjectError("pdf-objects/nesting", "object nesting exceeds budget");
    const tok = this.token();
    switch (tok.t) {
      case "num": {
        const a = this.peek(0);
        const b = this.peek(1);
        if (Number.isInteger(tok.v) && a.t === "num" && Number.isInteger(a.v) && b.t === "kw" && b.v === "R") {
          this.token();
          this.token();
          return { kind: "ref", num: tok.v, gen: a.v };
        }
        return tok.v;
      }
      case "name":
        return { kind: "name", value: tok.v, raw: tok.raw };
      case "str":
        return { kind: "string", bytes: tok.v };
      case "punct":
        if (tok.v === "[") {
          const items: PdfValue[] = [];
          while (true) {
            const p = this.peek();
            if (p.t === "eof") throw new PdfObjectError("pdf-objects/truncated", "unterminated array");
            if (p.t === "punct" && p.v === "]") {
              this.token();
              return items;
            }
            items.push(this.value(depth + 1));
          }
        }
        if (tok.v === "<<") {
          const entries = new Map<string, PdfValue>();
          while (true) {
            const k = this.token();
            if (k.t === "punct" && k.v === ">>") return { kind: "dict", entries };
            if (k.t === "eof") throw new PdfObjectError("pdf-objects/truncated", "unterminated dictionary");
            if (k.t !== "name") continue; // tolerate garbage keys the way viewers do
            const p = this.peek();
            if (p.t === "punct" && p.v === ">>") {
              entries.set(k.v, null);
              continue;
            }
            entries.set(k.v, this.value(depth + 1));
          }
        }
        return null;
      case "kw":
        if (tok.v === "true") return true;
        if (tok.v === "false") return false;
        return null;
      case "eof":
        throw new PdfObjectError("pdf-objects/truncated", "unexpected end of data");
    }
  }
}

interface XrefEntry {
  type: "offset" | "compressed";
  offset: number; // byte offset, or containing object-stream number
  index: number; // generation, or index inside the object stream
}

export interface PdfObjectReaderOptions {
  /** Upper bound on indirect objects materialized; protects against hostile files. */
  maxObjects?: number;
  /** Upper bound on bytes all decoded streams may produce together; stops decompression bombs. */
  maxDecodedBytes?: number;
}

export class PdfObjectReader {
  readonly trailer: PdfDict;
  /** True when the cross-reference data was unusable and objects were located by scanning. */
  readonly recoveredByScan: boolean;
  private readonly xref = new Map<number, XrefEntry>();
  private readonly cache = new Map<number, PdfValue>();
  private readonly objStreams = new Map<number, Map<number, PdfValue>>();
  private readonly resolving = new Set<number>();
  private readonly maxObjects: number;
  private decodedBudget: number;

  constructor(readonly bytes: Uint8Array, options: PdfObjectReaderOptions = {}) {
    this.maxObjects = options.maxObjects ?? 2_000_000;
    this.decodedBudget = options.maxDecodedBytes ?? 256 * 1024 * 1024;
    let trailer: PdfDict | null = null;
    let recovered = false;
    try {
      trailer = this.readXrefChain();
    } catch {
      trailer = null;
    }
    if (!trailer || !trailer.entries.get("Root")) {
      this.xref.clear();
      trailer = this.scanObjects();
      recovered = true;
    }
    this.trailer = trailer;
    this.recoveredByScan = recovered;
  }

  /** Follows references until a direct value is reached. */
  resolve(value: PdfValue | undefined): PdfValue {
    let current: PdfValue | undefined = value;
    for (let hops = 0; current && typeof current === "object" && !Array.isArray(current) && current.kind === "ref"; hops++) {
      if (hops > 32) throw new PdfObjectError("pdf-objects/ref-chain", "reference chain exceeds budget");
      current = this.object(current.num);
    }
    return current ?? null;
  }

  dict(value: PdfValue | undefined): PdfDict | null {
    const v = this.resolve(value);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (v.kind === "dict") return v;
      if (v.kind === "stream") return v.dict;
    }
    return null;
  }

  object(num: number): PdfValue {
    if (this.cache.has(num)) return this.cache.get(num)!;
    if (this.cache.size >= this.maxObjects) throw new PdfObjectError("pdf-objects/budget", "object budget exceeded");
    if (this.resolving.has(num)) throw new PdfObjectError("pdf-objects/cycle", "cyclic object resolution");
    const entry = this.xref.get(num);
    if (!entry) return null;
    this.resolving.add(num);
    try {
      let value: PdfValue = null;
      if (entry.type === "offset") {
        // Free entries (offset -1) are deleted objects and resolve to null.
        value = entry.offset < 0 ? null : (this.readIndirectAt(entry.offset, num) ?? this.readByScan(num));
      } else {
        value = this.objectStream(entry.offset).get(num) ?? null;
      }
      this.cache.set(num, value);
      return value;
    } finally {
      this.resolving.delete(num);
    }
  }

  /** Decodes a stream's data; only filters needed for structure and object streams are supported. */
  decode(stream: PdfStream): Uint8Array {
    const filters = this.asArray(this.resolve(stream.dict.entries.get("Filter")));
    const params = this.asArray(this.resolve(stream.dict.entries.get("DecodeParms")));
    let data = stream.raw;
    filters.forEach((f, i) => {
      const name = f && typeof f === "object" && !Array.isArray(f) && f.kind === "name" ? f.value : null;
      if (name === "FlateDecode" || name === "Fl") {
        data = inflate(data, this.decodedBudget);
        this.decodedBudget -= data.length;
        const p = this.dict(params[i] ?? null);
        if (p) data = applyPredictor(data, p, this);
      } else {
        throw new PdfObjectError("pdf-objects/unsupported-filter", `unsupported stream filter ${name ?? "?"}`);
      }
    });
    return data;
  }

  private asArray(v: PdfValue): PdfValue[] {
    if (v === null) return [];
    return Array.isArray(v) ? v : [v];
  }

  private readXrefChain(): PdfDict {
    const tail = latin1(this.bytes.subarray(Math.max(0, this.bytes.length - 2048)));
    const m = /startxref\s+(\d+)/g;
    let last: RegExpExecArray | null = null;
    for (let r = m.exec(tail); r; r = m.exec(tail)) last = r;
    if (!last) throw new PdfObjectError("pdf-objects/no-startxref", "startxref not found");
    let offset: number | null = Number(last[1]);
    let newest: PdfDict | null = null;
    const seen = new Set<number>();
    while (offset !== null) {
      if (seen.has(offset) || seen.size > 256) break;
      seen.add(offset);
      const trailer = this.readXrefSection(offset);
      newest ??= trailer;
      const stm = trailer.entries.get("XRefStm");
      if (typeof stm === "number" && !seen.has(stm)) {
        seen.add(stm);
        this.readXrefSection(stm);
      }
      const prev = trailer.entries.get("Prev");
      offset = typeof prev === "number" ? prev : null;
    }
    if (!newest) throw new PdfObjectError("pdf-objects/no-trailer", "trailer not found");
    return newest;
  }

  /** Reads one xref table or stream; entries already known from a newer section win. */
  private readXrefSection(offset: number): PdfDict {
    const lexer = new Lexer(this.bytes, offset);
    const first = lexer.next();
    if (first.t === "kw" && first.v === "xref") {
      while (true) {
        const save = lexer.pos;
        const a = lexer.next();
        if (a.t === "kw" && a.v === "trailer") break;
        const b = lexer.next();
        if (a.t !== "num" || b.t !== "num") {
          lexer.pos = save;
          throw new PdfObjectError("pdf-objects/xref", "malformed xref subsection");
        }
        for (let i = 0; i < b.v; i++) {
          const o = lexer.next();
          const g = lexer.next();
          const f = lexer.next();
          if (o.t !== "num" || g.t !== "num" || f.t !== "kw") throw new PdfObjectError("pdf-objects/xref", "malformed xref entry");
          const num = a.v + i;
          if (!this.xref.has(num) && f.v === "n") this.xref.set(num, { type: "offset", offset: o.v, index: g.v });
          // A free entry ('f') in a newer section shadows older ones; record the shadow.
          if (!this.xref.has(num) && f.v === "f") this.xref.set(num, { type: "offset", offset: -1, index: g.v });
        }
      }
      const trailer = new Parser(lexer).value();
      if (!trailer || typeof trailer !== "object" || Array.isArray(trailer) || trailer.kind !== "dict") {
        throw new PdfObjectError("pdf-objects/trailer", "trailer is not a dictionary");
      }
      return trailer;
    }
    // Cross-reference stream: "n g obj << ... >> stream".
    const stream = this.readIndirectAt(offset, null);
    if (!stream || typeof stream !== "object" || Array.isArray(stream) || stream.kind !== "stream") {
      throw new PdfObjectError("pdf-objects/xref", "xref offset does not point at a table or stream");
    }
    const dict = stream.dict;
    const w = this.resolve(dict.entries.get("W"));
    if (!Array.isArray(w) || w.length < 3 || !w.every((x) => typeof x === "number")) {
      throw new PdfObjectError("pdf-objects/xref", "xref stream has no /W");
    }
    const widths = w as number[];
    const size = dict.entries.get("Size");
    const index = this.resolve(dict.entries.get("Index"));
    const ranges = Array.isArray(index) ? (index as number[]) : [0, typeof size === "number" ? size : 0];
    const data = this.decode(stream);
    const rowLen = widths[0] + widths[1] + widths[2];
    if (!widths.every((x) => Number.isInteger(x) && x >= 0 && x <= 8) || rowLen < 1) {
      throw new PdfObjectError("pdf-objects/xref", "xref stream /W is invalid");
    }
    let p = 0;
    for (let r = 0; r + 1 < ranges.length; r += 2) {
      // Each entry consumes a row, so a count beyond the data cannot add entries.
      const count = Math.min(ranges[r + 1], Math.floor((data.length - p) / rowLen));
      for (let i = 0; i < count; i++) {
        if (this.xref.size >= this.maxObjects) throw new PdfObjectError("pdf-objects/budget", "object budget exceeded");
        const type = widths[0] === 0 ? 1 : readInt(data, p, widths[0]);
        const f2 = readInt(data, p + widths[0], widths[1]);
        const f3 = readInt(data, p + widths[0] + widths[1], widths[2]);
        p += rowLen;
        const num = ranges[r] + i;
        if (this.xref.has(num)) continue;
        if (type === 1) this.xref.set(num, { type: "offset", offset: f2, index: f3 });
        else if (type === 2) this.xref.set(num, { type: "compressed", offset: f2, index: f3 });
        else this.xref.set(num, { type: "offset", offset: -1, index: 0 });
      }
    }
    return dict;
  }

  /** Parses "num gen obj value [stream ...]" at a byte offset; returns null if the header does not match. */
  private readIndirectAt(offset: number, expectNum: number | null): PdfValue | null {
    if (offset < 0 || offset >= this.bytes.length) return null;
    const parser = new Parser(new Lexer(this.bytes, offset));
    const n = parser.token();
    const g = parser.token();
    const o = parser.token();
    if (n.t !== "num" || g.t !== "num" || o.t !== "kw" || o.v !== "obj") return null;
    if (expectNum !== null && n.v !== expectNum) return null;
    const value = parser.value();
    const after = parser.peek();
    if (after.t === "kw" && after.v === "stream" && value && typeof value === "object" && !Array.isArray(value) && value.kind === "dict") {
      parser.token();
      return { kind: "stream", dict: value, raw: this.streamBody(parser.position, value) };
    }
    return value;
  }

  private streamBody(afterKeyword: number, dict: PdfDict): Uint8Array {
    const b = this.bytes;
    let start = afterKeyword;
    if (b[start] === 0x0d) start++;
    if (b[start] === 0x0a) start++;
    const lengthValue = dict.entries.get("Length");
    // Avoid recursive resolution while the xref is still being built.
    const length = typeof lengthValue === "number" ? lengthValue : this.safeLength(lengthValue);
    if (length !== null && start + length <= b.length && /^\s*endstream/.test(latin1(b.subarray(start + length, start + length + 32)))) {
      return b.subarray(start, start + length);
    }
    const end = indexOf(b, "endstream", start);
    if (end < 0) throw new PdfObjectError("pdf-objects/truncated", "stream without endstream");
    let stop = end;
    if (b[stop - 1] === 0x0a) stop--;
    if (b[stop - 1] === 0x0d) stop--;
    return b.subarray(start, stop);
  }

  private safeLength(v: PdfValue | undefined): number | null {
    if (!v || typeof v !== "object" || Array.isArray(v) || v.kind !== "ref" || this.resolving.has(v.num) || !this.xref.has(v.num)) return null;
    try {
      const r = this.object(v.num);
      return typeof r === "number" ? r : null;
    } catch {
      return null;
    }
  }

  private objectStream(num: number): Map<number, PdfValue> {
    const cached = this.objStreams.get(num);
    if (cached) return cached;
    const map = new Map<number, PdfValue>();
    this.objStreams.set(num, map);
    const stream = this.object(num);
    if (!stream || typeof stream !== "object" || Array.isArray(stream) || stream.kind !== "stream") return map;
    const n = stream.dict.entries.get("N");
    const first = stream.dict.entries.get("First");
    if (typeof n !== "number" || typeof first !== "number") return map;
    const data = this.decode(stream);
    const header = new Lexer(data, 0);
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) {
      const a = header.next();
      const b = header.next();
      if (a.t !== "num" || b.t !== "num") break;
      pairs.push([a.v, b.v]);
    }
    for (const [objNum, rel] of pairs) {
      try {
        map.set(objNum, new Parser(new Lexer(data, first + rel)).value());
      } catch {
        map.set(objNum, null);
      }
    }
    return map;
  }

  private readByScan(num: number): PdfValue {
    const found = this.scanIndex().get(num);
    return found === undefined ? null : this.readIndirectAt(found, num);
  }

  /** Offsets of the last "num gen obj" header per object, built once instead of a regex pass per object. */
  private scanned?: Map<number, number>;
  private scanIndex(): Map<number, number> {
    if (this.scanned) return this.scanned;
    this.scanned = new Map();
    const re = /(?:^|[\s>])(\d+)\s+\d+\s+obj\b/g;
    const text = this.latinText();
    for (let r = re.exec(text); r; r = re.exec(text)) {
      this.scanned.set(Number(r[1]), r.index + (r[0].length - r[0].trimStart().length));
    }
    return this.scanned;
  }

  private latin?: string;
  private latinText(): string {
    this.latin ??= latin1(this.bytes);
    return this.latin;
  }

  /** Rebuilds the cross-reference table by scanning; the last definition of an object wins. */
  private scanObjects(): PdfDict {
    const text = this.latinText();
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    for (let r = re.exec(text); r; r = re.exec(text)) {
      this.xref.set(Number(r[1]), { type: "offset", offset: r.index, index: Number(r[2]) });
    }
    // Objects inside object streams are not visible to the scan; register them.
    for (const [num] of [...this.xref]) {
      try {
        const v = this.object(num);
        if (v && typeof v === "object" && !Array.isArray(v) && v.kind === "stream" && nameOf(v.dict.entries.get("Type")) === "ObjStm") {
          for (const [inner] of this.objectStream(num)) {
            if (!this.xref.has(inner)) this.xref.set(inner, { type: "compressed", offset: num, index: 0 });
          }
        }
      } catch {
        // unreadable object: leave it unresolved
      }
    }
    const trailerAt = text.lastIndexOf("trailer");
    if (trailerAt >= 0) {
      try {
        const v = new Parser(new Lexer(this.bytes, trailerAt + 7)).value();
        if (v && typeof v === "object" && !Array.isArray(v) && v.kind === "dict" && v.entries.get("Root")) return v;
      } catch {
        // fall through to catalog search
      }
    }
    for (const [num] of this.xref) {
      const d = this.dict({ kind: "ref", num, gen: 0 });
      if (d && nameOf(d.entries.get("Type")) === "Catalog") {
        return { kind: "dict", entries: new Map<string, PdfValue>([["Root", { kind: "ref", num, gen: 0 }]]) };
      }
    }
    throw new PdfObjectError("pdf-objects/no-catalog", "document catalog not found");
  }
}

export function nameOf(v: PdfValue | undefined): string | null {
  return v && typeof v === "object" && !Array.isArray(v) && v.kind === "name" ? v.value : null;
}

export function isRef(v: PdfValue | undefined): v is PdfRef {
  return !!v && typeof v === "object" && !Array.isArray(v) && v.kind === "ref";
}

/** Decodes a PDF text string (UTF-16BE with BOM, UTF-8 with BOM, else PDFDocEncoding approximated as Latin-1). */
export function pdfText(v: PdfValue | undefined): string {
  if (!v || typeof v !== "object" || Array.isArray(v) || v.kind !== "string") return "";
  const b = v.bytes;
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b.subarray(2));
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder().decode(b.subarray(3));
  return latin1(b);
}

const INFLATE_CHUNK = 16 * 1024;

/** Inflates in chunks and stops once the output passes `limit`, so a small stream cannot expand unbounded. */
function inflate(data: Uint8Array, limit: number): Uint8Array {
  const run = (zlib: boolean, input: Uint8Array): Uint8Array => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const onData = (chunk: Uint8Array) => {
      total += chunk.length;
      if (total > limit) throw new PdfObjectError("pdf-objects/budget", "decoded stream budget exceeded");
      chunks.push(chunk);
    };
    const stream = zlib ? new Unzlib(onData) : new Inflate(onData);
    for (let at = 0; at < input.length; at += INFLATE_CHUNK) {
      stream.push(input.subarray(at, at + INFLATE_CHUNK), at + INFLATE_CHUNK >= input.length);
    }
    if (input.length === 0) stream.push(input, true);
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  };
  try {
    return run(true, data);
  } catch (error) {
    if (error instanceof PdfObjectError) throw error;
    // Some producers omit the zlib header or checksum.
    return run(false, data.subarray(data[0] === 0x78 ? 2 : 0));
  }
}

function applyPredictor(data: Uint8Array, params: PdfDict, reader: PdfObjectReader): Uint8Array {
  const num = (k: string, d: number) => {
    const v = reader.resolve(params.entries.get(k));
    return typeof v === "number" ? v : d;
  };
  const predictor = num("Predictor", 1);
  if (predictor < 10) {
    if (predictor === 1) return data;
    throw new PdfObjectError("pdf-objects/unsupported-predictor", `unsupported predictor ${predictor}`);
  }
  const colors = num("Colors", 1);
  const bpc = num("BitsPerComponent", 8);
  const columns = num("Columns", 1);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)];
    const src = r * (rowLen + 1) + 1;
    const dst = r * rowLen;
    for (let i = 0; i < rowLen; i++) {
      const raw = data[src + i];
      const left = i >= bpp ? out[dst + i - bpp] : 0;
      const up = r > 0 ? out[dst - rowLen + i] : 0;
      const upLeft = r > 0 && i >= bpp ? out[dst - rowLen + i - bpp] : 0;
      let v: number;
      switch (type) {
        case 0: v = raw; break;
        case 1: v = raw + left; break;
        case 2: v = raw + up; break;
        case 3: v = raw + ((left + up) >> 1); break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          v = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default:
          throw new PdfObjectError("pdf-objects/predictor", `invalid PNG predictor row type ${type}`);
      }
      out[dst + i] = v & 0xff;
    }
  }
  return out;
}

function readInt(data: Uint8Array, at: number, width: number): number {
  let v = 0;
  for (let i = 0; i < width; i++) v = v * 256 + data[at + i];
  return v;
}

function isHex(c: number | undefined): boolean {
  return c !== undefined && ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66));
}

function hexValue(c: number): number {
  return c <= 0x39 ? c - 0x30 : (c | 0x20) - 0x57;
}

function latin1(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
}

function utf8OrLatin1(b: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return latin1(b);
  }
}

function indexOf(b: Uint8Array, needle: string, from: number): number {
  const first = needle.charCodeAt(0);
  outer: for (let i = from; i <= b.length - needle.length; i++) {
    if (b[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) if (b[i + j] !== needle.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

export type MarkedContentKind = "whitespace" | "xobject" | "drawing";

/**
 * Classifies each MCID-marked sequence of a page's content stream.
 *
 * `whitespace` is reported only when every glyph operand inside the sequence is
 * a single-byte string of spaces shown with a simple (non-Type0) font and
 * nothing else is painted. `xobject` means the sequence paints only through
 * XObjects (`Do`), whose content is not inspected. Anything else, including
 * undecidable cases, is `drawing`.
 */
export function classifyMarkedContent(reader: PdfObjectReader, page: PdfDict): Map<number, MarkedContentKind> {
  const out = new Map<number, MarkedContentKind>();
  const contents = reader.resolve(page.entries.get("Contents"));
  const parts = contents === null ? [] : Array.isArray(contents) ? contents : [contents];
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    const s = reader.resolve(part);
    if (s && typeof s === "object" && !Array.isArray(s) && s.kind === "stream") {
      try {
        chunks.push(reader.decode(s));
      } catch {
        return out; // undecodable content: classify nothing
      }
    }
  }
  const data = new Uint8Array(chunks.reduce((n, c) => n + c.length + 1, 0));
  let at = 0;
  for (const c of chunks) {
    data.set(c, at);
    at += c.length;
    data[at++] = 0x0a;
  }

  const fonts = reader.dict(reader.dict(page.entries.get("Resources"))?.entries.get("Font"));
  const type0 = (name: string) => nameOf(reader.dict(fonts?.entries.get(name))?.entries.get("Subtype")) === "Type0";

  const lexer = new Lexer(data, 0);
  const stack: Array<number | null> = [];
  const operands: Token[] = [];
  let compositeFont = false;
  const rank: Record<MarkedContentKind, number> = { whitespace: 0, xobject: 1, drawing: 2 };
  const mark = (kind: MarkedContentKind) => {
    for (const mcid of stack) {
      if (mcid === null) continue;
      const current = out.get(mcid);
      if (current === undefined || rank[kind] > rank[current]) out.set(mcid, kind);
    }
  };
  let arrayDepth = 0;
  for (let tok = lexer.next(); tok.t !== "eof"; tok = lexer.next()) {
    if (tok.t === "punct") {
      if (tok.v === "[") arrayDepth++;
      else if (tok.v === "]") arrayDepth--;
      if (tok.v === "<<" || tok.v === ">>" || arrayDepth > 0 || tok.v === "]") operands.push(tok);
      continue;
    }
    if (tok.t !== "kw" || arrayDepth > 0) {
      operands.push(tok);
      continue;
    }
    const op = tok.v;
    if (op === "BI") {
      // Inline image: skip to EI and treat as drawing.
      mark("drawing");
      const end = indexOf(data, "EI", lexer.pos);
      lexer.pos = end < 0 ? data.length : end + 2;
    } else if (op === "BDC" || op === "BMC") {
      let mcid: number | null = null;
      if (op === "BDC") {
        for (let i = 0; i < operands.length - 1; i++) {
          const a = operands[i];
          const b = operands[i + 1];
          if (a.t === "name" && a.v === "MCID" && b.t === "num") mcid = b.v;
        }
      }
      stack.push(mcid);
      if (mcid !== null && !out.has(mcid)) out.set(mcid, "whitespace"); // provisional until something is drawn
    } else if (op === "EMC") {
      stack.pop();
    } else if (op === "Tf") {
      const name = operands.find((o) => o.t === "name");
      compositeFont = name?.t === "name" ? type0(name.v) : true;
    } else if (op === "Tj" || op === "TJ" || op === "'" || op === '"') {
      const strings = operands.filter((o): o is Extract<Token, { t: "str" }> => o.t === "str");
      const spaces = !compositeFont && strings.every((s) => s.v.every((b) => b === 0x20));
      mark(spaces ? "whitespace" : "drawing");
    } else if (op === "Do") {
      mark("xobject");
    } else if (op === "sh" || op === "f" || op === "F" || op === "f*" || op === "S" || op === "s" || op === "B" || op === "B*" || op === "b" || op === "b*") {
      mark("drawing");
    }
    operands.length = 0;
  }
  return out;
}
