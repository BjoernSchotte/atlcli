import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePdfFonts, type PdfFontAsset } from "./ensure-fonts.js";

const temporaryDirectories: string[] = [];

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "atlcli-pdf-fonts-"));
  temporaryDirectories.push(path);
  return path;
}

function asset(bytes: Uint8Array): PdfFontAsset {
  return {
    fileName: "Fixture.ttf",
    url: "https://fonts.example/Fixture.ttf",
    sha256: digest(bytes),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ensurePdfFonts", () => {
  it("reuses a checksum-valid cached font without network access", async () => {
    const cacheDir = await temporaryDirectory();
    const bytes = new Uint8Array([1, 2, 3]);
    await writeFile(join(cacheDir, "Fixture.ttf"), bytes);
    let fetches = 0;

    const result = await ensurePdfFonts({
      cacheDir,
      assets: [asset(bytes)],
      fetchImpl: async () => {
        fetches += 1;
        return new Response(null, { status: 500 });
      },
      logger: () => {},
    });

    expect(fetches).toBe(0);
    expect(result.downloaded).toEqual([]);
    expect(result.reused).toEqual(["Fixture.ttf"]);
  });

  it("downloads a missing font and writes only checksum-valid bytes", async () => {
    const cacheDir = await temporaryDirectory();
    const bytes = new Uint8Array([4, 5, 6]);

    const result = await ensurePdfFonts({
      cacheDir,
      assets: [asset(bytes)],
      fetchImpl: async () => new Response(bytes),
      logger: () => {},
    });

    expect(result.downloaded).toEqual(["Fixture.ttf"]);
    expect(await readFile(join(cacheDir, "Fixture.ttf"))).toEqual(Buffer.from(bytes));
  });

  it("rejects a tampered download and never installs it", async () => {
    const cacheDir = await temporaryDirectory();
    const expected = new Uint8Array([7, 8, 9]);
    const tampered = new Uint8Array([9, 8, 7]);

    await expect(
      ensurePdfFonts({
        cacheDir,
        assets: [asset(expected)],
        fetchImpl: async () => new Response(tampered),
        logger: () => {},
      }),
    ).rejects.toThrow("Checksum mismatch for Fixture.ttf");
    expect(await Bun.file(join(cacheDir, "Fixture.ttf")).exists()).toBe(false);
  });
});
