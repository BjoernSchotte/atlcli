import { describe, expect, test } from "bun:test";
import type { ResearchScopeBindingV1, ResearchScopeV1, ResearchSourceReferenceV1 } from "./contracts.js";
import {
  WorkspaceResearchEvidenceStoreV1,
  createResearchEvidenceRecordV1,
  validateResearchEvidenceSpanV1,
} from "./evidence-store.js";
import { createMemoryResearchWorkspace } from "./workspace.js";

const scope: ResearchScopeV1 = {
  siteOrigin: "https://example.atlassian.net",
  jiraProjectKeys: ["ATLCLI"],
  confluenceSpaceKeys: ["DOCSY"],
};

const bindings: ResearchScopeBindingV1[] = [
  {
    schema: "atlcli.research-scope-binding/v1",
    id: "scope-binding:cli:jira:ATLCLI",
    tenantOrigin: scope.siteOrigin,
    product: "jira",
    entityKind: "project",
    entityRef: "scope-key:jira:ATLCLI",
    key: "ATLCLI",
    name: "ATLCLI",
    source: "cli_flag",
    authority: "locked",
  },
  {
    schema: "atlcli.research-scope-binding/v1",
    id: "scope-binding:cli:confluence:DOCSY",
    tenantOrigin: scope.siteOrigin,
    product: "confluence",
    entityKind: "space",
    entityRef: "scope-key:confluence:DOCSY",
    key: "DOCSY",
    name: "DOCSY",
    source: "cli_flag",
    authority: "locked",
  },
];

function source(overrides: Partial<ResearchSourceReferenceV1> = {}): ResearchSourceReferenceV1 {
  return {
    id: "jira:ATLCLI-42",
    product: "jira",
    title: "Evidence fixture",
    url: "https://example.atlassian.net/browse/ATLCLI-42",
    issueKey: "ATLCLI-42",
    projectKey: "ATLCLI",
    updatedAt: "2026-08-01T12:00:00.000Z",
    ...overrides,
  };
}

