import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import { CORE_FIXTURES, generateCoreFixtures } from "../../../specs/pdf-import-quality/fixtures/generate-core.js";
import type { PdfStructureNodeFact } from "./contracts.js";
import { createNodePdfiumFactsAdapter } from "./node.js";

const fixtureRoot = resolve(import.meta.dir, "../../../specs/pdf-import-quality/fixtures");
const manifestPath = resolve(fixtureRoot, "manifest.json");

interface FixtureManifestEntry {
  id: string;
  path: string;
  class: "tagged" | "digital-untagged";
  reproduction: "generated" | "pinned-export";
  criticalNegative: boolean;
  qualityFamilies: string[];
  producer: {
    family: string;
    product: string;
    version: string;
    platform: string;
    options: string;
  };
  authoringSource: string;
  sha256: string;
  bytes: number;
  pages: number;
  expected: {
    orderedBlocks: Array<{ id: string; pageIndex: number; type: string; text: string }>;
    boundaries: Array<{
      id: string;
      pageIndex: number;
      leftCharacterIndex: number;
      rightCharacterIndex: number;
      action: "insert-space" | "join-line" | "dehyphenate" | "retain-hyphen" | "no-space";
      basis: string[];
    }>;
    structureOutcomes: string[];
    ownership: {
      localizedRepairRegions: number;
      unlocalizablePages: number[];
      fallbackPages: number[];
      duplicateCharacterOwners: number;
    };
    safeLinks: string[];
  };
}

interface QualityManifest {
  schema: string;
  license: string;
  provenance: string;
  privacyContract: { allowlistedUrlHosts: string[]; forbiddenMetadata: string[] };
  authoringSources: Array<{ path: string; sha256: string }>;
  fixtures: FixtureManifestEntry[];
}

