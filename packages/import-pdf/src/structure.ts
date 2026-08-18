import type { PdfPageFactsV1, PdfStructureNodeFact } from "./contracts.js";
import { descendantMcids } from "./text.js";

export interface TaggedStructureIndex {
  nodes: PdfStructureNodeFact[];
  mcidOwners: Map<number, string[]>;
  duplicateMcids: Set<number>;
}

export function flattenStructure(nodes: readonly PdfStructureNodeFact[]): PdfStructureNodeFact[] {
  const result: PdfStructureNodeFact[] = [];
  const visit = (node: PdfStructureNodeFact): void => {
    result.push(node);
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return result;
}

export function indexTaggedStructure(page: PdfPageFactsV1): TaggedStructureIndex {
  const nodes = flattenStructure(page.structures);
  const owners = new Map<number, string[]>();
  for (const node of nodes) {
    for (const mcid of descendantMcids(node)) {
      const values = owners.get(mcid) ?? [];
      // Containers legitimately repeat descendant MCIDs. Only sibling/leaf
      // claims are ambiguous; ancestor paths are retained for evidence.
      if (node.mcids.includes(mcid) || node.childMcids.includes(mcid)) values.push(node.id);
      owners.set(mcid, values);
    }
  }
  const duplicateMcids = new Set(
    [...owners.entries()].filter(([, values]) => new Set(values).size > 1).map(([mcid]) => mcid),
  );
  return { nodes, mcidOwners: owners, duplicateMcids };
}

export function structureRole(node: PdfStructureNodeFact): string {
  return node.type.trim().replace(/^\//u, "");
}

export function isSemanticContainer(role: string): boolean {
  return new Set(["Document", "Part", "Art", "Sect", "Div", "Span", "Quote"]).has(role);
}
