/**
 * Primary-key construction for the v2 template store (spec 010 T5.2).
 *
 * `recordKey` is a `|`-joined tuple used as the IndexedDB **primary key**, so
 * two different logical templates producing the same key is not a cosmetic
 * problem: `put()` on an existing primary key REPLACES the row, silently
 * destroying the other template's uploaded bytes. Raw concatenation is not
 * injective — a `|` inside any component shifts every later component one slot
 * along — so every component is escaped, and these tests pin that.
 *
 * Run against `fake-indexeddb` so the replace-on-primary-key semantics under
 * test are the real ones, not a map stand-in.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { buildDocx, para } from "@atlcli/docx/fixtures";
import {
  buildPrefsKey,
  buildRecordKey,
  getTemplate,
  getTemplatePrefs,
  listTemplates,
  putTemplate,
  putTemplatePrefs,
  type StoredTemplateRecord,
} from "../../utils/docx/template-store.js";

const SITE = "https://a.atlassian.net";

let factory: IDBFactory;

beforeEach(() => {
  factory = new IDBFactory();
});

function bytesFor(text: string): ArrayBuffer {
  const b = buildDocx({ body: para(text) + para("$scroll.content") });
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

function record(
  name: string,
  parts: {
    templateId: string;
    scope: "global" | "space";
    spaceKey?: string;
  }
): StoredTemplateRecord {
  const bytes = bytesFor(name);
  return {
    recordKey: buildRecordKey({ siteOrigin: SITE, engine: "docx", ...parts }),
    templateId: parts.templateId,
    siteOrigin: SITE,
    displayName: name,
    engine: "docx",
    scope: parts.scope,
    ...(parts.spaceKey === undefined ? {} : { spaceKey: parts.spaceKey }),
    name,
    bytes,
    uploadedAt: 1,
    sha256: "0".repeat(64),
    size: bytes.byteLength,
  };
}

describe("buildRecordKey — delimiter injection", () => {
  it("keeps the exact reported collision apart: a `|` in templateId vs. a space named `global`", () => {
    // Raw concatenation flattened BOTH of these to
    // `https://a.atlassian.net|docx|handbook|space|global`.
    const viaTemplateId = buildRecordKey({
      siteOrigin: SITE,
      engine: "docx",
      templateId: "handbook|space",
      scope: "global",
    });
    const viaSpaceKey = buildRecordKey({
      siteOrigin: SITE,
      engine: "docx",
      templateId: "handbook",
      scope: "space",
      spaceKey: "global",
    });

    expect(viaTemplateId).not.toBe(viaSpaceKey);
  });

  it("keeps a `|` in a space key from colliding with a `|` in a templateId", () => {
    const a = buildRecordKey({
      siteOrigin: SITE,
      engine: "docx",
      templateId: "a",
      scope: "space",
      spaceKey: "b|space|c",
    });
    const b = buildRecordKey({
      siteOrigin: SITE,
      engine: "docx",
      templateId: "a|space|b",
      scope: "space",
      spaceKey: "c",
    });

    expect(a).not.toBe(b);
  });

  it("does not let the escape character reintroduce the collision", () => {
    // If `|` were encoded as `%7C` without also encoding `%`, the literal text
    // `%7C` and a real `|` would encode identically and the collision would
    // simply move one level down.
    const literal = buildRecordKey({
      siteOrigin: SITE,
      engine: "docx",
      templateId: "handbook%7Cspace",
      scope: "global",
    });
    const real = buildRecordKey({
      siteOrigin: SITE,
      engine: "docx",
      templateId: "handbook|space",
      scope: "global",
    });

    expect(literal).not.toBe(real);
  });

  it("leaves ordinary components byte-identical (no gratuitous key churn)", () => {
    expect(
      buildRecordKey({ siteOrigin: SITE, engine: "docx", templateId: "tpl-1", scope: "global" })
    ).toBe(`${SITE}|docx|tpl-1|global`);
    expect(
      buildRecordKey({
        siteOrigin: SITE,
        engine: "docx",
        templateId: "tpl-1",
        scope: "space",
        spaceKey: "DOCSY",
      })
    ).toBe(`${SITE}|docx|tpl-1|space|DOCSY`);
    expect(buildPrefsKey({ siteOrigin: SITE, engine: "docx", spaceKey: "DOCSY" })).toBe(
      `${SITE}|docx|DOCSY`
    );
  });

  it("stores both colliding templates as separate rows, with their own bytes", async () => {
    // The end of the story if the keys were equal: the second put() replaces
    // the first row and the first template's uploaded DOCX is gone forever.
    const injected = record("injected.docx", {
      templateId: "handbook|space",
      scope: "global",
    });
    const innocent = record("innocent.docx", {
      templateId: "handbook",
      scope: "space",
      spaceKey: "global",
    });

    await putTemplate(injected, factory);
    await putTemplate(innocent, factory);

    expect(await listTemplates(factory)).toHaveLength(2);

    const backInjected = await getTemplate(injected.recordKey, factory);
    const backInnocent = await getTemplate(innocent.recordKey, factory);
    expect(backInjected!.name).toBe("injected.docx");
    expect(backInnocent!.name).toBe("innocent.docx");
    expect(new Uint8Array(backInjected!.bytes)).toEqual(new Uint8Array(injected.bytes));
    expect(new Uint8Array(backInnocent!.bytes)).toEqual(new Uint8Array(innocent.bytes));
  });
});

describe("buildPrefsKey — delimiter injection", () => {
  it("keeps two spaces whose keys differ only around a `|` independent", async () => {
    // `<site>|<engine>|<spaceKey>`: a `|` in a space key would otherwise let one
    // space read and overwrite another's active selection and settings values.
    const first = buildPrefsKey({ siteOrigin: "https://a|b", engine: "docx", spaceKey: "C" });
    const second = buildPrefsKey({ siteOrigin: "https://a", engine: "docx", spaceKey: "b|docx|C" });
    expect(first).not.toBe(second);

    await putTemplatePrefs(
      {
        recordKey: first,
        siteOrigin: "https://a|b",
        engine: "docx",
        spaceKey: "C",
        activeTemplateId: "first",
        updatedAt: 1,
      },
      factory
    );
    await putTemplatePrefs(
      {
        recordKey: second,
        siteOrigin: "https://a",
        engine: "docx",
        spaceKey: "b|docx|C",
        activeTemplateId: "second",
        updatedAt: 2,
      },
      factory
    );

    expect((await getTemplatePrefs(first, factory))!.activeTemplateId).toBe("first");
    expect((await getTemplatePrefs(second, factory))!.activeTemplateId).toBe("second");
  });
});
