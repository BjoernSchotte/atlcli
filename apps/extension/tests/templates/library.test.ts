/**
 * The IndexedDB {@link idbTemplateLibrary} adapter (spec 010 T5.2).
 *
 * Runs against `fake-indexeddb` — a spec-complete in-memory IndexedDB with real
 * transactions, indexes and key-path evaluation — so the `recordKey` primary-key
 * semantics under test (a `put()` on the primary key REPLACES the row) are the
 * real ones, not a map stand-in.
 *
 * What is deliberately NOT tested here: the pure `resolveTemplate` itself, which
 * folder 007 already unit-tests in `packages/core/src/template-library.test.ts`.
 * These tests cover the adapter's *wiring* of it — above all the
 * `recordKey` / `templateId` split, which is the whole reason a global entry and
 * its space-scoped override can coexist instead of overwriting each other.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { buildDocx, para } from "@atlcli/docx/fixtures";
import { TemplateIntegrityError } from "@atlcli/core";
import { idbTemplateLibrary } from "../../utils/templates/library.js";
import {
  listTemplates,
  putTemplate,
  UNKNOWN_SITE_ORIGIN,
  type StoredTemplateRecord,
} from "../../utils/docx/template-store.js";
import { seedLegacyV1 } from "../docx/seed-v1.js";

const SITE_A = "https://tenant-a.atlassian.net";
const SITE_B = "https://tenant-b.atlassian.net";
const FIXED_DOCX_DATE = new Date("2020-01-01T00:00:00.000Z");

let factory: IDBFactory;

beforeEach(() => {
  factory = new IDBFactory();
});

function bytesFor(text: string): ArrayBuffer {
  const b = buildDocx({
    body: para(text) + para("$scroll.content"),
    date: FIXED_DOCX_DATE,
  });
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

function libraryFor(siteOrigin = SITE_A) {
  return idbTemplateLibrary({ factory, siteOrigin });
}

/**
 * Run the real v1 → v2 migration with **no resolvable session origin**, which
 * is the only way an {@link UNKNOWN_SITE_ORIGIN} record ever comes into
 * existence. `libraryFor(undefined)` cannot do this — the default parameter
 * turns `undefined` back into `SITE_A`, which is exactly how the previous
 * version of the sentinel test managed to never touch a sentinel at all.
 */
async function migrateSentinelRecord(name: string, body: string): Promise<StoredTemplateRecord> {
  await seedLegacyV1(factory, { name, buffer: bytesFor(body), uploadedAt: 1_700_000_000_000 });
  const rows = await listTemplates(factory);
  const migrated = rows.find((r) => r.name === name);
  if (!migrated) throw new Error("v1 seed did not migrate");
  // Guard the fixture itself: if this is not the sentinel, the tests below are
  // not testing what they claim to.
  if (migrated.siteOrigin !== UNKNOWN_SITE_ORIGIN) {
    throw new Error(`expected the ${UNKNOWN_SITE_ORIGIN} sentinel, got ${migrated.siteOrigin}`);
  }
  return migrated;
}

describe("idbTemplateLibrary — listing", () => {
  it("filters by engine, never resolving a wrong-engine entry", async () => {
    const library = libraryFor();
    await library.add({ name: "word.docx", bytes: bytesFor("$scroll.title"), engine: "docx" });
    await library.add({ name: "paper.typ", bytes: bytesFor("$scroll.title"), engine: "typst" });

    expect((await library.list("docx")).map((e) => e.displayName)).toEqual(["word.docx"]);
    expect((await library.list("typst")).map((e) => e.displayName)).toEqual(["paper.typ"]);
  });

  it("lists globals plus the requested space's overrides, never another space's", async () => {
    const library = libraryFor();
    await library.add({ name: "global.docx", bytes: bytesFor("g") });
    await library.add({
      name: "docsy.docx",
      bytes: bytesFor("d"),
      scope: "space",
      spaceKey: "DOCSY",
    });
    await library.add({
      name: "other.docx",
      bytes: bytesFor("o"),
      scope: "space",
      spaceKey: "OTHER",
    });

    const docsy = await library.list("docx", "DOCSY");
    expect(docsy.map((e) => e.displayName).sort()).toEqual(["docsy.docx", "global.docx"]);
    expect(docsy.find((e) => e.displayName === "docsy.docx")!.scope).toBe("space");

    // No space requested → the whole catalog (the port allows a superset).
    expect(await library.list("docx")).toHaveLength(3);
  });

  it("rejects a space-scoped upload without a space key", async () => {
    await expect(
      libraryFor().add({ name: "x.docx", bytes: bytesFor("x"), scope: "space" })
    ).rejects.toThrow("needs a spaceKey");
  });
});

