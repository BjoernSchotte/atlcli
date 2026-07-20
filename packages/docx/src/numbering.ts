/**
 * Native list numbering allocator (spec 006 G2).
 *
 * Lists are rendered as real Word lists (`w:numPr` + a synthesized
 * `word/numbering.xml`) instead of literal marker runs, so they renumber when
 * edited, respond to template list styles, and expose list structure to screen
 * readers. This is the pure, stateful allocator threaded through
 * {@link import("./serialize.js").SerializeContext} — the established
 * `ImageEmbedder` pattern: the serializer stays a pure string builder while the
 * allocator hands out ids and, after the walk, emits the numbering part.
 *
 * Id ownership (the hard ordering requirement from the PLAN): the allocator's
 * BASE (`abstractNumId`/`numId` maxima) comes from a scan of the template's
 * existing `word/numbering.xml` performed BEFORE body serialization
 * (`inspectNumberingPart`), because {@link acquire} runs DURING serialization —
 * basing ids on a post-render max-scan would hand out ids the body already
 * rendered with.
 *
 * Restart semantics: bullets share ONE `numId` (they never need distinct
 * restart instances), while every ordered list NODE — top-level or nested,
 * including two logically separate `<ol>`s at the same position — gets its own
 * `numId` with a `w:lvlOverride`/`w:startOverride` so each `<ol>` restarts at 1
 * (Confluence's behavior; without it Word numbers document-wide).
 */

/** Word caps the number of `w:num` instances at 2047 per document. */
export const MAX_NUM_INSTANCES = 2047;

/** The maximum `w:ilvl` (9 levels, ilvl 0–8). */
export const MAX_ILVL = 8;

/** The ids the allocator allocates above (parsed from an existing numbering part). */
export interface NumberingBase {
  abstractNumId: number;
  numId: number;
}

/** Nine bullet glyphs (ilvl 0-8), rendered in the Symbol/Wingdings families. */
// Word's list-glyph code points live in the Symbol / Wingdings Private Use Area
// (U+F0B7 = filled bullet in Symbol, U+F0A7 = small square in Wingdings). Built
// from code points so no PUA byte lives literally in this source.
const SYMBOL_BULLET = String.fromCharCode(0xf0b7);
const WINGDINGS_SQUARE = String.fromCharCode(0xf0a7);
const BULLET_LEVELS: { char: string; font: string }[] = [
  { char: SYMBOL_BULLET, font: "Symbol" },
  { char: "o", font: "Courier New" },
  { char: WINGDINGS_SQUARE, font: "Wingdings" },
  { char: SYMBOL_BULLET, font: "Symbol" },
  { char: "o", font: "Courier New" },
  { char: WINGDINGS_SQUARE, font: "Wingdings" },
  { char: SYMBOL_BULLET, font: "Symbol" },
  { char: "o", font: "Courier New" },
  { char: WINGDINGS_SQUARE, font: "Wingdings" },
]

/** The decimal/lowerLetter/lowerRoman cycle for ordered levels (ilvl 0–8). */
const ORDERED_FORMATS = [
  "decimal",
  "lowerLetter",
  "lowerRoman",
  "decimal",
  "lowerLetter",
  "lowerRoman",
  "decimal",
  "lowerLetter",
  "lowerRoman",
];

/** `w:ind` left indent for a level: 720 dxa per level, 360 hanging. */
function levelIndent(ilvl: number): string {
  return `<w:ind w:left="${(ilvl + 1) * 720}" w:hanging="360"/>`;
}

/** The XML pieces a numbering part needs, kept separate so a merge can order them. */
export interface NumberingXml {
  /** All `<w:abstractNum>` definitions (must precede `<w:num>` per schema). */
  abstractNums: string;
  /** All `<w:num>` instances. */
  nums: string;
}

export class NumberingAllocator {
  private readonly base: NumberingBase;
  private readonly bulletAbstractId: number;
  private readonly decimalAbstractId: number;
  private nextNumId: number;
  private bulletNumId: number | null = null;
  private readonly orderedNumIds: number[] = [];
  private lastNumId: number | null = null;
  private used = false;
  private capReached = false;

