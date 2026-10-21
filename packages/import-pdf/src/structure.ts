import type {
  PdfPageFactsV1,
  PdfPageFactsV2,
  PdfStructureNodeFact,
  PdfStructureNodeFactV2,
} from "./contracts.js";
import { descendantMcids, orderedDescendantMcidsV2 } from "./text.js";

export interface TaggedStructureIndex {
  nodes: PdfStructureNodeFact[];
  mcidOwners: Map<number, string[]>;
  duplicateMcids: Set<number>;
}

export interface TaggedStructureIndexV2 {
  nodes: PdfStructureNodeFactV2[];
  mcidOwners: Map<number, string[]>;
  duplicateMcids: Set<number>;
  unresolvedNodeIds: Set<string>;
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

export function structureChildrenV2(node: PdfStructureNodeFactV2): PdfStructureNodeFactV2[] {
  return node.kids.flatMap((kid) => kid.kind === "element" ? [kid.node] : []);
}

export function flattenStructureV2(
  nodes: readonly PdfStructureNodeFactV2[],
): PdfStructureNodeFactV2[] {
  const result: PdfStructureNodeFactV2[] = [];
  const visit = (node: PdfStructureNodeFactV2): void => {
    result.push(node);
    structureChildrenV2(node).forEach(visit);
  };
  nodes.forEach(visit);
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

function directOwnedMcidsV2(node: PdfStructureNodeFactV2): number[] {
  const usableKids = node.kids.filter((kid) => kid.kind !== "unresolved");
  return usableKids.length > 0
    ? node.kids.flatMap((kid) => kid.kind === "mcid" ? [kid.mcid] : [])
    : node.directMcids;
}

export function indexTaggedStructureV2(page: PdfPageFactsV2): TaggedStructureIndexV2 {
  const nodes = flattenStructureV2(page.structures);
  const owners = new Map<number, string[]>();
  const unresolvedNodeIds = new Set<string>();
  for (const node of nodes) {
    if (node.kids.some((kid) => kid.kind === "unresolved")) unresolvedNodeIds.add(node.id);
    const direct = new Set(directOwnedMcidsV2(node));
    for (const mcid of orderedDescendantMcidsV2(node)) {
      const values = owners.get(mcid) ?? [];
      if (direct.has(mcid)) values.push(node.id);
      owners.set(mcid, values);
    }
  }
  const duplicateMcids = new Set(
    [...owners.entries()].filter(([, values]) => new Set(values).size > 1).map(([mcid]) => mcid),
  );
  return { nodes, mcidOwners: owners, duplicateMcids, unresolvedNodeIds };
}

export function structureRole(node: PdfStructureNodeFact): string {
  return node.type.trim().replace(/^\//u, "");
}

export function structureRoleV2(node: PdfStructureNodeFactV2): string {
  return node.type.trim().replace(/^\//u, "");
}

export function isSemanticContainer(role: string): boolean {
  return new Set(["Document", "Part", "Art", "Sect", "Div", "Span", "Quote"]).has(role);
}
