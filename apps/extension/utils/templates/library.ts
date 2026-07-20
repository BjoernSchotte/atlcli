/**
 * IndexedDB-backed {@link TemplateLibrary} for the panel (spec 010 T5.2 /
 * Architecture point 4).
 *
 * This is a pure **adapter**: it maps the v2 `templates` store
 * (`utils/docx/template-store.ts`) onto folder 007's host-neutral
 * `TemplateLibrary` port and delegates every precedence decision to the shared,
 * pure `resolveTemplate` from `@atlcli/core`. The panel deliberately grows **no
 * precedence rules of its own** — "space beats global" must mean the same thing
 * in the extension as it does in the CLI.
 *
 * Three properties this adapter is responsible for:
 *
 *  - **`recordKey` vs. `templateId`.** The store's primary key is the physical
 *    `recordKey`; `resolveTemplate` matches on the logical `templateId`, which a
 *    global entry and its space-scoped override share. Both rows therefore
 *    coexist and the space one wins — see the store's module docstring for why
 *    a single `id` field cannot do both jobs.
 *  - **Site isolation.** Entries are filtered by `siteOrigin`, so two Atlassian
 *    sites that both use a space called `DOCSY` never see each other's
 *    templates. The one exception is {@link UNKNOWN_SITE_ORIGIN}, the sentinel
 *    the v1 → v2 migration falls back to when no session was resolvable; those
 *    records are listed for every site so a pre-v2 template is never orphaned.
 *  - **Integrity is a hard error.** {@link idbTemplateLibrary}'s `getBytes`
 *    re-hashes the bytes and throws `TemplateIntegrityError` ("template was
 *    modified — re-upload") on a mismatch. There is no silent fallback to some
 *    other entry (BASELINE-DESIGN B2).
 *
 * Scan verdicts stay derived-on-read: this module hands out bytes, never a
 * cached classification of them.
 */
import {
  resolveTemplate,
  sha256Hex,
  TemplateIntegrityError,
  type TemplateLibrary,
  type TemplateLibraryEntry,
} from "@atlcli/core";
import {
  buildPrefsKey,
  buildRecordKey,
  deleteTemplate,
  getTemplatePrefs,
  listTemplates,
  normalizeSiteOrigin,
  putTemplate,
  putTemplatePrefs,
  UNKNOWN_SITE_ORIGIN,
  type StoredTemplateRecord,
  type TemplateEngine,
  type TemplatePrefsRecord,
  type TemplateScope,
  type TemplateSettingsValue,
} from "../docx/template-store.js";

/**
 * A {@link TemplateLibraryEntry} that remembers which physical row it came
 * from. `TemplateLibraryEntry` intentionally has no storage key (it is
 * host-neutral), but `getBytes` needs to find the row again — carrying the
 * `recordKey` on the entry avoids re-deriving it, which would be impossible for
 * migrated {@link UNKNOWN_SITE_ORIGIN} records anyway.
 */
export interface StoredTemplateEntry extends TemplateLibraryEntry {
  /** IDB primary key of the row this entry describes. */
  recordKey: string;
  /** The site the row belongs to (or {@link UNKNOWN_SITE_ORIGIN}). */
  siteOrigin: string;
  /** Original uploaded filename (drives `$scroll.template.name`). */
  fileName: string;
}

export interface IdbTemplateLibraryOptions {
  /** Injectable for tests (`fake-indexeddb`); defaults to `globalThis.indexedDB`. */
  factory?: IDBFactory;
  /** Ambient Atlassian session origin, e.g. `https://x.atlassian.net`. */
  siteOrigin?: string;
}

/** Input for adding a new physical upload to the library. */
export interface AddTemplateInput {
  /** Original filename. */
  name: string;
  /** Picker label; defaults to {@link name}. */
  displayName?: string;
  bytes: ArrayBuffer;
  engine?: TemplateEngine;
  scope?: TemplateScope;
  spaceKey?: string;
  /** Reuse an existing logical id (that is what "assign to space" does). */
  templateId?: string;
  uploadedAt?: number;
}

