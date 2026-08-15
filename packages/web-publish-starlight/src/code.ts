import type { ExportBlock } from "@atlcli/export-blocks";

export interface StarlightCodePresentationV1 {
  language: string;
  languageLabel: string;
  wrap: boolean;
  meta: string;
}

const MAX_LANGUAGE_LENGTH = 64;
const LANGUAGE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  bash: "Bash",
  c: "C",
  css: "CSS",
  go: "Go",
  html: "HTML",
  java: "Java",
  javascript: "JavaScript",
  js: "JavaScript",
  json: "JSON",
  markdown: "Markdown",
  md: "Markdown",
  php: "PHP",
  py: "Python",
  python: "Python",
  rs: "Rust",
  rust: "Rust",
  sh: "Shell",
  shell: "Shell",
  sql: "SQL",
  text: "Text",
  ts: "TypeScript",
  typescript: "TypeScript",
  xml: "XML",
  yaml: "YAML",
  yml: "YAML",
  zsh: "Zsh",
});

function resolvedLanguage(value: string | undefined): string {
  const candidate = value?.trim();
  return candidate !== undefined && candidate.length > 0 && candidate.length <= MAX_LANGUAGE_LENGTH &&
      /^[A-Za-z][A-Za-z0-9+._-]*$/u.test(candidate)
    ? candidate.toLowerCase()
    : "text";
}

function languageLabel(language: string): string {
  return LANGUAGE_LABELS[language] ?? language.replace(/[+._-]+/gu, " ");
}

/**
 * Derive only closed Expressive Code inputs from the normalized model. In
 * particular, title and language never become a meta-string fragment and
 * source content cannot select a plugin, class, callback, or custom CSS.
 */
export function resolveStarlightCodePresentationV1(
  block: Extract<ExportBlock, { type: "codeBlock" }>,
): StarlightCodePresentationV1 {
  const language = resolvedLanguage(block.language);
  const highlightLines = block.highlightLines === undefined
    ? []
    : [...block.highlightLines].sort((left, right) => left - right);
  return Object.freeze({
    language,
    languageLabel: languageLabel(language),
    wrap: block.wrap === true,
    meta: [
      ...(block.wrap === true ? ["wrap"] : []),
      ...(highlightLines.length > 0 ? [`{${highlightLines.join(",")}}`] : []),
    ].join(" "),
  });
}