async function record(input: {
  source?: ResearchSourceReferenceV1;
  text?: string;
  truncated?: boolean;
} = {}) {
  return createResearchEvidenceRecordV1({
    source: input.source ?? source(),
    content: {
      text: input.text ?? "The retained evidence has exact character spans.",
      linkTargets: ["https://example.atlassian.net/wiki/spaces/DOCSY/pages/123"],
      truncated: input.truncated ?? false,
      inputBytes: 48,
    },
    scope,
    scopeBindings: bindings,
    capturedAt: "2026-08-01T12:01:00.000Z",
  });
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("research evidence store", () => {
  test("persists versioned source chunks across a fresh host and validates exact spans", async () => {
    const workspace = createMemoryResearchWorkspace();
    const created = await record();
    const first = new WorkspaceResearchEvidenceStoreV1(workspace);
    await expect(first.put(created.record, created.chunks)).resolves.toMatchObject({
      identity: {
        canonicalId: "https://example.atlassian.net|jira|issue|ATLCLI-42",
      },
      authority: { bindingId: "scope-binding:cli:jira:ATLCLI", authorityClass: "whole_scope" },
      version: { truncated: false },
    });

    const second = new WorkspaceResearchEvidenceStoreV1(workspace);
    const loaded = await second.get(created.record.id);
    const chunks = await second.chunks(created.record.id);
    expect(loaded).toMatchObject({ id: created.record.id, contentChars: created.record.contentChars });
    expect(chunks).toEqual(created.chunks);
    const firstChunk = chunks[0]!;
    await expect(validateResearchEvidenceSpanV1(loaded!, chunks, {
      evidenceId: loaded!.id,
      chunkId: firstChunk.id,
      start: firstChunk.start,
      end: firstChunk.start + 8,
      textHash: await sha256(firstChunk.text.slice(0, 8)),
    })).resolves.toMatchObject({ evidenceId: loaded!.id, chunkId: firstChunk.id, start: 0, end: 8 });
    await expect(validateResearchEvidenceSpanV1(loaded!, chunks, {
      evidenceId: loaded!.id,
      chunkId: firstChunk.id,
      start: firstChunk.start,
      end: firstChunk.start + 8,
      textHash: "0".repeat(64),
    })).rejects.toThrow("does not match its retained text");
  });

  test("uses URL-independent canonical identity and rejects unbound or foreign evidence", async () => {
    const original = await record();
    const movedDisplayUrl = await record({ source: source({ url: "https://example.atlassian.net/browse/ATLCLI-42?view=detail" }) });
    expect(movedDisplayUrl.record.id).toBe(original.record.id);
    expect(movedDisplayUrl.record.identity).toEqual(original.record.identity);
    const newerVersion = await record({ source: source({ updatedAt: "2026-08-02T12:00:00.000Z" }) });
    expect(newerVersion.record.id).not.toBe(original.record.id);
    expect(newerVersion.record.identity).toEqual(original.record.identity);

    await expect(createResearchEvidenceRecordV1({
      source: source({ projectKey: "OTHER" }),
      content: { text: "not allowed", linkTargets: [], truncated: false, inputBytes: 11 },
      scope,
      scopeBindings: bindings,
      capturedAt: "2026-08-01T12:01:00.000Z",
    })).rejects.toThrow("outside the approved research scope");
    await expect(createResearchEvidenceRecordV1({
      source: source(),
      content: { text: "missing binding", linkTargets: [], truncated: false, inputBytes: 15 },
      scope,
      scopeBindings: [],
      capturedAt: "2026-08-01T12:01:00.000Z",
    })).rejects.toThrow("no approved scope binding");
    await expect(createResearchEvidenceRecordV1({
      source: source({ url: "https://other.atlassian.net/browse/ATLCLI-42" }),
      content: { text: "foreign tenant", linkTargets: [], truncated: false, inputBytes: 14 },
      scope,
      scopeBindings: bindings,
      capturedAt: "2026-08-01T12:01:00.000Z",
    })).rejects.toThrow("outside its tenant");
  });

  test("rejects caller-supplied chunk text or hashes that do not match the retained projection", async () => {
    const created = await record();
    const store = new WorkspaceResearchEvidenceStoreV1(createMemoryResearchWorkspace());
    const tampered = created.chunks.map((chunk, index) => index === 0
      ? { ...chunk, textHash: "f".repeat(64) }
      : chunk);
    await expect(store.put(created.record, tampered)).rejects.toThrow("Evidence chunk hash does not match");
  });

  test("retains the prior complete evidence index after an interrupted publication", async () => {
    const durableWorkspace = createMemoryResearchWorkspace();
    let indexWrites = 0;
    const interruptedWorkspace = {
      readFile: (path: string) => durableWorkspace.readFile(path),
      async writeFile(path: string, contents: string) {
        if (path === "/.atlcli/evidence/v1/index.json" && indexWrites++ > 0) {
          throw new Error("injected evidence index interruption");
        }
        await durableWorkspace.writeFile(path, contents);
      },
      remove: (path: string) => durableWorkspace.remove(path),
      list: (prefix?: string) => durableWorkspace.list(prefix),
    };
    const firstRecord = await record();
    const secondRecord = await record({ text: "A later version should not become visible after a failed publish." });
    const writer = new WorkspaceResearchEvidenceStoreV1(interruptedWorkspace);
    await writer.put(firstRecord.record, firstRecord.chunks);
    await expect(writer.put(secondRecord.record, secondRecord.chunks)).rejects.toThrow("injected evidence index interruption");

    const recovered = new WorkspaceResearchEvidenceStoreV1(durableWorkspace);
    await expect(recovered.get(firstRecord.record.id)).resolves.toMatchObject({ id: firstRecord.record.id });
    await expect(recovered.get(secondRecord.record.id)).resolves.toBeUndefined();
  });

  test("releases all chunks when a retained evidence version is removed", async () => {
    const workspace = createMemoryResearchWorkspace();
    const created = await record({ text: "Deletion must release the private evidence chunks." });
    const store = new WorkspaceResearchEvidenceStoreV1(workspace);
    await store.put(created.record, created.chunks);
    await expect(store.remove(created.record.id)).resolves.toBe(true);
    await expect(store.get(created.record.id)).resolves.toBeUndefined();
    expect(await workspace.list("/.atlcli/evidence/v1/chunks")).toEqual([]);
  });
});