describe("idbTemplateLibrary — recordKey / templateId split", () => {
  it("keeps a global entry and its space override as two rows and resolves the space one", async () => {
    const library = libraryFor();
    const global = await library.add({ name: "handbook.docx", bytes: bytesFor("global body") });
    const override = await library.assignToSpace(global, "DOCSY");

    // Same LOGICAL id — that is what makes them "the same template" to
    // `resolveTemplate`.
    expect(override.id).toBe(global.id);
    // Distinct PHYSICAL keys — that is what keeps the put() from replacing the
    // global row. With `keyPath: "id"` the second insert would have overwritten
    // the first and "space beats global" could never be exercised.
    expect(override.recordKey).not.toBe(global.recordKey);
    expect(global.recordKey).toBe(`${SITE_A}|docx|${global.id}|global`);
    expect(override.recordKey).toBe(`${SITE_A}|docx|${global.id}|space|DOCSY`);

    // Both rows really are in the store simultaneously.
    const rows = await listTemplates(factory, { siteOrigin: SITE_A });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.templateId))).toEqual(new Set([global.id]));

    // The shared resolver picks the space entry for DOCSY…
    const inSpace = await library.resolve(global.id, "docx", "DOCSY");
    expect(inSpace!.scope).toBe("space");
    expect(inSpace!.recordKey).toBe(override.recordKey);

    // …and the global one everywhere else.
    const elsewhere = await library.resolve(global.id, "docx", "OTHER");
    expect(elsewhere!.scope).toBe("global");
    expect(elsewhere!.recordKey).toBe(global.recordKey);
  });

  it("leaves the global entry resolvable after the space override is deleted", async () => {
    const library = libraryFor();
    const global = await library.add({ name: "handbook.docx", bytes: bytesFor("global body") });
    const override = await library.assignToSpace(global, "DOCSY");

    expect((await library.resolve(global.id, "docx", "DOCSY"))!.scope).toBe("space");

    await library.remove(override.recordKey);

    // Falls back — "assign to space" never mutated the global row's scope.
    const fallback = await library.resolve(global.id, "docx", "DOCSY");
    expect(fallback).toBeDefined();
    expect(fallback!.scope).toBe("global");
    expect(fallback!.recordKey).toBe(global.recordKey);
    expect(await listTemplates(factory, { siteOrigin: SITE_A })).toHaveLength(1);
  });

  it("keeps two sites that share a space key completely independent", async () => {
    const a = libraryFor(SITE_A);
    const b = libraryFor(SITE_B);

    // Same logical templateId AND the same space key on two different sites —
    // the classic staging/prod-both-use-DOCSY collision.
    const sharedId = "com.mayflower.handbook";
    await a.add({
      name: "prod.docx",
      bytes: bytesFor("prod"),
      templateId: sharedId,
      scope: "space",
      spaceKey: "DOCSY",
    });
    await b.add({
      name: "staging.docx",
      bytes: bytesFor("staging"),
      templateId: sharedId,
      scope: "space",
      spaceKey: "DOCSY",
    });

    // Two physically distinct rows, distinguished only by the site prefix.
    const rows = await listTemplates(factory);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.recordKey).sort()).toEqual(
      [
        `${SITE_A}|docx|${sharedId}|space|DOCSY`,
        `${SITE_B}|docx|${sharedId}|space|DOCSY`,
      ].sort()
    );

    // Each site sees only its own — no conflict error, no bleed-through.
    expect((await a.list("docx", "DOCSY")).map((e) => e.displayName)).toEqual(["prod.docx"]);
    expect((await b.list("docx", "DOCSY")).map((e) => e.displayName)).toEqual(["staging.docx"]);
    expect((await a.resolve(sharedId, "docx", "DOCSY"))!.displayName).toBe("prod.docx");
    expect((await b.resolve(sharedId, "docx", "DOCSY"))!.displayName).toBe("staging.docx");
  });
});

