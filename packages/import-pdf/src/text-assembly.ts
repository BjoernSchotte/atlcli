import type { PdfNormalizedRect, PdfTextCharacterFactV2 } from "./contracts.js";
import { digestPdfCanonical } from "./canonical.js";
import type { PdfTextDirection } from "./text.js";

export const PDF_TEXT_ASSEMBLY_POLICY_REVISION_V2 =
  "atlcli.pdf-text-assembly-policy/2" as const;

const PRESENTATION_LIGATURES = Object.freeze({
  "\ufb00": "ff",
  "\ufb01": "fi",
  "\ufb02": "fl",
  "\ufb03": "ffi",
  "\ufb04": "ffl",
  "\ufb05": "st",
  "\ufb06": "st",
} as const);

/** Neutral-corpus calibrated thresholds. Inputs use page-normalized geometry. */
export const PDF_TEXT_ASSEMBLY_POLICY_V2 = Object.freeze({
  revision: PDF_TEXT_ASSEMBLY_POLICY_REVISION_V2,
  maximumAngleDeltaRadians: 0.12,
  minimumSameLineVerticalOverlap: 0.25,
  sameLineCenterDeltaGlyphFactor: 0.55,
  differentLineCenterDeltaGlyphFactor: 1.2,
  insertSpaceGapGlyphFactor: 0.75,
  noSpaceGapGlyphFactor: 0.35,
  confidence: Object.freeze({
    authored: 1,
    generatedWhitespace: 0.98,
    dehyphenated: 0.99,
    lineJoin: 0.95,
    punctuation: 0.99,
    script: 0.98,
    strongGeometry: 0.9,
    unresolved: 0.25,
  }),
  presentationLigatures: PRESENTATION_LIGATURES,
} as const);

export type PdfTextBoundaryActionV2 =
  | "preserve-explicit-space"
  | "insert-space"
  | "join-line"
  | "dehyphenate"
  | "retain-hyphen"
  | "no-space"
  | "unresolved";

export type PdfTextBoundaryBasisV2 =
  | "literal-whitespace"
  | "generated-whitespace"
  | "text-run"
  | "structure-order"
  | "baseline"
  | "glyph-gap"
  | "script"
  | "punctuation"
  | "hyphen"
  | "actual-text";

export interface PdfTextBoundaryDecisionV2 {
  id: string;
  leftCharacterIndex: number | null;
  rightCharacterIndex: number | null;
  action: PdfTextBoundaryActionV2;
  basis: PdfTextBoundaryBasisV2[];
  confidence: number;
}

export interface PdfTextTransformationV2 {
  id: string;
  action: "expand-presentation-ligature" | "use-actual-text";
  characterIndexes: number[];
  confidence: number;
}

export interface PdfTextAssemblyIssueV2 {
  code: "pdf-import/actual-text-mark-unmapped";
  characterIndexes: number[];
}

export interface PdfTextAssemblyInputV2 {
  /** Opaque evidence ID. Body text is forbidden; only stable identifier characters are accepted. */
  sourceId: string;
  /** Already arranged in the caller's intended logical order. This function never reorders them. */
  characters: readonly PdfTextCharacterFactV2[];
  orderBasis: "structure-order" | "geometry";
  actualText?: string;
  /** Source characters carrying a mark such as a link. */
  markedCharacterIndexes?: readonly number[];
}

export interface PdfTextAssemblyV2 {
  policyRevision: typeof PDF_TEXT_ASSEMBLY_POLICY_REVISION_V2;
  text: string;
  segments: Array<{
    text: string;
    characterIndexes: number[];
    synthesized: boolean;
  }>;
  characterIndexes: number[];
  boundaries: PdfTextBoundaryDecisionV2[];
  transformations: PdfTextTransformationV2[];
  issues: PdfTextAssemblyIssueV2[];
  unresolvedBoundaryCount: number;
  bbox: PdfNormalizedRect | null;
  direction: PdfTextDirection;
  hasUnicodeError: boolean;
  usedActualText: boolean;
}