/** The panel-facing library: the neutral port plus the mutations the UI needs. */
export interface IdbTemplateLibrary extends TemplateLibrary {
  list(engine: TemplateEngine, spaceKey?: string): Promise<StoredTemplateEntry[]>;
  getBytes(entry: TemplateLibraryEntry): Promise<Uint8Array>;
  /** Every row for this site + engine, ignoring space filtering (library view). */
  listAll(engine: TemplateEngine): Promise<StoredTemplateEntry[]>;
  /** Add a physical upload; computes the sha256 up front. */
  add(input: AddTemplateInput): Promise<StoredTemplateEntry>;
  /**
   * "Assign to current space": mints a **new** row carrying the source entry's
   * `templateId` with `scope: "space"`. The global row is never mutated, so
   * deleting the override leaves the global entry for `resolveTemplate` to fall
   * back to.
   */
  assignToSpace(entry: TemplateLibraryEntry, spaceKey: string): Promise<StoredTemplateEntry>;
  /** Delete one physical row by its `recordKey`. */
  remove(recordKey: string): Promise<void>;
  /** Resolve the entry the export should use, honouring space-beats-global. */
  resolve(
    templateId: string,
    engine: TemplateEngine,
    spaceKey?: string
  ): Promise<StoredTemplateEntry | undefined>;
  /** The active selection's logical `templateId` for this engine + space, if any. */
  getActiveTemplateId(engine: TemplateEngine, spaceKey?: string): Promise<string | undefined>;
  /** Persist the active selection (pass `undefined` to clear it). */
  setActiveTemplateId(
    engine: TemplateEngine,
    spaceKey: string | undefined,
    templateId: string | undefined
  ): Promise<void>;
  /** Read the raw prefs record (active selection + per-template settings values). */
  readPrefs(engine: TemplateEngine, spaceKey?: string): Promise<TemplatePrefsRecord | undefined>;
  /** Persist the settings-form values for one logical template. */
  writeSettings(
    engine: TemplateEngine,
    spaceKey: string | undefined,
    templateId: string,
    values: Record<string, TemplateSettingsValue>
  ): Promise<void>;
  /** Read the settings-form values for one logical template (`{}` when unset). */
  readSettings(
    engine: TemplateEngine,
    spaceKey: string | undefined,
    templateId: string
  ): Promise<Record<string, TemplateSettingsValue>>;
}

/** True when `record` belongs to `site` — or is a site-agnostic migrated row. */
function belongsToSite(record: StoredTemplateRecord, site: string): boolean {
  return record.siteOrigin === site || record.siteOrigin === UNKNOWN_SITE_ORIGIN;
}

/**
 * A row is only part of the library once migration phase 2 finished it. A
 * pending row still carries `sha256: null`, and presenting it would mean
 * handing out bytes no integrity check can cover.
 */
function isMigrated(record: StoredTemplateRecord): record is StoredTemplateRecord & {
  sha256: string;
} {
  return !record.migrationPending && typeof record.sha256 === "string";
}

function toEntry(record: StoredTemplateRecord & { sha256: string }): StoredTemplateEntry {
  return {
    id: record.templateId,
    displayName: record.displayName,
    engine: record.engine,
    scope: record.scope,
    ...(record.spaceKey === undefined ? {} : { spaceKey: record.spaceKey }),
    sha256: record.sha256,
    size: record.size,
    uploadedAt: new Date(record.uploadedAt).toISOString(),
    recordKey: record.recordKey,
    siteOrigin: record.siteOrigin,
    fileName: record.name,
  };
}