describe("idbTemplateLibrary — getBytes integrity", () => {
  it("returns the stored bytes when they still match the entry's sha256", async () => {
    const library = libraryFor();
    const source = bytesFor("$scroll.title");
    const entry = await library.add({ name: "ok.docx", bytes: source });

    const bytes = await library.getBytes(entry);
    expect(bytes).toEqual(new Uint8Array(source));
  });

  it("throws a hard integrity error when the stored bytes were modified", async () => {
    const library = libraryFor();
    const entry = await library.add({ name: "tampered.docx", bytes: bytesFor("original") });

    // Rewrite the row's bytes behind the library's back, keeping the recorded
    // sha256 — exactly what a corrupted / externally-modified store looks like.
    const [row] = await listTemplates(factory, { siteOrigin: SITE_A });
    const swapped = bytesFor("tampered-with-different-content-entirely");
    await putTemplate({ ...row, bytes: swapped, size: swapped.byteLength }, factory);

    const failure = library.getBytes({ ...entry, size: swapped.byteLength });
    await expect(failure).rejects.toThrow(TemplateIntegrityError);
    // The message is the user-facing instruction, not a silent fallback.
    await expect(failure).rejects.toThrow("template was modified, re-upload");
  });

  it("throws on a declared-size disagreement before hashing", async () => {
    const library = libraryFor();
    const entry = await library.add({ name: "short.docx", bytes: bytesFor("size check") });

    await expect(library.getBytes({ ...entry, size: entry.size + 1 })).rejects.toThrow(
      TemplateIntegrityError
    );
  });

  it("errors instead of falling back when the entry is gone from the store", async () => {
    const library = libraryFor();
    const entry = await library.add({ name: "deleted.docx", bytes: bytesFor("gone") });
    await library.remove(entry.recordKey);

    await expect(library.getBytes(entry)).rejects.toThrow("no longer in the library");
  });
});

describe("idbTemplateLibrary — prefs", () => {
  it("persists the active selection per site, engine and space", async () => {
    const a = libraryFor(SITE_A);
    const b = libraryFor(SITE_B);
    const entry = await a.add({ name: "active.docx", bytes: bytesFor("a") });

    await a.setActiveTemplateId("docx", "DOCSY", entry.id);
    expect(await a.getActiveTemplateId("docx", "DOCSY")).toBe(entry.id);
    // Another site's selection is untouched by ours.
    expect(await b.getActiveTemplateId("docx", "DOCSY")).toBeUndefined();
    // Another engine's too.
    expect(await a.getActiveTemplateId("typst", "DOCSY")).toBeUndefined();
  });

  it("falls back to the space-agnostic selection in a space that has none", async () => {
    const library = libraryFor();
    const entry = await library.add({ name: "default.docx", bytes: bytesFor("d") });
    await library.setActiveTemplateId("docx", undefined, entry.id);

    expect(await library.getActiveTemplateId("docx", "ANY")).toBe(entry.id);
  });

  it("stores settings-form values per logical templateId alongside the selection", async () => {
    const library = libraryFor();
    const one = await library.add({ name: "one.docx", bytes: bytesFor("1") });
    const two = await library.add({ name: "two.docx", bytes: bytesFor("2") });

    await library.setActiveTemplateId("docx", "DOCSY", one.id);
    await library.writeSettings("docx", "DOCSY", one.id, { watermark: "DRAFT", cover: true });
    await library.writeSettings("docx", "DOCSY", two.id, { watermark: null, cover: false });

    expect(await library.readSettings("docx", "DOCSY", one.id)).toEqual({
      watermark: "DRAFT",
      cover: true,
    });
    expect(await library.readSettings("docx", "DOCSY", two.id)).toEqual({
      watermark: null,
      cover: false,
    });
    // Writing settings does not clobber the active selection stored in the same record.
    expect(await library.getActiveTemplateId("docx", "DOCSY")).toBe(one.id);
    // Unknown template → empty values, never undefined.
    expect(await library.readSettings("docx", "DOCSY", "nope")).toEqual({});
  });
});

