import { describe, expect, it } from "bun:test";

async function source(name: string): Promise<string> {
  return Bun.file(new URL(name, import.meta.url)).text();
}

function between(value: string, start: string, end: string): string {
  const from = value.indexOf(start);
  const to = value.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Could not isolate ${start}.`);
  return value.slice(from, to);
}

describe("ordinary CLI job source wiring", () => {
  it("routes PDF through the shared resolver with both durable source boundaries", async () => {
    const command = await source("./export-pdf.ts");
    const start = command.indexOf(
      "export async function exportPdfAsOrdinaryJob(",
    );
    expect(start).toBeGreaterThanOrEqual(0);
    const ordinary = command.slice(start);

    expect(ordinary).toContain("createConfluencePdfResolveInputV1({");
    expect(ordinary).toContain("createConfluenceSourcePlanSpoolV1(context)");
    expect(ordinary).toContain("createExportTreeBodySpoolV1(context, request.idempotencyKey)");
    expect(ordinary).toContain("resolved.chapterAnchorById,\n          context.signal,");
    expect(ordinary).toContain('stage: "fetch"');
    expect(ordinary).toContain("resolveInput,");
    expect(ordinary).not.toContain("resolveScope(args");
  });

  it("routes DOCX and retained-job replay through the same host policy", async () => {
    const command = await source("./export.ts");
    const ordinary = between(
      command,
      "async function exportDocxAsOrdinaryJob(",
      "\nasync function exportWithTsEngine(",
    );
    const replay = between(
      command,
      "async function executeStoredExportJob(",
      "\nasync function resolvePageId(",
    );

    expect(ordinary).toContain("createConfluenceDocxResolveInputV1({");
    expect(ordinary).toContain("createConfluenceSourcePlanSpoolV1(context)");
    expect(ordinary).toContain("createExportTreeBodySpoolV1(context, request.idempotencyKey)");
    expect(ordinary).toContain("resolved.chapterAnchorById,\n          context.signal,");
    expect(ordinary).toContain('stage: "fetch"');
    expect(ordinary).toContain("resolveInput,");
    expect(ordinary).not.toContain("pdfModule.resolveScope(");
    expect(replay).toContain("exportSourcePolicyFromFlag(");
    expect(replay).toContain("new ConfluenceClient(profile, {");
  });
});