interface Anchor {
  position: number;
  character: PdfTextCharacterFactV2;
  value: string;
  expanded: boolean;
}

interface GeometryRelation {
  sameLine: boolean | null;
  conflict: boolean;
  gapGlyphFactor: number | null;
}

interface OutputPiece {
  text: string;
  characterIndexes: number[];
  synthesized: boolean;
}

interface SourceAssemblyState {
  pieces: OutputPiece[];
  boundaries: PdfTextBoundaryDecisionV2[];
  transformations: PdfTextTransformationV2[];
}

const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9:._-]*$/iu;
const HARD_HYPHENS = new Set(["-", "\u2010", "\u2011"]);

/** Safe source canonicalization only; it deliberately preserves line feeds and soft hyphens. */
export function canonicalizePdfTextSourceFragmentV2(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t\f\v ]+/gu, " ")
    .replace(/\p{Cc}/gu, (character) => character === "\n" ? "\n" : "")
    .normalize("NFC");
}

function median(values: readonly number[]): number {
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

function unionRects(characters: readonly PdfTextCharacterFactV2[]): PdfNormalizedRect | null {
  const rects = characters.flatMap((character) => character.bbox ? [character.bbox] : []);
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return {
    x: round(left),
    y: round(top),
    width: round(Math.max(0, right - left)),
    height: round(Math.max(0, bottom - top)),
  };
}

function textDirection(value: string): PdfTextDirection {
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

function script(value: string): string {
  if (/\p{Script=Arabic}/u.test(value)) return "arabic";
  if (/\p{Script=Hebrew}/u.test(value)) return "hebrew";
  if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(value)) {
    return "cjk";
  }
  if (/\p{Script=Latin}/u.test(value)) return "latin";
  if (/\p{Script=Cyrillic}/u.test(value)) return "cyrillic";
  if (/\p{Script=Greek}/u.test(value)) return "greek";
  if (/\p{Letter}|\p{Number}/u.test(value)) return "other-word";
  return "non-word";
}

function isWord(value: string): boolean {
  return /[\p{Letter}\p{Number}]/u.test(value);
}

function isCjk(value: string): boolean {
  return script(value) === "cjk";
}

function sameWordScript(left: string, right: string): boolean {
  const leftScript = script(left);
  return leftScript !== "non-word" && leftScript === script(right);
}

function isClosingPunctuation(value: string): boolean {
  return /[\p{Pe}\p{Pf}\p{Po}]$/u.test(value);
}

function isOpeningPunctuation(value: string): boolean {
  return /[\p{Ps}\p{Pi}]$/u.test(value);
}

function expandPresentationLigatures(value: string): { text: string; expanded: boolean } {
  let expanded = false;
  const text = [...value].map((character) => {
    const replacement = PRESENTATION_LIGATURES[character as keyof typeof PRESENTATION_LIGATURES];
    if (replacement === undefined) return character;
    expanded = true;
    return replacement;
  }).join("");
  return { text, expanded };
}

function sourceValue(character: PdfTextCharacterFactV2): { text: string; expanded: boolean } {
  return expandPresentationLigatures(canonicalizePdfTextSourceFragmentV2(character.value));
}

function isWhitespace(value: string): boolean {
  return value.length > 0 && /^\s+$/u.test(value);
}

function isGeneratedHyphen(character: PdfTextCharacterFactV2, value: string): boolean {
  return character.hyphen || value.includes("\u00ad");
}

function isHardHyphen(character: PdfTextCharacterFactV2, value: string): boolean {
  return !character.hyphen && HARD_HYPHENS.has(value);
}

function geometryRelation(
  left: Anchor,
  right: Anchor,
  medianWidth: number,
  medianHeight: number,
): GeometryRelation {
  const leftRect = left.character.bbox;
  const rightRect = right.character.bbox;
  if (!leftRect || !rightRect || medianHeight <= 0) {
    return { sameLine: null, conflict: true, gapGlyphFactor: null };
  }
  if (
    Math.abs(left.character.angleRadians - right.character.angleRadians) >
      PDF_TEXT_ASSEMBLY_POLICY_V2.maximumAngleDeltaRadians
  ) {
    return { sameLine: null, conflict: true, gapGlyphFactor: null };
  }
  const overlap = Math.max(
    0,
    Math.min(leftRect.y + leftRect.height, rightRect.y + rightRect.height) -
      Math.max(leftRect.y, rightRect.y),
  );
  const minimumHeight = Math.min(leftRect.height, rightRect.height);
  const overlapRatio = minimumHeight > 0 ? overlap / minimumHeight : 0;
  const leftCenter = leftRect.y + leftRect.height / 2;
  const rightCenter = rightRect.y + rightRect.height / 2;
  const centerDelta = Math.abs(leftCenter - rightCenter);
  let sameLine: boolean | null = null;
  let conflict = false;
  if (
    overlapRatio >= PDF_TEXT_ASSEMBLY_POLICY_V2.minimumSameLineVerticalOverlap ||
    centerDelta <= medianHeight * PDF_TEXT_ASSEMBLY_POLICY_V2.sameLineCenterDeltaGlyphFactor
  ) {
    sameLine = true;
  } else if (
    centerDelta >= medianHeight * PDF_TEXT_ASSEMBLY_POLICY_V2.differentLineCenterDeltaGlyphFactor
  ) {
    sameLine = false;
  } else {
    conflict = true;
  }
  let gapGlyphFactor: number | null = null;
  if (sameLine && medianWidth > 0) {
    const pairDirection = textDirection(`${left.value}${right.value}`);
    const gap = pairDirection === "rtl"
      ? leftRect.x - (rightRect.x + rightRect.width)
      : rightRect.x - (leftRect.x + leftRect.width);
    gapGlyphFactor = gap / medianWidth;
  }
  return { sameLine, conflict, gapGlyphFactor };
}

function appendPiece(
  pieces: OutputPiece[],
  text: string,
  characterIndexes: readonly number[],
  synthesized: boolean,
): void {
  if (!text) return;
  // Keep source pieces granular enough for downstream link/mark projection.
  // A presentation ligature may expand to multiple output code points, but it
  // still remains one segment tied to its single source character.
  pieces.push({ text, characterIndexes: [...new Set(characterIndexes)], synthesized });
}

function boundaryId(
  sourceId: string,
  ordinal: number,
  left: number | null,
  right: number | null,
  action: PdfTextBoundaryActionV2,
): string {
  return `pdf:boundary:${sourceId}:${String(ordinal).padStart(4, "0")}:${left ?? "x"}-${right ?? "x"}:${action}`;
}

function transformationId(
  sourceId: string,
  ordinal: number,
  action: PdfTextTransformationV2["action"],
): string {
  return `pdf:transform:${sourceId}:${String(ordinal).padStart(4, "0")}:${action}`;
}

function finishSourceAssembly(
  input: PdfTextAssemblyInputV2,
  state: SourceAssemblyState,
): PdfTextAssemblyV2 {
  const segments = state.pieces
    .map((piece) => ({ ...piece, text: piece.text.normalize("NFC") }))
    .filter((piece) => piece.text.length > 0);
  const text = segments.map((segment) => segment.text).join("").normalize("NFC");
  return {
    policyRevision: PDF_TEXT_ASSEMBLY_POLICY_REVISION_V2,
    text,
    segments,
    characterIndexes: [...new Set(input.characters.map((character) => character.index))],
    boundaries: state.boundaries,
    transformations: state.transformations,
    issues: [],
    unresolvedBoundaryCount: state.boundaries.filter((boundary) => boundary.action === "unresolved").length,
    bbox: unionRects(input.characters),
    direction: textDirection(text),
    hasUnicodeError: input.characters.some((character) => character.unicodeMapError),
    usedActualText: false,
  };
}

function assembleSourceCharacters(input: PdfTextAssemblyInputV2): PdfTextAssemblyV2 {
  const anchors: Anchor[] = [];
  for (const [position, character] of input.characters.entries()) {
    const value = sourceValue(character);
    if (!value.text || isWhitespace(value.text) || isGeneratedHyphen(character, value.text)) continue;
    anchors.push({ position, character, value: value.text, expanded: value.expanded });
  }
  const widths = anchors.flatMap((anchor) =>
    anchor.character.bbox && anchor.character.bbox.width > 0 ? [anchor.character.bbox.width] : []
  );
  const heights = anchors.flatMap((anchor) =>
    anchor.character.bbox && anchor.character.bbox.height > 0 ? [anchor.character.bbox.height] : []
  );
  const medianWidth = median(widths);
  const medianHeight = median(heights);
  const state: SourceAssemblyState = { pieces: [], boundaries: [], transformations: [] };

  const addBoundary = (
    left: Anchor,
    right: Anchor,
    action: PdfTextBoundaryActionV2,
    basis: PdfTextBoundaryBasisV2[],
    confidence: number,
  ): void => {
    state.boundaries.push({
      id: boundaryId(
        input.sourceId,
        state.boundaries.length,
        left.character.index,
        right.character.index,
        action,
      ),
      leftCharacterIndex: left.character.index,
      rightCharacterIndex: right.character.index,
      action,
      basis,
      confidence,
    });
  };

  for (const [anchorIndex, anchor] of anchors.entries()) {
    const previous = anchors[anchorIndex - 1];
    if (previous) {
      const between = input.characters.slice(previous.position + 1, anchor.position);
      const betweenValues = between.map((character) => ({
        character,
        value: sourceValue(character).text,
      }));
      const literalWhitespace = betweenValues.filter(({ character, value }) =>
        isWhitespace(value) && !character.generated
      );
      const generatedWhitespace = betweenValues.filter(({ character, value }) =>
        isWhitespace(value) && character.generated
      );
      const generatedHyphens = betweenValues.filter(({ character, value }) =>
        isGeneratedHyphen(character, value)
      );
      const relation = geometryRelation(previous, anchor, medianWidth, medianHeight);
      const textRunChange = previous.character.textRunId !== anchor.character.textRunId;
      const markedContentChange = previous.character.mcid !== anchor.character.mcid;
      const orderedBasis = input.orderBasis === "structure-order" || markedContentChange;
      const wordPair = isWord(previous.value) && isWord(anchor.value);
      const scriptMatch = sameWordScript(previous.value, anchor.value);
      const cjkPair = isCjk(previous.value) && isCjk(anchor.value);
      const punctuationAttachment =
        isOpeningPunctuation(previous.value) || isClosingPunctuation(anchor.value);
      const previousIsHardHyphen = isHardHyphen(previous.character, previous.value);
      const anchorIsHardHyphen = isHardHyphen(anchor.character, anchor.value);

      if (literalWhitespace.length > 0) {
        addBoundary(
          previous,
          anchor,
          "preserve-explicit-space",
          ["literal-whitespace"],
          PDF_TEXT_ASSEMBLY_POLICY_V2.confidence.authored,
        );
        appendPiece(
          state.pieces,
          " ",
          literalWhitespace.map(({ character }) => character.index),
          false,
        );
      } else if (anchorIsHardHyphen) {
        // The authored hyphen itself is emitted below. Its one evidence decision
        // is recorded after the right-hand word becomes available.
      } else if (previousIsHardHyphen) {
        const leftWord = anchors[anchorIndex - 2];
        if (
          leftWord &&
          isWord(leftWord.value) &&
          isWord(anchor.value) &&
          sameWordScript(leftWord.value, anchor.value)
        ) {
          addBoundary(
            leftWord,
            anchor,
            "retain-hyphen",
            ["hyphen", "script"],
            PDF_TEXT_ASSEMBLY_POLICY_V2.confidence.authored,
          );
        }
      } else if (generatedHyphens.length > 0) {
        if (wordPair && scriptMatch && relation.sameLine === false) {
          addBoundary(
            previous,
            anchor,
            "dehyphenate",
            [
              "hyphen",
              ...(orderedBasis ? ["structure-order" as const] : []),
              "baseline",
              "script",
            ],
            PDF_TEXT_ASSEMBLY_POLICY_V2.confidence.dehyphenated,
          );
        } else {
          addBoundary(
            previous,
            anchor,
            "unresolved",
            [
              "hyphen",
              ...(orderedBasis ? ["structure-order" as const] : []),
              "baseline",
              "script",
            ],
            PDF_TEXT_ASSEMBLY_POLICY_V2.confidence.unresolved,
          );
        }
      } else if (punctuationAttachment) {
        addBoundary(
          previous,
          anchor,
          "no-space",
          [
            ...(textRunChange ? ["text-run" as const] : []),
            "punctuation",
            ...(relation.sameLine !== null ? ["baseline" as const] : []),
          ],
          PDF_TEXT_ASSEMBLY_POLICY_V2.confidence.punctuation,
        );
      } else if (generatedWhitespace.length > 0 && relation.sameLine === false) {
        if (wordPair && scriptMatch && !cjkPair) {
          addBoundary(
            previous,
            anchor,
            "join-line",
            ["generated-whitespace", "baseline", "script"],
            PDF_TEXT_ASSEMBLY_POLICY_V2.confidence.lineJoin,
          );
          appendPiece(
            state.pieces,
            " ",
            generatedWhitespace.map(({ character }) => character.index),
            true,
          );
        } else if (cjkPair) {
          addBoundary(
            previous,
            anchor,
            "no-space",
            ["generated-whitespace", "baseline", "script"],
            PDF_TEXT_ASSEMBLY_POLICY_V2.confidence.script,
          );
        } else {
          addBoundary(
            previous,
            anchor,
            "unresolved",
            ["generated-whitespace", "baseline", "script"],
            PDF_TEXT_ASSEMBLY_POLICY_V2.confidence.unresolved,
          );
        }
      } else if (generatedWhitespace.length > 0) {
        if (wordPair && scriptMatch && !cjkPair) {
          addBoundary(
            previous,
            anchor,
            "insert-space",
            [
              "generated-whitespace",
              ...(textRunChange ? ["text-run" as const] : []),
              ...(orderedBasis ? ["structure-order" as const] : []),
              ...(relation.sameLine !== null ? ["baseline" as const] : []),
              ...(relation.gapGlyphFactor !== null ? ["glyph-gap" as const] : []),
            ],
            PDF_TEXT_ASSEMBLY_POLICY_V2.confidence.generatedWhitespace,
          );
          appendPiece(
            state.pieces,
            " ",
            generatedWhitespace.map(({ character }) => character.index),
            true,
          );
        } else {
          addBoundary(
            previous,
            anchor,
            "no-space",
            ["generated-whitespace", ...(cjkPair ? ["script" as const] : [])],
            cjkPair
              ? PDF_TEXT_ASSEMBLY_POLICY_V2.confidence.script
              : PDF_TEXT_ASSEMBLY_POLICY_V2.confidence.strongGeometry,
          );
        }
      } else if (cjkPair && (textRunChange || markedContentChange)) {
        addBoundary(
          previous,
          anchor,
          "no-space",
          ["text-run", "script", ...(relation.sameLine !== null ? ["baseline" as const] : [])],
          PDF_TEXT_ASSEMBLY_POLICY_V2.confidence.script,
        );
      } else if (relation.sameLine === false) {
        if (wordPair && scriptMatch) {
          addBoundary(
            previous,
            anchor,
            "join-line",
            [
              ...(textRunChange ? ["text-run" as const] : []),
              ...(orderedBasis ? ["structure-order" as const] : []),
              "baseline",
              "script",
            ],
            PDF_TEXT_ASSEMBLY_POLICY_V2.confidence.lineJoin,
          );
          appendPiece(state.pieces, " ", [], true);
        } else if (textRunChange || markedContentChange) {
          addBoundary(
            previous,
            anchor,
            "unresolved",
            ["text-run", "baseline", "script"],
            PDF_TEXT_ASSEMBLY_POLICY_V2.confidence.unresolved,
          );
        }
      } else if (relation.conflict && wordPair && (textRunChange || markedContentChange)) {
        addBoundary(
          previous,
          anchor,
          "unresolved",
          [
            ...(textRunChange ? ["text-run" as const] : []),
            ...(orderedBasis ? ["structure-order" as const] : []),
            "baseline",
            "glyph-gap",
            "script",
          ],
          PDF_TEXT_ASSEMBLY_POLICY_V2.confidence.unresolved,
        );
      } else if ((textRunChange || markedContentChange) && wordPair) {
        const gap = relation.gapGlyphFactor;
        if (gap !== null && gap >= PDF_TEXT_ASSEMBLY_POLICY_V2.insertSpaceGapGlyphFactor && scriptMatch) {
          addBoundary(
            previous,
            anchor,
            "insert-space",
            [
              ...(textRunChange ? ["text-run" as const] : []),
              ...(orderedBasis ? ["structure-order" as const] : []),
              "baseline",
              "glyph-gap",
              "script",
            ],
            PDF_TEXT_ASSEMBLY_POLICY_V2.confidence.strongGeometry,
          );
          appendPiece(state.pieces, " ", [], true);
        } else if (gap !== null && gap <= PDF_TEXT_ASSEMBLY_POLICY_V2.noSpaceGapGlyphFactor) {
          addBoundary(
            previous,
            anchor,
            "no-space",
            [
              ...(textRunChange ? ["text-run" as const] : []),
              ...(orderedBasis ? ["structure-order" as const] : []),
              "baseline",
              "glyph-gap",
            ],
            PDF_TEXT_ASSEMBLY_POLICY_V2.confidence.strongGeometry,
          );
        } else {
          addBoundary(
            previous,
            anchor,
            "unresolved",
            [
              ...(textRunChange ? ["text-run" as const] : []),
              ...(orderedBasis ? ["structure-order" as const] : []),
              "baseline",
              "glyph-gap",
              "script",
            ],
            PDF_TEXT_ASSEMBLY_POLICY_V2.confidence.unresolved,
          );
        }
      }
    }

    appendPiece(state.pieces, anchor.value, [anchor.character.index], anchor.expanded);
    if (anchor.expanded) {
      state.transformations.push({
        id: transformationId(
          input.sourceId,
          state.transformations.length,
          "expand-presentation-ligature",
        ),
        action: "expand-presentation-ligature",
        characterIndexes: [anchor.character.index],
        confidence: PDF_TEXT_ASSEMBLY_POLICY_V2.confidence.authored,
      });
    }
  }
  return finishSourceAssembly(input, state);
}

function normalizeActualText(value: string): { text: string; expanded: boolean } {
  const canonical = canonicalizePdfTextSourceFragmentV2(value)
    .replace(/ *\n+ */gu, " ")
    .replace(/ +/gu, " ")
    .trim();
  return expandPresentationLigatures(canonical);
}

function actualTextAssembly(
  input: PdfTextAssemblyInputV2,
  source: PdfTextAssemblyV2,
  actual: { text: string; expanded: boolean },
): PdfTextAssemblyV2 {
  const aligned = actual.text === source.text;
  const transformation: PdfTextTransformationV2 = {
    id: transformationId(input.sourceId, source.transformations.length, "use-actual-text"),
    action: "use-actual-text",
    characterIndexes: aligned ? source.characterIndexes : [],
    confidence: PDF_TEXT_ASSEMBLY_POLICY_V2.confidence.authored,
  };
  if (aligned) {
    const boundaries = source.boundaries.length > 0
      ? source.boundaries.map((boundary, ordinal) => {
          const action = boundary.action === "unresolved"
            ? boundary.basis.includes("hyphen") ? "dehyphenate" : "no-space"
            : boundary.action;
          return {
            ...boundary,
            id: action === boundary.action
              ? boundary.id
              : boundaryId(
                  input.sourceId,
                  ordinal,
                  boundary.leftCharacterIndex,
                  boundary.rightCharacterIndex,
                  action,
                ),
            action,
            basis: [...boundary.basis, ...(
              boundary.basis.includes("actual-text") ? [] : ["actual-text" as const]
            )],
            confidence: PDF_TEXT_ASSEMBLY_POLICY_V2.confidence.authored,
          };
        })
      : [{
          id: boundaryId(input.sourceId, 0, null, null, "no-space"),
          leftCharacterIndex: null,
          rightCharacterIndex: null,
          action: "no-space" as const,
          basis: ["actual-text" as const],
          confidence: PDF_TEXT_ASSEMBLY_POLICY_V2.confidence.authored,
        }];
    return {
      ...source,
      boundaries,
      transformations: [...source.transformations, transformation],
      unresolvedBoundaryCount: 0,
      usedActualText: true,
    };
  }

  const boundaries: PdfTextBoundaryDecisionV2[] = [];
  const words = actual.text.split(" ");
  for (let index = 1; index < words.length; index += 1) {
    boundaries.push({
      id: boundaryId(input.sourceId, boundaries.length, null, null, "preserve-explicit-space"),
      leftCharacterIndex: null,
      rightCharacterIndex: null,
      action: "preserve-explicit-space",
      basis: ["actual-text"],
      confidence: PDF_TEXT_ASSEMBLY_POLICY_V2.confidence.authored,
    });
  }
  const sourceIndexes = new Set(source.characterIndexes);
  const unmappedMarked = [...new Set(input.markedCharacterIndexes ?? [])]
    .filter((index) => sourceIndexes.has(index))
    .sort((left, right) => left - right);
  return {
    ...source,
    text: actual.text,
    segments: actual.text
      ? [{ text: actual.text, characterIndexes: [], synthesized: true }]
      : [],
    boundaries,
    transformations: [
      ...(actual.expanded ? [{
        id: transformationId(
          input.sourceId,
          source.transformations.length,
          "expand-presentation-ligature" as const,
        ),
        action: "expand-presentation-ligature" as const,
        characterIndexes: [],
        confidence: PDF_TEXT_ASSEMBLY_POLICY_V2.confidence.authored,
      }] : []),
      transformation,
    ],
    issues: unmappedMarked.length > 0
      ? [{ code: "pdf-import/actual-text-mark-unmapped", characterIndexes: unmappedMarked }]
      : [],
    unresolvedBoundaryCount: 0,
    direction: textDirection(actual.text),
    usedActualText: true,
  };
}

export function assemblePdfTextV2(input: PdfTextAssemblyInputV2): PdfTextAssemblyV2 {
  if (!SOURCE_ID_PATTERN.test(input.sourceId)) {
    throw new TypeError("PDF text assembly sourceId must be an opaque stable identifier.");
  }
  const indexes = input.characters.map((character) => character.index);
  if (new Set(indexes).size !== indexes.length) {
    throw new TypeError("PDF text assembly character indexes must be unique.");
  }
  const source = assembleSourceCharacters(input);
  if (input.actualText === undefined) return source;
  return actualTextAssembly(input, source, normalizeActualText(input.actualText));
}

export function digestPdfTextAssemblyV2(assembly: PdfTextAssemblyV2): Promise<string> {
  return digestPdfCanonical(assembly);
}