describe("idbTemplateLibrary — migrated site-agnostic records", () => {
  it("lists a record migrated without a resolvable session for every site", async () => {
    // The v1 → v2 migration falls back to the `unknown-site` sentinel when the
    // panel was opened on a non-Atlassian tab; that template must not vanish
    // from the library once a real site IS known.
    //
    // The record is created by a REAL v1 → v2 migration run with no site
    // origin. The previous version of this test called `libraryFor(undefined)`,
    // which the default parameter turned straight back into SITE_A — so it
    // seeded an ordinary same-site row with `add()`, never a sentinel, and
    // deleting the `UNKNOWN_SITE_ORIGIN` branch from `belongsToSite` would not
    // have failed it.
    const migrated = await migrateSentinelRecord("orphan.docx", "o");

    const onSite = libraryFor(SITE_A);
    const listed = await onSite.list("docx", "DOCSY");
    expect(listed.map((e) => e.displayName)).toEqual(["orphan.docx"]);
    expect(listed[0].siteOrigin).toBe(UNKNOWN_SITE_ORIGIN);
    expect((await onSite.resolve(migrated.templateId, "docx", "DOCSY"))!.id).toBe(
      migrated.templateId
    );
    // And its bytes still verify from a real site's library instance.
    expect((await onSite.getBytes(listed[0])).byteLength).toBe(migrated.size);

    // Site-agnostic really means every site, not just the first one asked.
    expect((await libraryFor(SITE_B).list("docx")).map((e) => e.displayName)).toEqual([
      "orphan.docx",
    ]);
  });

  it("stays resolvable after a real-origin row supersedes the sentinel", async () => {
    // THE DEADLOCK. A sentinel row matches every site, so once the user
    // re-uploads the same logical template on a real site there are two
    // candidates in one resolution bucket and `resolveTemplate` throws
    // `TemplateResolutionConflictError`. Every byte is still on disk and NO
    // export can run — with nothing in the UI explaining why.
    const migrated = await migrateSentinelRecord("handbook.docx", "the old one");

    const onSite = libraryFor(SITE_A);
    const replacement = bytesFor("the new one");
    const fresh = await onSite.add({
      name: "handbook.docx",
      bytes: replacement,
      templateId: migrated.templateId,
    });
    expect(fresh.recordKey).not.toBe(migrated.recordKey);

    // Resolution works and picks the real-origin row…
    const resolved = await onSite.resolve(migrated.templateId, "docx");
    expect(resolved).toBeDefined();
    expect(resolved!.siteOrigin).toBe(SITE_A);
    expect(await onSite.getBytes(resolved!)).toEqual(new Uint8Array(replacement));

    // …in a space too, where the sentinel would compete just the same.
    const inSpace = await onSite.resolve(migrated.templateId, "docx", "DOCSY");
    expect(inSpace!.recordKey).toBe(fresh.recordKey);

    // The picker shows one entry, not an unexplained duplicate.
    expect(await onSite.list("docx", "DOCSY")).toHaveLength(1);
  });

  it("keeps the superseded sentinel's bytes — shadowed, not destroyed", async () => {
    const migrated = await migrateSentinelRecord("handbook.docx", "the old one");
    const onSite = libraryFor(SITE_A);
    const fresh = await onSite.add({
      name: "handbook.docx",
      bytes: bytesFor("the new one"),
      templateId: migrated.templateId,
    });

    // Both rows are still on disk, and the library view still shows the
    // shadowed one so the user can delete it.
    expect(await listTemplates(factory)).toHaveLength(2);
    const all = await onSite.listAll("docx");
    expect(all.map((e) => e.recordKey).sort()).toEqual(
      [migrated.recordKey, fresh.recordKey].sort()
    );

    // Deleting the real-origin row un-shadows the sentinel, exactly like
    // deleting a space override falls back to the global entry.
    await onSite.remove(fresh.recordKey);
    const fallback = await onSite.resolve(migrated.templateId, "docx", "DOCSY");
    expect(fallback!.recordKey).toBe(migrated.recordKey);
    expect((await onSite.getBytes(fallback!)).byteLength).toBe(migrated.size);
  });

  it("does not shadow a sentinel that a real-origin row only overrides per space", async () => {
    // "Assign to space" mints a real-origin SPACE row sharing the logical id.
    // That is a different resolution bucket, so the global sentinel must stay
    // the fallback for every other space.
    const migrated = await migrateSentinelRecord("handbook.docx", "sentinel body");
    const onSite = libraryFor(SITE_A);
    const listed = (await onSite.list("docx")).find((e) => e.id === migrated.templateId)!;
    const override = await onSite.assignToSpace(listed, "DOCSY");

    expect((await onSite.resolve(migrated.templateId, "docx", "DOCSY"))!.recordKey).toBe(
      override.recordKey
    );
    expect((await onSite.resolve(migrated.templateId, "docx", "OTHER"))!.recordKey).toBe(
      migrated.recordKey
    );
  });
});