async function manifest(): Promise<QualityManifest> {
  return JSON.parse(await readFile(manifestPath, "utf8")) as QualityManifest;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function flatten(nodes: readonly PdfStructureNodeFact[]): PdfStructureNodeFact[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

function privacyText(result: Awaited<ReturnType<Awaited<ReturnType<typeof createNodePdfiumFactsAdapter>>["analyze"]>>): string {
  return [
    ...result.facts.pages.flatMap((page) => [
      page.text,
      ...flatten(page.structures).flatMap((node) => [
        node.type,
        node.title,
        node.alt,
        node.actualText,
        node.language,
        node.elementId,
      ]),
      ...page.annotations.flatMap((annotation) => annotation.safeExternalTarget ?? []),
    ]),
    ...result.facts.outline.map((entry) => entry.title),
  ].join("\n");
}

describe("neutral PDF import quality corpus", () => {
  it("pins complete provenance, exact bytes, and a repository-safe privacy boundary", async () => {
    const truth = await manifest();
    expect(truth.schema).toBe("atlcli.import-pdf.quality-fixture/v1");
    expect(truth.license).toBe("Apache-2.0");
    expect(truth.provenance).toContain("Neutral AtlCLI-authored corpus only");
    expect(truth.privacyContract.allowlistedUrlHosts).toEqual(["example.com"]);
    expect(truth.fixtures).toHaveLength(7);
    expect(truth.fixtures.filter((entry) => entry.reproduction === "generated")).toHaveLength(4);
    expect(truth.fixtures.filter((entry) => entry.reproduction === "pinned-export")).toHaveLength(3);
    expect(new Set(truth.fixtures.map((entry) => entry.producer.family))).toEqual(
      new Set(["independent", "word", "libreoffice", "browser"]),
    );

    const committedPdfs = (await readdir(fixtureRoot))
      .filter((name) => name.endsWith(".pdf"))
      .sort();
    expect(committedPdfs).toEqual(truth.fixtures.map((entry) => entry.path).sort());

    for (const source of truth.authoringSources) {
      const bytes = new Uint8Array(await readFile(resolve(fixtureRoot, source.path)));
      expect(source.sha256).toBe(sha256(bytes));
    }

    const textualPaths = [
      "README.md",
      "generate-core.ts",
      "manifest.json",
      "producer-requirements.txt",
      "producer-source.html",
      "producer-source.json",
      "producer-tools.py",
      "update-manifest.ts",
    ];
    const sourceText = (await Promise.all(
      textualPaths.map((path) => readFile(resolve(fixtureRoot, path), "utf8")),
    )).join("\n");
    const prohibitedTerms = (process.env.ATLCLI_FIXTURE_PROHIBITED_TERMS ?? "")
      .split(/[\n,]/u)
      .map((value) => value.trim())
      .filter(Boolean);
    const privacyPatterns = [
      /\/Users\//u,
      /[\w.+-]+@[\w.-]+\.[a-z]{2,}/iu,
      /\.atlassian\.net/iu,
      ...prohibitedTerms.map((term) => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu")),
    ];
    for (const pattern of privacyPatterns) expect(sourceText).not.toMatch(pattern);

    for (const entry of truth.fixtures) {
      expect(entry.id).toMatch(/^[a-z0-9-]+$/u);
      expect(entry.qualityFamilies.length).toBeGreaterThan(0);
      expect(entry.producer.product).not.toBe("");
      expect(entry.producer.version).not.toBe("");
      expect(entry.producer.platform).not.toBe("");
      expect(entry.producer.options).not.toBe("");
      expect(entry.expected.orderedBlocks.length).toBeGreaterThan(0);
      expect(entry.expected.ownership.duplicateCharacterOwners).toBe(0);
      const bytes = new Uint8Array(await readFile(resolve(fixtureRoot, entry.path)));
      expect(entry.sha256).toBe(sha256(bytes));
      expect(entry.bytes).toBe(bytes.byteLength);
      const raw = new TextDecoder("latin1").decode(bytes);
      for (const token of truth.privacyContract.forbiddenMetadata) expect(raw).not.toContain(token);
      for (const pattern of privacyPatterns) expect(raw).not.toMatch(pattern);
    }
  });

  it("regenerates the independent core byte-identically with Bun", async () => {
    const first = generateCoreFixtures();
    const second = generateCoreFixtures();
    expect(Object.keys(first).sort()).toEqual(Object.keys(CORE_FIXTURES).sort());
    for (const [name, bytes] of Object.entries(first)) {
      expect(bytes).toEqual(second[name as keyof typeof second]);
      expect(bytes).toEqual(new Uint8Array(await readFile(resolve(fixtureRoot, name))));
    }
  });

  it("proves the PDFium facts required by every neutral oracle", async () => {
    const truth = await manifest();
    const adapter = await createNodePdfiumFactsAdapter();
    const analyzed = new Map<string, Awaited<ReturnType<typeof adapter.analyze>>>();
    for (const entry of truth.fixtures) {
      const bytes = new Uint8Array(await readFile(resolve(fixtureRoot, entry.path)));
      const result = await adapter.analyze(bytes);
      analyzed.set(entry.id, result);
      expect(result.facts.classification).toBe(entry.class);
      expect(result.facts.pageCount).toBe(entry.pages);
      expect(result.facts.completeness.complete).toBe(true);
      for (const target of entry.expected.safeLinks) {
        expect(result.facts.pages.flatMap((page) => page.annotations)
          .map((annotation) => annotation.safeExternalTarget)).toContain(target);
      }
      for (const boundary of entry.expected.boundaries) {
        const characters = result.facts.pages[boundary.pageIndex]?.characters ?? [];
        const left = characters[boundary.leftCharacterIndex];
        const right = characters[boundary.rightCharacterIndex];
        expect(left?.value).not.toBe("");
        expect(right?.value).not.toBe("");
        const between = characters.slice(boundary.leftCharacterIndex + 1, boundary.rightCharacterIndex);
        if (boundary.action === "insert-space") {
          expect(between.some((character) => character.generated && /\s/u.test(character.value))).toBe(true);
        } else if (boundary.action === "join-line") {
          expect(between.some((character) => character.generated && /[\r\n]/u.test(character.value))).toBe(true);
        } else if (boundary.action === "dehyphenate") {
          expect(between.some((character) => character.hyphen)).toBe(true);
        } else if (boundary.action === "retain-hyphen") {
          expect(between.map((character) => character.value).join("")).toContain("-");
        } else if (boundary.action === "no-space") {
          expect(boundary.rightCharacterIndex).toBe(boundary.leftCharacterIndex + 1);
        }
      }
      const extracted = privacyText(result);
      for (const term of (process.env.ATLCLI_FIXTURE_PROHIBITED_TERMS ?? "").split(/[\n,]/u).filter(Boolean)) {
        expect(extracted).not.toContain(term);
      }
    }

    const fragmented = analyzed.get("tagged-fragmented-boundaries")!;
    const fragmentedNodes = flatten(fragmented.facts.pages[0]!.structures);
    const mixedParagraph = fragmentedNodes.find((node) =>
      node.type === "P" && node.childMcids.join(",") === "1,3" && node.children[0]?.type === "Span"
    );
    expect(mixedParagraph).toBeDefined();
    expect(fragmentedNodes.map((node) => node.actualText)).toEqual(expect.arrayContaining([
      "مرحبا بالميناء",
      "港の信号",
      "oﬃce",
      "German Umlaute: Äpfel, Öl, Ufer.",
    ]));
    expect(fragmented.facts.pages[0]!.characters.filter((character) => character.mcid === null)
      .map((character) => character.value).join(""))
      .toContain("Localized unmarked repair note.");

    const structures = flatten(analyzed.get("tagged-structures-positive")!.facts.pages[0]!.structures);
    expect(structures.map((node) => node.type)).toEqual(expect.arrayContaining([
      "Table", "THead", "TBody", "TFoot", "TR", "TH", "TD", "L", "LI", "LBody", "Figure",
    ]));
    expect(structures.filter((node) => node.type === "Table")).toHaveLength(2);
    expect(structures.find((node) => node.type === "Figure")?.alt).toBe("Neutral outlined harbor marker");

    const negative = flatten(analyzed.get("tagged-structures-negative")!.facts.pages[0]!.structures);
    expect(negative.filter((node) => node.type === "Table")).toHaveLength(2);
    expect(negative.filter((node) => node.type === "L")).toHaveLength(3);

    const untagged = analyzed.get("untagged-fragmented-boundaries")!.facts.pages[0]!;
    expect(untagged.structures).toHaveLength(0);
    expect(untagged.characters.some((character) => character.generated && character.value === "\r")).toBe(true);
    expect(untagged.characters.map((character) => character.value).join("")).toContain("港の信号");

    expect(analyzed.get("producer-word")!.facts.tagged).toBe(false);
    expect(analyzed.get("producer-libreoffice")!.facts.pages[0]!.text).toContain("港の信号は明確です");
    expect(analyzed.get("producer-browser")!.facts.pages[0]!.annotations[0]?.safeExternalTarget)
      .toBe("https://example.com/neutral-harbor");

    const repeatBytes = new Uint8Array(await readFile(resolve(fixtureRoot, "independent-fragmented-tagged.pdf")));
    const repeated = await adapter.analyze(repeatBytes);
    expect(repeated.factsDigest).toBe(fragmented.factsDigest);
  });
});