export function idbTemplateLibrary(options: IdbTemplateLibraryOptions = {}): IdbTemplateLibrary {
  const factory = options.factory;
  const site = normalizeSiteOrigin(options.siteOrigin);
  const storeOptions = { siteOrigin: options.siteOrigin };

  async function rows(engine: TemplateEngine): Promise<StoredTemplateRecord[]> {
    const all = await listTemplates(factory, storeOptions);
    return all.filter((r) => r.engine === engine && belongsToSite(r, site));
  }

  async function entries(engine: TemplateEngine): Promise<StoredTemplateEntry[]> {
    return (await rows(engine)).filter(isMigrated).map(toEntry);
  }

  async function findRecord(
    entry: TemplateLibraryEntry
  ): Promise<StoredTemplateRecord | undefined> {
    const candidates = await rows(entry.engine);
    const byKey = (entry as Partial<StoredTemplateEntry>).recordKey;
    if (byKey) {
      const hit = candidates.find((r) => r.recordKey === byKey);
      if (hit) return hit;
    }
    return candidates.find(
      (r) =>
        r.templateId === entry.id &&
        r.scope === entry.scope &&
        (r.spaceKey ?? undefined) === (entry.spaceKey ?? undefined)
    );
  }

  async function loadPrefs(
    engine: TemplateEngine,
    spaceKey?: string
  ): Promise<TemplatePrefsRecord | undefined> {
    return getTemplatePrefs(
      buildPrefsKey({ siteOrigin: site, engine, spaceKey }),
      factory,
      storeOptions
    );
  }

  async function savePrefs(
    engine: TemplateEngine,
    spaceKey: string | undefined,
    mutate: (draft: TemplatePrefsRecord) => void
  ): Promise<void> {
    const recordKey = buildPrefsKey({ siteOrigin: site, engine, spaceKey });
    const existing = await getTemplatePrefs(recordKey, factory, storeOptions);
    const draft: TemplatePrefsRecord = existing
      ? { ...existing, updatedAt: Date.now() }
      : {
          recordKey,
          siteOrigin: site,
          engine,
          ...(spaceKey === undefined ? {} : { spaceKey }),
          updatedAt: Date.now(),
        };
    mutate(draft);
    await putTemplatePrefs(draft, factory, storeOptions);
  }

  /**
   * The bucket `resolveTemplate` arbitrates over: globals plus this space's
   * overrides. A superset would be allowed by the port contract, but the
   * panel's picker wants exactly this.
   */
  async function listResolvable(
    engine: TemplateEngine,
    spaceKey?: string
  ): Promise<StoredTemplateEntry[]> {
    const all = await entries(engine);
    if (spaceKey === undefined) return all;
    return all.filter((e) => e.scope === "global" || e.spaceKey === spaceKey);
  }

  async function add(input: AddTemplateInput): Promise<StoredTemplateEntry> {
    const engine = input.engine ?? "docx";
    const scope = input.scope ?? "global";
    if (scope === "space" && !input.spaceKey) {
      throw new Error("A space-scoped template needs a spaceKey.");
    }
    const templateId = input.templateId ?? crypto.randomUUID();
    const sha256 = await sha256Hex(new Uint8Array(input.bytes));
    const record: StoredTemplateRecord = {
      recordKey: buildRecordKey({
        siteOrigin: site,
        engine,
        templateId,
        scope,
        spaceKey: input.spaceKey,
      }),
      templateId,
      siteOrigin: site,
      displayName: input.displayName ?? input.name,
      engine,
      scope,
      ...(scope === "space" ? { spaceKey: input.spaceKey } : {}),
      name: input.name,
      bytes: input.bytes,
      uploadedAt: input.uploadedAt ?? Date.now(),
      sha256,
      size: input.bytes.byteLength,
    };
    await putTemplate(record, factory, storeOptions);
    return toEntry(record as StoredTemplateRecord & { sha256: string });
  }

  return {
    list: listResolvable,

    listAll(engine: TemplateEngine): Promise<StoredTemplateEntry[]> {
      return entries(engine);
    },

    async getBytes(entry: TemplateLibraryEntry): Promise<Uint8Array> {
      const record = await findRecord(entry);
      if (!record) {
        throw new Error(
          `Template "${entry.displayName || entry.id}" is no longer in the library — re-upload it.`
        );
      }
      if (!isMigrated(record)) {
        throw new Error(
          `Template "${entry.displayName || entry.id}" is still being migrated — try again in a moment.`
        );
      }
      const bytes = new Uint8Array(record.bytes);
      if (bytes.byteLength !== entry.size) {
        throw new TemplateIntegrityError(
          entry.id,
          "size",
          String(entry.size),
          String(bytes.byteLength)
        );
      }
      // Hard error, never a silent fallback: the stored bytes must still hash to
      // what the catalog entry promised.
      const actual = await sha256Hex(bytes);
      if (actual.toLowerCase() !== entry.sha256.toLowerCase()) {
        throw new TemplateIntegrityError(entry.id, "sha256", entry.sha256, actual);
      }
      return bytes;
    },

    add,

    async assignToSpace(entry: TemplateLibraryEntry, spaceKey: string): Promise<StoredTemplateEntry> {
      const record = await findRecord(entry);
      if (!record || !isMigrated(record)) {
        throw new Error(`Template "${entry.displayName || entry.id}" is not in the library.`);
      }
      // A NEW row sharing the logical templateId — the global row is untouched,
      // so removing this override falls back to it.
      return add({
        name: record.name,
        displayName: record.displayName,
        bytes: record.bytes,
        engine: record.engine,
        scope: "space",
        spaceKey,
        templateId: record.templateId,
        uploadedAt: record.uploadedAt,
      });
    },

    remove(recordKey: string): Promise<void> {
      return deleteTemplate(recordKey, factory, storeOptions);
    },

    async resolve(
      templateId: string,
      engine: TemplateEngine,
      spaceKey?: string
    ): Promise<StoredTemplateEntry | undefined> {
      const candidates = await listResolvable(engine, spaceKey);
      // The shared, pure resolver decides — not the panel.
      return resolveTemplate(candidates, templateId, engine, spaceKey) as
        | StoredTemplateEntry
        | undefined;
    },

    async getActiveTemplateId(
      engine: TemplateEngine,
      spaceKey?: string
    ): Promise<string | undefined> {
      const scoped = await loadPrefs(engine, spaceKey);
      if (scoped?.activeTemplateId) return scoped.activeTemplateId;
      // Fall back to the space-agnostic selection so choosing a template once
      // keeps working after navigating to another space.
      if (spaceKey === undefined) return undefined;
      return (await loadPrefs(engine, undefined))?.activeTemplateId;
    },

    setActiveTemplateId(
      engine: TemplateEngine,
      spaceKey: string | undefined,
      templateId: string | undefined
    ): Promise<void> {
      return savePrefs(engine, spaceKey, (draft) => {
        draft.activeTemplateId = templateId;
      });
    },

    readPrefs(engine: TemplateEngine, spaceKey?: string): Promise<TemplatePrefsRecord | undefined> {
      return loadPrefs(engine, spaceKey);
    },

    writeSettings(
      engine: TemplateEngine,
      spaceKey: string | undefined,
      templateId: string,
      values: Record<string, TemplateSettingsValue>
    ): Promise<void> {
      return savePrefs(engine, spaceKey, (draft) => {
        draft.settingsByTemplateId = { ...(draft.settingsByTemplateId ?? {}), [templateId]: values };
      });
    },

    async readSettings(
      engine: TemplateEngine,
      spaceKey: string | undefined,
      templateId: string
    ): Promise<Record<string, TemplateSettingsValue>> {
      const prefs = await loadPrefs(engine, spaceKey);
      return prefs?.settingsByTemplateId?.[templateId] ?? {};
    },
  };
}
