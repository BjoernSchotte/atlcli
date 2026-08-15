import { CODE_LANGUAGES, CODE_THEMES } from "./catalogue.generated.js";

export { CODE_LANGUAGES, CODE_THEMES };
export const CODE_THEME_METADATA = CODE_THEMES;

export const CODE_THEME_IDS = CODE_THEMES.map(({ id }) => id);
export type CodeThemeId = (typeof CODE_THEMES)[number]["id"];

export const CODE_LANGUAGE_IDS = CODE_LANGUAGES.map(({ id }) => id);
export type CodeLanguageId = (typeof CODE_LANGUAGES)[number]["id"];

export const DEFAULT_CODE_THEME: CodeThemeId = "github-light";

export interface ResolvedCodeTheme {
  id: CodeThemeId;
  displayName: string;
  type: "dark" | "light";
  foreground: `#${string}`;
  background: `#${string}`;
}

const themeById = new Map(
  CODE_THEMES.map((theme) => [theme.id, theme] as const),
);

const canonicalLanguageById = new Map<string, CodeLanguageId>();
for (const language of CODE_LANGUAGES) {
  canonicalLanguageById.set(language.id, language.id);
  for (const alias of language.aliases) canonicalLanguageById.set(alias, language.id);
}

export class InvalidCodeThemeError extends Error {
  readonly code = "INVALID_CODE_THEME";

  constructor(readonly value: unknown) {
    super(
      `Unknown Shiki code theme ${JSON.stringify(value)}. Choose one of: ${CODE_THEME_IDS.join(", ")}`,
    );
    this.name = "InvalidCodeThemeError";
  }
}

export function isCodeThemeId(value: unknown): value is CodeThemeId {
  return typeof value === "string" && themeById.has(value as CodeThemeId);
}

export function resolveCodeTheme(value?: unknown): ResolvedCodeTheme {
  const id = resolveCodeThemeId(value);
  return themeById.get(id)!;
}

export function resolveCodeThemeId(value?: unknown): CodeThemeId {
  const id = value === undefined ? DEFAULT_CODE_THEME : value;
  if (!isCodeThemeId(id)) throw new InvalidCodeThemeError(id);
  return id;
}

export function canonicalCodeLanguage(value: string): CodeLanguageId | undefined {
  return canonicalLanguageById.get(value.trim().toLowerCase());
}
