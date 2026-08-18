import { createHash } from "node:crypto";
import type { PdfFacts, StructureNode } from "./types.ts";

function countRoles(nodes: StructureNode[], counts: Record<string, number>): void {
  for (const node of nodes) {
    if (node.type) counts[node.type] = (counts[node.type] ?? 0) + 1;
    countRoles(node.children, counts);
  }
}

export function semanticSummary(facts: PdfFacts): object {
  const roles: Record<string, number> = {};
  for (const page of facts.pages) countRoles(page.structures, roles);
  return {
    engine: facts.engine,
    version: facts.engineVersion,
    inputSha256: facts.inputSha256,
    pageCount: facts.pageCount,
    tagged: facts.tagged,
    encrypted: facts.encrypted,
    classification: facts.classification,
    pageKinds: facts.pages.map((page) => page.kind),
    text: facts.pages.map((page) => page.text.replace(/\s+/g, " ").trim()),
    charCounts: facts.pages.map((page) => page.characters.length),
    roles,
    mcids: facts.pages.flatMap((page) => page.characters.map((character) => character.mcid).filter((mcid) => mcid >= 0)),
    imageCounts: facts.pages.map((page) => page.images.length),
    annotationCounts: facts.pages.map((page) => page.annotations.length),
    outlines: facts.outlines,
    javascriptActionCount: facts.javascriptActionCount,
    attachmentCount: facts.attachmentCount,
    namedDestinationCount: facts.namedDestinationCount,
    loadError: facts.loadError,
  };
}

export function semanticDigest(facts: PdfFacts): string {
  const serialized = JSON.stringify(semanticSummary(facts));
  return createHash("sha256").update(serialized).digest("hex");
}
