export const DOCX_THEME_RESOLUTION_RULE_V1 = {
  id: "atlcli.docx-theme-resolution",
  version: "1",
} as const;

export type DocxFontScriptV1 = "ascii" | "hAnsi" | "eastAsia" | "cs";
export type DocxThemeFontFamilyV1 = "major" | "minor";

export interface DocxThemeFontReferenceV1 {
  family?: string;
  theme?: `${DocxThemeFontFamilyV1}-${DocxFontScriptV1}`;
}

export interface DocxThemeColorReferenceV1 {
  rgb?: string;
  theme?: string;
  /** WordprocessingML byte value, as a number or two hexadecimal digits. */
  tint?: number | string;
  /** WordprocessingML byte value, as a number or two hexadecimal digits. */
  shade?: number | string;
}

export interface DocxThemeDefinitionV1 {
  colors: Readonly<Record<string, string>>;
  colorMapping?: Readonly<Record<string, string>>;
  fonts: {
    major: Partial<Record<DocxFontScriptV1, string>>;
    minor: Partial<Record<DocxFontScriptV1, string>>;
  };
}

const RGB_RE = /^(?:#)?([0-9A-Fa-f]{6})$/;
const BYTE_RE = /^[0-9A-Fa-f]{2}$/;

function canonicalRgb(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = RGB_RE.exec(value);
  return match ? `#${match[1].toUpperCase()}` : undefined;
}

function byte(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 && value <= 255
      ? value
      : undefined;
  }
  return BYTE_RE.test(value) ? Number.parseInt(value, 16) : undefined;
}

function transformChannel(
  channel: number,
  tint: number | undefined,
  shade: number | undefined
): number {
  let result = channel;
  // OOXML tint 00 is white and FF is the unmodified source channel.
  if (tint !== undefined) {
    result = 255 - Math.round(((255 - result) * tint) / 255);
  }
  // OOXML shade 00 is black and FF is the unmodified source channel.
  if (shade !== undefined) {
    result = Math.round((result * shade) / 255);
  }
  return Math.max(0, Math.min(255, result));
}

function schemeSlot(value: string): string {
  const aliases: Readonly<Record<string, string>> = {
    dark1: "dk1",
    dark2: "dk2",
    light1: "lt1",
    light2: "lt2",
    hyperlink: "hlink",
    followedHyperlink: "folHlink",
  };
  return aliases[value] ?? value;
}

function mappingKey(value: string): string {
  const aliases: Readonly<Record<string, string>> = {
    background1: "bg1",
    background2: "bg2",
    text1: "t1",
    text2: "t2",
  };
  return aliases[value] ?? value;
}

/** Resolve theme mapping plus Word tint/shade to canonical #RRGGBB. */
export function resolveDocxThemeColor(
  reference: DocxThemeColorReferenceV1,
  theme: DocxThemeDefinitionV1
): string | undefined {
  const mappedSlot = reference.theme
    ? schemeSlot(
        theme.colorMapping?.[mappingKey(reference.theme)] ?? reference.theme
      )
    : undefined;
  const source =
    canonicalRgb(reference.rgb) ??
    canonicalRgb(mappedSlot ? theme.colors[mappedSlot] : undefined);
  if (!source) return undefined;
  const tint = byte(reference.tint);
  const shade = byte(reference.shade);
  if (
    (reference.tint !== undefined && tint === undefined) ||
    (reference.shade !== undefined && shade === undefined)
  ) {
    return undefined;
  }
  const channels = [
    Number.parseInt(source.slice(1, 3), 16),
    Number.parseInt(source.slice(3, 5), 16),
    Number.parseInt(source.slice(5, 7), 16),
  ].map((channel) => transformChannel(channel, tint, shade));
  return `#${channels
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

/** Resolve a Word font reference independently for each script. */
export function resolveDocxThemeFont(
  reference: DocxThemeFontReferenceV1 | undefined,
  script: DocxFontScriptV1,
  theme: DocxThemeDefinitionV1
): string | undefined {
  if (!reference) return undefined;
  if (reference.family?.trim()) return reference.family.trim();
  if (!reference.theme) return undefined;
  const [family, referenceScript] = reference.theme.split("-");
  if (
    (family !== "major" && family !== "minor") ||
    !["ascii", "hAnsi", "eastAsia", "cs"].includes(referenceScript ?? "")
  ) {
    return undefined;
  }
  const resolvedScript = referenceScript as DocxFontScriptV1;
  return theme.fonts[family]?.[resolvedScript] ?? theme.fonts[family]?.[script];
}

export function canonicalDocxThemeDefinition(
  theme: DocxThemeDefinitionV1
): DocxThemeDefinitionV1 {
  const entries = (value: Readonly<Record<string, string>>) =>
    Object.fromEntries(
      Object.entries(value)
        .map(([key, item]) => [key, canonicalRgb(item) ?? item.trim()])
        .sort(([left], [right]) => left.localeCompare(right))
    );
  const fonts = (family: Partial<Record<DocxFontScriptV1, string>>) =>
    Object.fromEntries(
      Object.entries(family)
        .map(([script, value]) => [script, value.trim()])
        .sort(([left], [right]) => left.localeCompare(right))
    ) as Partial<Record<DocxFontScriptV1, string>>;
  return {
    colors: entries(theme.colors),
    ...(theme.colorMapping
      ? {
          colorMapping: Object.fromEntries(
            Object.entries(theme.colorMapping)
              .map(([key, value]) => [key, value.trim()])
              .sort(([left], [right]) => left.localeCompare(right))
          ),
        }
      : {}),
    fonts: {
      major: fonts(theme.fonts.major),
      minor: fonts(theme.fonts.minor),
    },
  };
}
