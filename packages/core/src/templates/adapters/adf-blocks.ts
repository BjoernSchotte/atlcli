import type { AdfNode } from "./adf.js";

// Control paragraphs ({{#if}}, {{#each}}, … over sibling blocks) arrive in the next commit.
export function renderAdfBlocks<C>(nodes: AdfNode[], ctx: C, render: (n: AdfNode, c: C) => AdfNode): AdfNode[] {
  return nodes.map((n) => render(n, ctx));
}
