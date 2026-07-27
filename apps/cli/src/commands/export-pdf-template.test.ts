import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PDF_CANONICAL_SOURCE_API_V1,
  PDF_CANONICAL_SOURCE_REVISION,
  PDF_TEMPLATE_WRITERS_V1,
  validatePdfOutput,
} from "@atlcli/pdf";
import {
  BUILTIN_PDF_FALLBACK_LABELS,
  BUILTIN_PDF_TEMPLATE_MANIFEST,
  PDF_TEMPLATE_CAPABILITIES_V1,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V1,
  createAtlcliTypstTemplate,
} from "@atlcli/pdf/internal";
import { packTemplate, validateManifest } from "@atlcli/template-pack";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
const PAGE_ID = "99115001";
const PAGE = {
  id: PAGE_ID,
  title: "PDF Template Pack Fixture",
  space: { key: "DOCSY" },
  version: { number: 1, when: "2026-07-27T00:00:00.000Z" },
  ancestors: [],
  history: {
    createdDate: "2026-07-27T00:00:00.000Z",
    createdBy: { accountId: "fixture", displayName: "Fixture Author" },
    lastUpdated: {
      when: "2026-07-27T00:00:00.000Z",
      by: { accountId: "fixture", displayName: "Fixture Author" },
    },
  },
  metadata: { labels: { results: [] }, properties: {} },
  body: {
    storage: {
      value: "<h1>Pack proof</h1><p>Neutral synthetic body.</p>",
      representation: "storage",
    },
  },
  _links: {
    base: "https://example.invalid/wiki",
    webui: `/pages/${PAGE_ID}`,
  },
};

let server: ReturnType<typeof Bun.serve>;
let directory: string;
let packPath: string;
let requestCount = 0;

async function generatedPack(): Promise<Uint8Array> {
  const background = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80"><rect width="120" height="80" fill="#E7F7F2"/><path d="M0 80 L120 0" stroke="#087F5B" stroke-width="8"/></svg>'
  );
  const backgroundSha256 = createHash("sha256")
    .update(background)
    .digest("hex");
  const design = structuredClone(BUILTIN_PDF_TEMPLATE_MANIFEST.design!);
  design.branding.accent = "#087F5B";
  design.tokens.colors.accent = "#087F5B";
  const manifest = validateManifest({
    ...BUILTIN_PDF_TEMPLATE_MANIFEST,
    id: "fixture.cli-green-background",
    name: "CLI green background",
    version: "1.0.0",
    design,
    capabilityCatalog: {
      id: PDF_TEMPLATE_CAPABILITIES_V1.id,
      version: PDF_TEMPLATE_CAPABILITIES_V1.version,
      digest: PDF_TEMPLATE_CAPABILITY_DIGEST_V1,
    },
    canonicalSource: {
      api: PDF_CANONICAL_SOURCE_API_V1,
      revision: PDF_CANONICAL_SOURCE_REVISION,
    },
    assetDescriptors: {
      background: {
        path: `assets/background/${backgroundSha256}.svg`,
        sha256: backgroundSha256,
        mediaType: "image/svg+xml",
        byteLength: background.byteLength,
        dimensions: { width: 120, height: 80, unit: "pixel" },
      },
    },
    assets: {
      "asset.pageBackground": {
        descriptor: "background",
        writer: PDF_TEMPLATE_WRITERS_V1.imageDecoration,
        decorative: true,
      },
    },
    decorations: [
      {
        kind: "image",
        id: "asset.pageBackground",
        writer: PDF_TEMPLATE_WRITERS_V1.imageDecoration,
        scope: "all",
        layer: "page-background",
        asset: "asset.pageBackground",
        placement: {
          relativeTo: "page",
          fit: "stretch",
          x: "0mm",
          y: "0mm",
          width: "210mm",
          height: "297mm",
        },
        decorative: true,
      },
    ],
    provenance: undefined,
  });
  const source = createAtlcliTypstTemplate(
    manifest.design!,
    BUILTIN_PDF_FALLBACK_LABELS,
    {
      assets: {
        "asset.pageBackground": {
          vfsPath: "template-assets/background.svg",
          reference: manifest.assets!["asset.pageBackground"]!,
        },
      },
      decorations: manifest.decorations!,
    },
    { positionedLogo: true }
  );
  return packTemplate({
    manifest,
    files: {
      "atlcli.typ": new TextEncoder().encode(source),
      [manifest.assetDescriptors!.background!.path]: background,
    },
  });
}

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      requestCount += 1;
      const { pathname } = new URL(request.url);
      if (pathname === `/rest/api/content/${PAGE_ID}`) {
        return Response.json(PAGE);
      }
      return new Response(
        JSON.stringify({ message: `No fixture route for ${pathname}` }),
        {
          status: 404,
          headers: { "content-type": "application/json" },
        }
      );
    },
  });
  directory = await mkdtemp(join(tmpdir(), "atlcli-pdf-pack-"));
  packPath = join(directory, "green.wiki-pdf-template");
  await writeFile(packPath, await generatedPack());
});

afterAll(async () => {
  server?.stop(true);
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function runCli(
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(
    [
      process.execPath,
      "--conditions=development",
      "run",
      CLI,
      "wiki",
      "export",
      PAGE_ID,
      "--format",
      "pdf",
      "--base-url",
      server.url.origin,
      "--auth-type",
      "bearer",
      "--allow-http",
      "--exported-at",
      "2026-07-27T00:00:00.000Z",
      "--json",
      ...args,
    ],
    {
      cwd: directory,
      env: {
        ...Bun.env,
        HOME: directory,
        USERPROFILE: directory,
        ATLCLI_API_TOKEN: "synthetic-token",
        ATLCLI_DISABLE_UPDATE_CHECK: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("wiki export --format pdf --template", () => {
  it("rejects an invalid local pack before the first API call", async () => {
    const before = requestCount;
    const result = await runCli([
      "--template",
      join(directory, "missing.wiki-pdf-template"),
      "--output",
      join(directory, "missing.pdf"),
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(
      /PDF template validation failed/
    );
    expect(requestCount).toBe(before);
  }, 30_000);

  it("renders the stored pack design/background while omission stays on Editorial Indigo", async () => {
    const packedOutput = join(directory, "packed.pdf");
    const builtinOutput = join(directory, "builtin.pdf");
    const packed = await runCli([
      "--template",
      packPath,
      "--output",
      packedOutput,
    ]);
    expect(packed.exitCode, packed.stderr).toBe(0);
    const builtin = await runCli(["--output", builtinOutput]);
    expect(builtin.exitCode, builtin.stderr).toBe(0);

    const packedBytes = new Uint8Array(await readFile(packedOutput));
    const builtinBytes = new Uint8Array(await readFile(builtinOutput));
    expect(validatePdfOutput(packedBytes).pageCount).toBeGreaterThanOrEqual(1);
    expect(validatePdfOutput(builtinBytes).pageCount).toBeGreaterThanOrEqual(1);
    expect(createHash("sha256").update(packedBytes).digest("hex")).not.toBe(
      createHash("sha256").update(builtinBytes).digest("hex")
    );
    expect(JSON.parse(packed.stdout).format).toBe("pdf");
    expect(JSON.parse(builtin.stdout).format).toBe("pdf");
  }, 120_000);
});