  constructor(base: NumberingBase) {
    this.base = base;
    this.bulletAbstractId = base.abstractNumId + 1;
    this.decimalAbstractId = base.abstractNumId + 2;
    this.nextNumId = base.numId + 1;
  }

  /** True once at least one list acquired a `numId` (drives the write step). */
  get isUsed(): boolean {
    return this.used;
  }

  /** True when the 2047-instance cap forced a `numId` reuse (drives a report note). */
  get capExceeded(): boolean {
    return this.capReached;
  }

  /**
   * Acquire a `numId` for one list NODE. Bullets share a single instance;
   * every ordered node gets its own so it restarts at 1. Beyond Word's
   * 2047-instance cap the last instance is reused and {@link capExceeded}
   * flips — a valid (if imperfect) file instead of an invalid one.
   */
  acquire(ordered: boolean): number {
    this.used = true;
    if (!ordered) {
      if (this.bulletNumId === null) {
        this.bulletNumId = this.allocNumId();
      }
      return this.bulletNumId;
    }
    const id = this.tryAllocNumId();
    if (id === null) {
      this.capReached = true;
      return this.lastNumId ?? this.bulletNumId ?? this.base.numId;
    }
    this.orderedNumIds.push(id);
    return id;
  }

  /** Allocate the next `numId`, or (at the cap) reuse the last one. */
  private allocNumId(): number {
    const id = this.tryAllocNumId();
    if (id === null) {
      this.capReached = true;
      return this.lastNumId ?? this.base.numId;
    }
    return id;
  }

  private tryAllocNumId(): number | null {
    if (this.nextNumId > MAX_NUM_INSTANCES) return null;
    const id = this.nextNumId++;
    this.lastNumId = id;
    return id;
  }

  /**
   * Emit the numbering XML: one bullet `abstractNum` and one decimal
   * `abstractNum` (each with 9 `w:lvl` entries), plus the `w:num` instances
   * that were acquired. Only meaningful when {@link isUsed}.
   */
  toXml(): NumberingXml {
    const abstractNums = this.bulletAbstractNum() + this.decimalAbstractNum();
    let nums = "";
    if (this.bulletNumId !== null) {
      nums += `<w:num w:numId="${this.bulletNumId}"><w:abstractNumId w:val="${this.bulletAbstractId}"/></w:num>`;
    }
    for (const id of this.orderedNumIds) {
      nums +=
        `<w:num w:numId="${id}"><w:abstractNumId w:val="${this.decimalAbstractId}"/>` +
        `<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`;
    }
    return { abstractNums, nums };
  }

  private bulletAbstractNum(): string {
    let lvls = "";
    for (let ilvl = 0; ilvl <= MAX_ILVL; ilvl++) {
      const { char, font } = BULLET_LEVELS[ilvl];
      lvls +=
        `<w:lvl w:ilvl="${ilvl}">` +
        `<w:start w:val="1"/>` +
        `<w:numFmt w:val="bullet"/>` +
        `<w:lvlText w:val="${char}"/>` +
        `<w:lvlJc w:val="left"/>` +
        `<w:pPr>${levelIndent(ilvl)}</w:pPr>` +
        `<w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:hint="default"/></w:rPr>` +
        `</w:lvl>`;
    }
    return `<w:abstractNum w:abstractNumId="${this.bulletAbstractId}"><w:multiLevelType w:val="hybridMultilevel"/>${lvls}</w:abstractNum>`;
  }

  private decimalAbstractNum(): string {
    let lvls = "";
    for (let ilvl = 0; ilvl <= MAX_ILVL; ilvl++) {
      lvls +=
        `<w:lvl w:ilvl="${ilvl}">` +
        `<w:start w:val="1"/>` +
        `<w:numFmt w:val="${ORDERED_FORMATS[ilvl]}"/>` +
        `<w:lvlText w:val="%${ilvl + 1}."/>` +
        `<w:lvlJc w:val="left"/>` +
        `<w:pPr>${levelIndent(ilvl)}</w:pPr>` +
        `</w:lvl>`;
    }
    return `<w:abstractNum w:abstractNumId="${this.decimalAbstractId}"><w:multiLevelType w:val="hybridMultilevel"/>${lvls}</w:abstractNum>`;
  }
}
