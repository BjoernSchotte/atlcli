import { describe, expect, test } from "bun:test";
import JSZip from "jszip";
import {
  dispatchAndVerifyHomebrewDev,
  GitHubTapApi,
  type TapApi,
} from "./homebrew-dev-dispatch";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const TAG = "dev-20260812.418.2-01234567";
const REQUEST = "31599183166-1-dev-20260812.418.2-01234567";
const METADATA = "a".repeat(64);
const CHECKSUMS = "b".repeat(64);

async function fixtureApi(options: { conclusion?: string; duplicate?: boolean; drift?: boolean; rollbackFromTag?: string } = {}) {
  const pointer = {
    schema: "atlcli.homebrew-dev-pointer/v1" as const,
    sourceRepository: "BjoernSchotte/atlcli",
    tag: TAG,
    sourceSha: SHA,
    formulaVersion: "20260812153245.418.2",
    upstreamHomebrewVersion: "20260812153245.418.2",
    metadataSha256: METADATA,
    checksumsSha256: CHECKSUMS,
    requestId: REQUEST,
    releaseUrl: `https://github.com/BjoernSchotte/atlcli/releases/tag/${TAG}`,
    releasePublishedAt: "2026-08-12T16:00:00Z",
    rollbackFromTag: options.rollbackFromTag ?? null,
    archives: {
      "atlcli-darwin-arm64.tar.gz": "1".repeat(64),
      "atlcli-darwin-x64.tar.gz": "2".repeat(64),
      "atlcli-linux-arm64.tar.gz": "3".repeat(64),
      "atlcli-linux-x64.tar.gz": "4".repeat(64),
    },
  };
  const formula = [
    "class AtlcliDev < Formula",
    'conflicts_with "atlcli"',
    `version "${pointer.formulaVersion}"`,
    ...Object.entries(pointer.archives).flatMap(([name, digest]) => [
      `https://github.com/BjoernSchotte/atlcli/releases/download/${TAG}/${name}`,
      `sha256 "${digest}"`,
    ]),
  ].join("\n");
  const receipt = {
    schema: "atlcli.homebrew-dev-publication/v1",
    commit: "f".repeat(40),
    formulaSha256: new Bun.CryptoHasher("sha256").update(formula).digest("hex"),
    pointer,
  };
  const archive = new JSZip();
  archive.file("homebrew-dev-publication.json", JSON.stringify(receipt));
  let dispatched = false;
  const run = {
    id: 55,
    run_attempt: 1,
    status: "completed",
    conclusion: options.conclusion ?? "success",
    display_title: `atlcli-dev ${REQUEST}`,
    html_url: "https://github.com/BjoernSchotte/homebrew-tap/actions/runs/55",
  };
  const api: TapApi = {
    async dispatch(inputs) {
      expect(inputs.dev_tag).toBe(TAG);
      expect(inputs.rollback_from_tag).toBe(options.rollbackFromTag ?? "");
      dispatched = true;
    },
    async runs() {
      if (!dispatched) return [];
      return options.duplicate ? [run, { ...run, id: 56 }] : [run];
    },
    async artifacts() {
      return [{
        id: 9,
        name: `atlcli-dev-publication-${REQUEST}-55-1`,
        expired: false,
        archive_download_url: "https://api.github.test/artifact",
      }];
    },
    async downloadArtifact() { return archive.generateAsync({ type: "uint8array" }); },
    async content(path) {
      if (path.startsWith("metadata/")) return JSON.stringify(pointer);
      return options.drift ? `${formula}\ndrift` : formula;
    },
  };
  return api;
}

describe("Homebrew dev cross-repository dispatch", () => {
  test("downloads the Actions artifact with GitHub's versioned API media type", async () => {
    const request = Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(url).toBe("https://api.github.test/artifact.zip");
      expect(new Headers(init?.headers).get("Accept")).toBe("application/vnd.github+json");
      expect(init?.redirect).toBe("follow");
      return new Response(new Uint8Array([1, 2, 3]));
    }, { preconnect: () => {} }) as typeof fetch;
    const api = new GitHubTapApi("test-token", request);
    await expect(api.downloadArtifact({
      id: 9,
      name: "receipt",
      expired: false,
      archive_download_url: "https://api.github.test/artifact.zip",
    })).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });

  test("correlates one successful run and verifies its exact committed bytes", async () => {
    const receipt = await dispatchAndVerifyHomebrewDev({
      api: await fixtureApi(),
      tag: TAG,
      sourceSha: SHA,
      requestId: REQUEST,
      metadataSha256: METADATA,
      checksumsSha256: CHECKSUMS,
      pollIntervalMs: 0,
      sleep: async () => {},
    });
    expect(receipt.workflow).toMatchObject({ id: 55, attempt: 1, conclusion: "success" });
    expect(receipt.tapCommit).toBe("f".repeat(40));
  });

  test("passes and verifies the exact current tag as a rollback fence", async () => {
    const rollbackFromTag = "dev-20260811.400.1-89abcdef";
    const receipt = await dispatchAndVerifyHomebrewDev({
      api: await fixtureApi({ rollbackFromTag }),
      tag: TAG,
      sourceSha: SHA,
      requestId: REQUEST,
      metadataSha256: METADATA,
      checksumsSha256: CHECKSUMS,
      rollbackFromTag,
      pollIntervalMs: 0,
      sleep: async () => {},
    });
    expect(receipt.pointer.rollbackFromTag).toBe(rollbackFromTag);
  });

  test("blocks red, ambiguous, and remotely drifted workflows", async () => {
    for (const options of [{ conclusion: "failure" }, { duplicate: true }, { drift: true }]) {
      await expect(dispatchAndVerifyHomebrewDev({
        api: await fixtureApi(options),
        tag: TAG,
        sourceSha: SHA,
        requestId: REQUEST,
        metadataSha256: METADATA,
        checksumsSha256: CHECKSUMS,
        pollIntervalMs: 0,
        sleep: async () => {},
      })).rejects.toThrow();
    }
  });

  test("rejects malformed request identity before dispatch", async () => {
    await expect(dispatchAndVerifyHomebrewDev({
      api: await fixtureApi(),
      tag: TAG,
      sourceSha: SHA,
      requestId: "bad request",
      metadataSha256: METADATA,
      checksumsSha256: CHECKSUMS,
    })).rejects.toThrow("request ID");
  });

  test("rejects a malformed rollback fence before dispatch", async () => {
    await expect(dispatchAndVerifyHomebrewDev({
      api: await fixtureApi(),
      tag: TAG,
      sourceSha: SHA,
      requestId: REQUEST,
      metadataSha256: METADATA,
      checksumsSha256: CHECKSUMS,
      rollbackFromTag: "latest",
    })).rejects.toThrow("rollback fence tag");
  });
});
