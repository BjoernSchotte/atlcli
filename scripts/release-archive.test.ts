import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import JSZip from "jszip";
import {
  deterministicTarGz,
  deterministicZip,
  executableEntry,
  releaseTreeDigest,
} from "./release-archive";

describe("deterministic release archives", () => {
  test("creates byte-identical single-file tar.gz archives with executable mode", () => {
    const entry = executableEntry("atlcli", new TextEncoder().encode("binary-fixture"));
    const first = deterministicTarGz(entry);
    const second = deterministicTarGz(entry);
    expect(first).toEqual(second);
    const tar = gunzipSync(first);
    expect(Buffer.from(tar.subarray(0, 6)).toString()).toBe("atlcli");
    expect(Buffer.from(tar.subarray(100, 107)).toString()).toBe("0000755");
    expect(Buffer.from(tar.subarray(512, 526)).toString()).toBe("binary-fixture");
  });

  test("creates byte-identical sorted ZIPs with a stable content-tree digest", async () => {
    const entries = [
      { path: "manifest.json", bytes: new TextEncoder().encode("{}"), mode: 0o644 },
      { path: "assets/main.js", bytes: new TextEncoder().encode("main"), mode: 0o644 },
    ];
    const first = await deterministicZip(entries);
    const second = await deterministicZip([...entries].reverse());
    expect(first).toEqual(second);
    expect(releaseTreeDigest(entries)).toBe(releaseTreeDigest([...entries].reverse()));
    const zip = await JSZip.loadAsync(first);
    expect(Object.keys(zip.files).sort()).toEqual(["assets/main.js", "manifest.json"]);
  });

  test("rejects unsafe or duplicate paths", async () => {
    const fixture = { bytes: new Uint8Array([1]), mode: 0o644 };
    await expect(deterministicZip([{ path: "../escape", ...fixture }])).rejects.toThrow("unsafe");
    await expect(deterministicZip([{ path: "..\\escape", ...fixture }])).rejects.toThrow("unsafe");
    await expect(deterministicZip([{ path: "C:\\escape", ...fixture }])).rejects.toThrow("unsafe");
    await expect(
      deterministicZip([
        { path: "same", ...fixture },
        { path: "same", ...fixture },
      ]),
    ).rejects.toThrow("duplicate");
  });
});
