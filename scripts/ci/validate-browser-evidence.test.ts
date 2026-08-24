import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import {
  BROWSER_EVIDENCE_SCHEMA,
  SYNTHETIC_ATLASSIAN_HOST_ALLOWLIST,
  buildBrowserEvidenceManifest,
  classifyBrowserEvidencePath,
  validateBrowserEvidence,
  writeBrowserEvidenceManifest,
  type BrowserEvidenceManifest,
  type BrowserEvidenceStatus,
} from "./validate-browser-evidence";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const RUN = { id: "418", attempt: 2 } as const;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "atlcli-browser-evidence-"));
  roots.push(directory);
  return directory;
}

function suite(rootDirectory: string, name = "research"): string {
  const directory = join(rootDirectory, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "junit.xml"), '<testsuites tests="1" failures="0"/>\n');
  writeFileSync(join(directory, "summary.json"), '{"tests":1,"failures":0}\n');
  return directory;
}

async function trace(entries: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(entries)) zip.file(path, content, { createFolders: false });
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

async function failedSuite(rootDirectory: string, name = "jobs"): Promise<string> {
  const directory = suite(rootDirectory, name);
  const failure = join(directory, "failures", "case-01");
  mkdirSync(failure, { recursive: true });
  writeFileSync(join(failure, "trace-1.zip"), await trace({
    "trace.trace": '{"url":"https://fixture.example.test/"}\n',
    "resources/opaque": '{"response":"synthetic"}\n',
  }));
  writeFileSync(join(failure, "screenshot-1.png"), new Uint8Array([137, 80, 78, 71]));
  writeFileSync(join(failure, "video-1.webm"), new Uint8Array([26, 69, 223, 163]));
  writeFileSync(join(failure, "details-1.txt"), "synthetic failure\n");
  return directory;
}

async function writeManifest(directory: string, status: BrowserEvidenceStatus = "passed"): Promise<BrowserEvidenceManifest> {
  return writeBrowserEvidenceManifest(directory, {
    evidenceClass: "synthetic",
    suite: directory.split("/").at(-1)!,
    sha: SHA,
    run: RUN,
    status,
  });
}