describe("idbTemplateLibrary — delimiter injection in logical ids", () => {
  it("does not let one upload destroy another's bytes through a colliding record key", async () => {
    // `recordKey` is `<site>|<engine>|<templateId>|<scope>[|<spaceKey>]`, and a
    // `|` inside a component shifts every later component one slot along. These
    // two templates flattened to the SAME primary key, so the second upload
    // silently replaced the first row — and its DOCX bytes with it.
    const library = libraryFor(SITE_A);

    const injected = await library.add({
      name: "injected.docx",
      bytes: bytesFor("injected body"),
      templateId: "handbook|space",
    });
    const innocent = await library.add({
      name: "innocent.docx",
      bytes: bytesFor("innocent body"),
      templateId: "handbook",
      scope: "space",
      spaceKey: "global",
    });

    expect(injected.recordKey).not.toBe(innocent.recordKey);
    expect(await listTemplates(factory)).toHaveLength(2);

    // Both sets of bytes are intact and pass their own integrity check.
    expect(await library.getBytes(injected)).toEqual(new Uint8Array(bytesFor("injected body")));
    expect(await library.getBytes(innocent)).toEqual(new Uint8Array(bytesFor("innocent body")));
  });

  it("survives a `|` in a space key", async () => {
    const library = libraryFor(SITE_A);
    const a = await library.add({
      name: "a.docx",
      bytes: bytesFor("a body"),
      templateId: "a",
      scope: "space",
      spaceKey: "b|space|c",
    });
    const b = await library.add({
      name: "b.docx",
      bytes: bytesFor("b body"),
      templateId: "a|space|b",
      scope: "space",
      spaceKey: "c",
    });

    expect(a.recordKey).not.toBe(b.recordKey);
    expect(await listTemplates(factory)).toHaveLength(2);
    expect(await library.getBytes(a)).toEqual(new Uint8Array(bytesFor("a body")));
    expect(await library.getBytes(b)).toEqual(new Uint8Array(bytesFor("b body")));
  });
});
