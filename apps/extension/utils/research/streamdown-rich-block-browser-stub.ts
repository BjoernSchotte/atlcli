import { createElement, type ReactNode } from "react";

/**
 * CSP-safe fallback for Streamdown's optional rich code and Mermaid chunks.
 * ResearchScreen overrides fenced-code rendering, so this module is defensive
 * and must never execute dynamic code or load a remote asset.
 */
export function CodeBlock({
  children,
  code,
}: {
  children?: ReactNode;
  code?: string;
}): ReactNode {
  return createElement("pre", null, createElement("code", null, children ?? code ?? ""));
}

export function Mermaid({ chart }: { chart?: string }): ReactNode {
  return createElement("pre", null, createElement("code", null, chart ?? ""));
}