function replaceManifest(directory: string, update: (manifest: BrowserEvidenceManifest) => unknown): void {
  const path = join(directory, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as BrowserEvidenceManifest;
  writeFileSync(path, `${JSON.stringify(update(manifest), null, 2)}\n`);
}

function digest(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("browser evidence manifest", () => {
  test("builds and writes an exact synthetic inventory", async () => {
    const rootDirectory = root();
    const directory = suite(rootDirectory);
    const built = await buildBrowserEvidenceManifest(directory, {
      evidenceClass: "synthetic",
      suite: "research",
      sha: SHA,
      run: RUN,
      status: "passed",
    });
    expect(built).toEqual({
      schema: BROWSER_EVIDENCE_SCHEMA,
      evidenceClass: "synthetic",
      suite: "research",
      sha: SHA,
      run: RUN,
      status: "passed",
      files: [
        { path: "junit.xml", kind: "junit", size: 37, sha256: digest('<testsuites tests="1" failures="0"/>\n') },
        { path: "summary.json", kind: "json", size: 25, sha256: digest('{"tests":1,"failures":0}\n') },
      ],
    });
    await writeBrowserEvidenceManifest(directory, built);
    expect(JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"))).toEqual(built);
  });

  test("allows only the documented evidence paths and matching kinds", () => {
    expect(classifyBrowserEvidencePath("junit.xml")).toBe("junit");
    expect(classifyBrowserEvidencePath("report/index.html")).toBe("html");
    expect(classifyBrowserEvidencePath("failures/case-1/trace-2.zip")).toBe("trace");
    expect(() => classifyBrowserEvidencePath("../secret.txt")).toThrow("unsafe");
    expect(() => classifyBrowserEvidencePath("failures/case-1/trace-2.png")).toThrow("mismatched extension");
    expect(() => classifyBrowserEvidencePath("playwright-report/index.html")).toThrow("not allowed");
  });

  test("requires a trace and visual failure proof and forbids it on passed suites", async () => {
    const rootDirectory = root();
    const incomplete = suite(rootDirectory, "worker");
    mkdirSync(join(incomplete, "failures", "case-1"), { recursive: true });
    writeFileSync(join(incomplete, "failures", "case-1", "trace-1.zip"), await trace({ "trace.trace": "safe" }));
    await expect(writeManifest(incomplete, "failed")).rejects.toThrow("missing visual evidence");

    writeFileSync(
      join(incomplete, "failures", "case-1", "screenshot-1.png"),
      new Uint8Array([137, 80, 78, 71]),
    );
    await expect(writeManifest(incomplete, "failed")).resolves.toMatchObject({ status: "failed" });

    const complete = await failedSuite(rootDirectory);
    await expect(writeManifest(complete, "passed")).rejects.toThrow("passed suite must not publish failure evidence");
  });
});

describe("browser evidence validator", () => {
  test("validates multiple suites bound to the expected SHA and run", async () => {
    const rootDirectory = root();
    await writeManifest(suite(rootDirectory, "palette"));
    await writeManifest(await failedSuite(rootDirectory), "failed");

    expect(await validateBrowserEvidence(rootDirectory, { expectedSha: SHA, expectedRun: RUN })).toMatchObject({
      schema: "atlcli.browser-evidence-validation/v1",
      sha: SHA,
      run: RUN,
      suites: [
        { suite: "jobs", status: "failed", files: 6 },
        { suite: "palette", status: "passed", files: 2 },
      ],
      files: 8,
    });
  });

  test("rejects live evidence and mismatched source identities", async () => {
    const rootDirectory = root();
    const directory = suite(rootDirectory);
    await writeManifest(directory);
    replaceManifest(directory, (manifest) => ({ ...manifest, evidenceClass: "live" }));
    await expect(validateBrowserEvidence(rootDirectory)).rejects.toThrow("live browser evidence is forbidden");

    replaceManifest(directory, (manifest) => ({ ...manifest, evidenceClass: "synthetic" }));
    await expect(validateBrowserEvidence(rootDirectory, { expectedSha: "f".repeat(40) })).rejects.toThrow("sha mismatch");
    await expect(validateBrowserEvidence(rootDirectory, { expectedRun: { id: "999", attempt: 1 } })).rejects.toThrow("run mismatch");
    await expect(validateBrowserEvidence(rootDirectory, { expectedSha: "bad" })).rejects.toThrow("expected browser evidence sha is invalid");
  });

  test("rejects extra, missing, changed, and non-portable inventory entries", async () => {
    const extraRoot = root();
    const extra = suite(extraRoot, "extra");
    await writeManifest(extra);
    mkdirSync(join(extra, "report"), { recursive: true });
    writeFileSync(join(extra, "report", "data.json"), "{}\n");
    await expect(validateBrowserEvidence(extraRoot)).rejects.toThrow("inventory does not match");

    const changedRoot = root();
    const changed = suite(changedRoot, "changed");
    await writeManifest(changed);
    writeFileSync(join(changed, "summary.json"), '{"tests":2}\n');
    await expect(validateBrowserEvidence(changedRoot)).rejects.toThrow("size mismatch");

    const duplicateRoot = root();
    const duplicate = suite(duplicateRoot, "duplicate");
    await writeManifest(duplicate);
    replaceManifest(duplicate, (manifest) => ({ ...manifest, files: [...manifest.files, manifest.files[0]] }));
    await expect(validateBrowserEvidence(duplicateRoot)).rejects.toThrow("duplicate path");
  });

  test("rejects filesystem symlinks without following them", async () => {
    const rootDirectory = root();
    const directory = suite(rootDirectory, "worker");
    symlinkSync(join(directory, "summary.json"), join(directory, "report"));
    await expect(buildBrowserEvidenceManifest(directory, {
      evidenceClass: "synthetic",
      suite: "worker",
      sha: SHA,
      run: RUN,
      status: "passed",
    })).rejects.toThrow("symbolic link is forbidden");
  });

  test("enforces configurable per-file, total, and count budgets", async () => {
    const rootDirectory = root();
    await writeManifest(suite(rootDirectory));
    await expect(validateBrowserEvidence(rootDirectory, {
      limits: { maxFileBytes: { junit: 4 } },
    })).rejects.toThrow("junit size limit");
    await expect(validateBrowserEvidence(rootDirectory, {
      limits: { maxTotalBytes: 4 },
    })).rejects.toThrow("total size exceeds limit");
    await expect(validateBrowserEvidence(rootDirectory, {
      limits: { maxFilesPerSuite: 1 },
    })).rejects.toThrow("file count exceeds limit");
  });

  test.each([
    ["authorization-header", "Authorization: Bearer abcdefghijklmnop"],
    ["cookie-header", "Cookie: session=abcdefghijk"],
    ["secret-json-field", '{"apiToken":"abcdefghijk"}'],
    ["openai-api-key", `sk-${"a".repeat(24)}`],
    ["anthropic-api-key", `sk-ant-${"b".repeat(24)}`],
    ["github-token", `ghp_${"c".repeat(24)}`],
    ["aws-access-key", `AKIA${"D".repeat(16)}`],
    ["private-home-path", "/Users/private-user/project/file.ts"],
  ])("rejects %s in textual evidence without exposing the value", async (rule, content) => {
    const rootDirectory = root();
    const directory = suite(rootDirectory);
    writeFileSync(join(directory, "summary.json"), JSON.stringify({ message: content }));
    await writeManifest(directory);
    try {
      await validateBrowserEvidence(rootDirectory);
      throw new Error("expected validation failure");
    } catch (error) {
      expect((error as Error).message).toContain(`rule ${rule}`);
      expect((error as Error).message).not.toContain(content);
    }
  });

  test("permits only the explicitly bound CI workspace path", async () => {
    const rootDirectory = root();
    const directory = await failedSuite(rootDirectory, "research");
    const workspace = "/home/runner/work/atlcli/atlcli";
    writeFileSync(join(directory, "summary.json"), JSON.stringify({ source: `${workspace}/tests/synthetic.ts` }));
    writeFileSync(
      join(directory, "failures", "case-01", "trace-1.zip"),
      await trace({ "trace.trace": JSON.stringify({ source: `${workspace}/tests/synthetic.ts` }) }),
    );
    await writeManifest(directory, "failed");
    await expect(validateBrowserEvidence(rootDirectory, {
      allowedWorkspacePath: workspace,
    })).resolves.toMatchObject({ sha: SHA });

    writeFileSync(join(directory, "summary.json"), JSON.stringify({ source: "/home/private-user/project/file.ts" }));
    await writeManifest(directory, "failed");
    await expect(validateBrowserEvidence(rootDirectory, {
      allowedWorkspacePath: workspace,
    })).rejects.toThrow("rule private-home-path");
  });

  test("allows only the packed suites' explicit synthetic Atlassian hosts", async () => {
    expect(SYNTHETIC_ATLASSIAN_HOST_ALLOWLIST).toEqual([
      "fixture.atlassian.net",
      "foreign.atlassian.net",
      "packed-research.atlassian.net",
      "site.atlassian.net",
      "whiteboard-site.atlassian.net",
    ]);
    const rootDirectory = root();
    const directory = await failedSuite(rootDirectory, "research");
    const urls = SYNTHETIC_ATLASSIAN_HOST_ALLOWLIST.map((host) => `https://${host}/wiki/synthetic`);
    writeFileSync(join(directory, "summary.json"), JSON.stringify({
      urls,
    }));
    writeFileSync(
      join(directory, "failures", "case-01", "trace-1.zip"),
      await trace({ "trace.network": JSON.stringify({ urls }) }),
    );
    await writeManifest(directory, "failed");
    await expect(validateBrowserEvidence(rootDirectory)).resolves.toMatchObject({ sha: SHA });
  });

  test("rejects non-allowlisted Atlassian and Jira hosts without printing them", async () => {
    for (const host of ["tenant.atlassian.net", "tenant.jira.com", "evil.fixture.atlassian.net"]) {
      const rootDirectory = root();
      const directory = suite(rootDirectory);
      writeFileSync(join(directory, "summary.json"), JSON.stringify({ url: `https://${host}/wiki/private` }));
      await writeManifest(directory);
      try {
        await validateBrowserEvidence(rootDirectory);
        throw new Error("expected validation failure");
      } catch (error) {
        expect((error as Error).message).toContain("rule non-synthetic-atlassian-host");
        expect((error as Error).message).not.toContain(host);
      }
    }
  });

  test("scans named and extensionless textual entries inside trace ZIPs", async () => {
    for (const [entry, content] of [
      ["trace.network", "Authorization: Bearer network-secret-value"],
      ["resources/opaque-hash", "Cookie: session=resource-secret-value"],
    ] as const) {
      const rootDirectory = root();
      const directory = await failedSuite(rootDirectory);
      writeFileSync(join(directory, "failures", "case-01", "trace-1.zip"), await trace({ [entry]: content }));
      await writeManifest(directory, "failed");
      try {
        await validateBrowserEvidence(rootDirectory);
        throw new Error("expected validation failure");
      } catch (error) {
        expect((error as Error).message).toContain("sensitive content rule");
        expect((error as Error).message).not.toContain(content);
      }
    }
  });

  test("rejects unsafe and symlink entries inside trace ZIPs", async () => {
    const rootDirectory = root();
    const directory = await failedSuite(rootDirectory);
    const unsafe = new JSZip();
    unsafe.file("../secret.trace", "safe");
    writeFileSync(
      join(directory, "failures", "case-01", "trace-1.zip"),
      await unsafe.generateAsync({ type: "uint8array" }),
    );
    await writeManifest(directory, "failed");
    await expect(validateBrowserEvidence(rootDirectory)).rejects.toThrow(/unsafe archive path|path mismatch/u);
  });
});
