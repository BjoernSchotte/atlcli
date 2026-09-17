import { describe, expect, test } from "bun:test";
import { gunzipSync, gzipSync } from "node:zlib";
import JSZip from "jszip";
import { inspectTarGz, inspectSingleBinaryTarGz } from "./verify-release-artifacts.js";
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

  test("roundtrips a deterministic multi-file executable bundle including block boundaries", () => {
    const entries = [
      executableEntry("atlcli", new Uint8Array(513).fill(1)),
      executableEntry("atlcli-confluence-nfs", new TextEncoder().encode("Grüße 🐴")),
      { path: "LICENSE-nfsserve", bytes: new Uint8Array(0), mode: 0o644 },
    ];
    const archive = deterministicTarGz(entries);
    expect(archive).toEqual(deterministicTarGz([...entries].reverse()));
    const inspected = inspectTarGz(archive);
    expect(inspected).toHaveLength(3);
    for (const entry of entries) {
      const actual = inspected.find((file) => file.name === entry.path)!;
      expect(actual.mode).toBe(entry.mode);
      expect(Buffer.from(actual.bytes)).toEqual(Buffer.from(entry.bytes));
    }
    expect(() => inspectSingleBinaryTarGz(archive)).toThrow("exactly one");
    expect(() => deterministicTarGz([entries[0]!, entries[0]!])).toThrow("duplicate");
    expect(() => deterministicTarGz({ ...entries[0]!, path: "../outside" })).toThrow("unsafe");
  });

  test("rejects duplicate TAR records, links, prefixes, truncated bodies and nonzero padding", () => {
    const tar = gunzipSync(deterministicTarGz(executableEntry("atlcli", new Uint8Array([1]))));
    const duplicate = Buffer.concat([tar.subarray(0, 1024), tar.subarray(0, 1024), Buffer.alloc(1024)]);
    expect(() => inspectTarGz(gzipSync(duplicate))).toThrow("duplicate");
    for (const [offset, value, message] of [[156, 50, "regular file"], [345, 65, "prefixes"], [513, 1, "padding"], [1024, 1, "end blocks"]] as const) {
      const bad = Buffer.from(tar);
      bad[offset] = value;
      expect(() => inspectTarGz(gzipSync(bad))).toThrow(message);
    }
    expect(() => inspectTarGz(gzipSync(tar.subarray(0, 1024)))).toThrow();
    const damaged = Buffer.from(tar);
    damaged[0] = 98;
    expect(() => inspectTarGz(gzipSync(damaged))).toThrow("checksum");
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
