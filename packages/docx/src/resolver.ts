/**
 * Placeholder resolver (spec 004 Task 4 / PLAN §2.2).
 *
 * Resolves each `$scroll.*` text placeholder a template uses to a concrete
 * string, implementing every `direct` and `derivable` row of the normative §2
 * mapping table. Design points:
 *
 *  - **Pure + injectable.** No `chrome.*` / network here; the four derivable
 *    round-trips (`getSpace` for `$scroll.space.*`, `getCurrentUser` for
 *    `$scroll.exporter*`, `getPageOwner` for `$scroll.pageowner.*`,
 *    `getSpaceHomepageStorage` for the pageproperty fallback form) come in as
 *    injected async deps so the resolver unit tests run offline and can prove
 *    the *lazy* contract.
 *  - **Lazy fetching.** Each fetcher fires only when the used placeholder set
 *    actually needs it (PLAN §2.2; mock-fetch test asserts they are NOT called
 *    otherwise). For page properties the laziness is per-ARGUMENT, not
 *    per-placeholder: `(key)` reads the page's own storage, which is already in
 *    hand, and only `(key,true)` reaches for the space homepage.
 *  - **Never leak a literal.** Supported → value; unsupported/never (and any
 *    absent field like a Cloud-hidden email) → empty string + a report note.
 *    The export preprocessor then removes the raw token, so no `$scroll.*`
 *    survives into the output (pinning test).
 */
import {
  lookupPageProperty,
  parsePageProperties,
  type ConfluencePageDetails,
  type ConfluenceSpace,
  type ExportNote,
  type PagePropertiesMacro,
} from "@atlcli/confluence";
import { classifyPlaceholder, parsePagePropertyArgs } from "./placeholder-map.js";
import { formatDatePlaceholder } from "./dateformat.js";

/** atlcli-side template metadata (G8): filename + upload timestamp. */
export interface TemplateMeta {
  name: string;
  modificationDate: Date;
}

/** Minimal current-user shape the resolver needs (subset of `getCurrentUser`). */
export interface CurrentUser {
  accountId: string;
  displayName: string;
  email?: string;
}

/** Everything the resolver reads, sans the lazily-fetched space/user. */
export interface ResolveContext {
  details: ConfluencePageDetails;
  template: TemplateMeta;
  exportDate: Date;
}

/** A page's owner (G1) — Cloud ownership is transferable, so ≠ `createdBy`. */
export interface PageOwner {
  accountId?: string;
  displayName: string;
  email?: string;
}

/** Lazily-invoked fetchers for the derivable round-trips (G1/G4/G6/G7). */
export interface ResolveDeps {
  getSpace?: (spaceKey: string) => Promise<ConfluenceSpace>;
  getCurrentUser?: () => Promise<CurrentUser>;
  getPageOwner?: (pageId: string) => Promise<PageOwner | null>;
  /** Storage of the space homepage — only for the pageproperty fallback form. */
  getSpaceHomepageStorage?: (spaceKey: string) => Promise<string | null>;
}

/**
 * The values that had to be fetched before a placeholder could resolve. Grouped
 * rather than passed positionally so adding a future round-trip does not grow
 * {@link resolveOne}'s signature again.
 */
export interface Fetched {
  space?: ConfluenceSpace;
  currentUser?: CurrentUser;
  owner?: PageOwner;
  /** Page Properties macros of the space homepage (G4 fallback form only). */
  homepageProperties?: PagePropertiesMacro[];
}

export interface ResolveResult {
  /** raw placeholder occurrence → resolved text (empty string when unsupported). */
  values: Map<string, string>;
  notes: ExportNote[];
  /** Count of placeholders resolved to a non-empty supported value. */
  resolvedCount: number;
  /** Distinct base names that were unsupported/never (for the report). */
  unsupportedNames: string[];
}

/** Extract the quoted format argument from `…("dd.MM.yyyy")`, if any. */
function parseArg(raw: string): string | undefined {
  const m = raw.match(/\(\s*["']([^"']*)["']\s*\)/);
  return m ? m[1] : undefined;
}

function capitalizeFirst(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/** Format a concrete date, recording an unknown-token note on ISO fallback. */
function formatDateWithNote(date: Date, raw: string, notes: ExportNote[]): string {
  const { text, unknownToken } = formatDatePlaceholder(date, parseArg(raw));
  if (unknownToken) {
    notes.push({
      level: "warning",
      code: "date-format-unknown",
      message: `Unknown date token "${unknownToken}" in ${raw}; fell back to ISO date.`,
    });
  }
  return text;
}

/** Resolve a single date field to text, recording an unknown-token note. */
function resolveDate(
  value: string | undefined,
  raw: string,
  notes: ExportNote[]
): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return formatDateWithNote(date, raw, notes);
}

/**
 * Resolve one raw placeholder occurrence given the (already-fetched, if needed)
 * space and current user. Pure — this is the seam the table-driven test hits.
 */
export function resolveOne(
  raw: string,
  ctx: ResolveContext,
  fetched: Fetched,
  notes: ExportNote[]
): string {
  const { base } = classifyPlaceholder(raw);
  const { details, template, exportDate } = ctx;
  const { space, currentUser, owner } = fetched;

  switch (base) {
    case "$scroll.title":
      return details.title ?? "";
    case "$scroll.version":
      return details.version != null ? String(details.version) : "";
    case "$scroll.pageid":
      return details.id ?? "";
    case "$scroll.pageurl":
      return details.url ?? "";
    case "$scroll.tinyurl":
      return details.tinyUrl ?? "";
    case "$scroll.pagelabels":
      return (details.labels ?? []).join(", ");
    case "$scroll.pagelabels.capitalised":
      return (details.labels ?? []).map(capitalizeFirst).join(", ");

    // The owner is NOT the creator: Cloud ownership can be transferred (G1).
    case "$scroll.pageowner.fullName":
      return owner?.displayName ?? "";

    case "$scroll.pageproperty":
      return resolvePageProperty(raw, ctx, fetched, notes);

    case "$scroll.creator":
    case "$scroll.creator.fullName":
      return details.createdBy?.displayName ?? "";
    case "$scroll.creator.email":
      return emailOrNote(details.createdBy?.email, raw, notes);
    case "$scroll.creator.name":
      return resolveDcName(details.createdBy?.displayName, raw, notes);
    case "$scroll.modifier":
    case "$scroll.modifier.fullName":
      return details.modifiedBy?.displayName ?? "";
    case "$scroll.modifier.email":
      return emailOrNote(details.modifiedBy?.email, raw, notes);
    case "$scroll.modifier.name":
      return resolveDcName(details.modifiedBy?.displayName, raw, notes);

    case "$scroll.creationdate":
      return resolveDate(details.created, raw, notes);
    case "$scroll.modificationdate":
      return resolveDate(details.modified, raw, notes);
    case "$scroll.exportdate":
      return formatDateWithNote(exportDate, raw, notes);

    case "$scroll.space.key":
      return details.spaceKey ?? "";
    case "$scroll.space.name":
      return space?.name ?? "";
    case "$scroll.space.url":
      return space?.url ?? "";

    case "$scroll.exporter":
    case "$scroll.exporter.fullName":
      return currentUser?.displayName ?? "";
    case "$scroll.exporter.email":
      return emailOrNote(currentUser?.email, raw, notes);
    case "$scroll.exporter.name":
      return resolveDcName(currentUser?.displayName, raw, notes);

    case "$scroll.template.name":
      return template.name;
    case "$scroll.template.modificationdate":
      return formatDateWithNote(template.modificationDate, raw, notes);

    default:
      // Unsupported / never / unrecognized → empty (caller adds the report line).
      return "";
  }
}

/**
 * Resolve `$scroll.pageproperty.(…)` (G4).
 *
 * Order: the page's own Page Properties macro → (only when the argument asks for
 * it) the space homepage's → the alternate text → empty + a note. The page's
 * macros are parsed from `details.storage`, which the export already holds, so
 * the common `(key)` form costs no round-trip at all.
 */
function resolvePageProperty(
  raw: string,
  ctx: ResolveContext,
  fetched: Fetched,
  notes: ExportNote[]
): string {
  const args = parsePagePropertyArgs(raw);
  if (args.key === "") {
    notes.push({
      level: "warning",
      code: "pageproperty-no-key",
      message: `${raw} names no property key; rendered empty.`,
    });
    return "";
  }

  const own = parsePageProperties(ctx.details.storage ?? "");
  let value = lookupPageProperty(own, args.key, args.macroId);

  if (value === undefined && args.fallbackEnabled) {
    value = lookupPageProperty(fetched.homepageProperties ?? [], args.key, args.macroId);
  }

  if (value !== undefined && value !== "") return value;

  if (args.alternateText) return args.alternateText;

  notes.push({
    level: "info",
    code: "placeholder-empty",
    message:
      `Page property "${args.key}" was not found` +
      (args.macroId ? ` in the Page Properties macro "${args.macroId}"` : "") +
      (args.fallbackEnabled ? " (nor on the space homepage)" : "") +
      "; rendered empty.",
  });
  return "";
}

/**
 * Resolve a `.name` placeholder (`$scroll.creator.name` & friends) on Cloud.
 *
 * In Scroll, `.name` is the **Data Center username** (`bschotte`), not a person's
 * name — `.fullName` is the name. Confluence Cloud has no usernames at all:
 * Atlassian removed them and `accountId` replaced them, so there is no value
 * `.name` could ever carry here. The real choice is therefore not "wrong value
 * vs. right value" but **display name vs. an empty hole** in a template that
 * reads "Erstellt von: $scroll.creator.name" — and only a template migrated from
 * DC can contain `.name` in the first place.
 *
 * So we substitute the display name, and **say so in the report**: the value is
 * useful, and the one thing that would be wrong is doing it silently, since a
 * template asking for a login now gets a person's name (spec 001 gap G2).
 */
function resolveDcName(
  displayName: string | undefined,
  raw: string,
  notes: ExportNote[]
): string {
  if (!displayName) return "";
  notes.push({
    level: "info",
    code: "placeholder-substituted",
    message: `${raw} is a Data Center username, which Confluence Cloud does not have; used the display name "${displayName}" instead.`,
  });
  return displayName;
}

function emailOrNote(email: string | undefined, raw: string, notes: ExportNote[]): string {
  if (email) return email;
  notes.push({
    level: "info",
    code: "placeholder-empty",
    message: `${raw} has no value (email is not available, common on Confluence Cloud).`,
  });
  return "";
}

/**
 * Resolve the given raw placeholder occurrences, fetching space/user only when
 * some placeholder needs them.
 *
 * @param rawPlaceholders - distinct raw `$scroll.*` forms used by the template
 *   (from the scan). `$scroll.content` is ignored here (handled by the body
 *   serializer), as is `$adhocState` and any never/unsupported base (→ empty).
 */
export async function resolvePlaceholders(
  rawPlaceholders: string[],
  ctx: ResolveContext,
  deps: ResolveDeps = {}
): Promise<ResolveResult> {
  const notes: ExportNote[] = [];
  const values = new Map<string, string>();

  // Decide which round-trips are needed from the used set (lazy contract).
  let needsSpace = false;
  let needsUser = false;
  let needsOwner = false;
  let needsHomepage = false;
  const unsupportedNames = new Set<string>();
  for (const raw of rawPlaceholders) {
    const cls = classifyPlaceholder(raw);
    if (cls.base === "$scroll.content") continue;
    if (cls.status !== "supported") {
      unsupportedNames.add(cls.base);
      continue;
    }
    if (cls.dependency === "space") needsSpace = true;
    else if (cls.dependency === "currentUser") needsUser = true;
    else if (cls.dependency === "owner") needsOwner = true;
    else if (cls.dependency === "spaceHomepage") needsHomepage = true;
  }

  let space: ConfluenceSpace | undefined;
  if (needsSpace) {
    if (deps.getSpace && ctx.details.spaceKey) {
      try {
        space = await deps.getSpace(ctx.details.spaceKey);
      } catch {
        notes.push({
          level: "warning",
          code: "space-fetch-failed",
          message: `Could not load space "${ctx.details.spaceKey}"; space placeholders will be empty.`,
        });
      }
    } else {
      notes.push({
        level: "warning",
        code: "space-unavailable",
        message: ctx.details.spaceKey
          ? "The template uses $scroll.space.* but no space fetcher is available; those placeholders will be empty."
          : "The template uses $scroll.space.* but the page has no space key; those placeholders will be empty.",
      });
    }
  }

  let currentUser: CurrentUser | undefined;
  if (needsUser) {
    if (deps.getCurrentUser) {
      try {
        currentUser = await deps.getCurrentUser();
      } catch {
        notes.push({
          level: "warning",
          code: "user-fetch-failed",
          message: "Could not load the current user; exporter placeholders will be empty.",
        });
      }
    } else {
      notes.push({
        level: "warning",
        code: "user-unavailable",
        message: "The template uses $scroll.exporter* but no current-user fetcher is available; those placeholders will be empty.",
      });
    }
  }

  let owner: PageOwner | undefined;
  if (needsOwner) {
    if (deps.getPageOwner && ctx.details.id) {
      try {
        owner = (await deps.getPageOwner(ctx.details.id)) ?? undefined;
        if (!owner) {
          notes.push({
            level: "info",
            code: "placeholder-empty",
            message:
              "$scroll.pageowner.fullName has no value (the page has no owner, or the account could not be read).",
          });
        }
      } catch {
        notes.push({
          level: "warning",
          code: "owner-fetch-failed",
          message: "Could not load the page owner; $scroll.pageowner.* will be empty.",
        });
      }
    } else {
      notes.push({
        level: "warning",
        code: "owner-unavailable",
        message: ctx.details.id
          ? "The template uses $scroll.pageowner.* but no page-owner fetcher is available; those placeholders will be empty."
          : "The template uses $scroll.pageowner.* but the page has no id; those placeholders will be empty.",
      });
    }
  }

  let homepageProperties: PagePropertiesMacro[] | undefined;
  if (needsHomepage) {
    if (deps.getSpaceHomepageStorage && ctx.details.spaceKey) {
      try {
        const storage = await deps.getSpaceHomepageStorage(ctx.details.spaceKey);
        homepageProperties = parsePageProperties(storage ?? "");
      } catch {
        notes.push({
          level: "warning",
          code: "homepage-fetch-failed",
          message:
            "Could not load the space homepage; page properties will not fall back to it.",
        });
      }
    } else {
      notes.push({
        level: "warning",
        code: "homepage-unavailable",
        message: ctx.details.spaceKey
          ? "A page property asks for the space-homepage fallback but no homepage fetcher is available; only this page's properties are used."
          : "A page property asks for the space-homepage fallback but the page has no space key; only this page's properties are used.",
      });
    }
  }

  const fetched: Fetched = { space, currentUser, owner, homepageProperties };

  let resolvedCount = 0;
  for (const raw of rawPlaceholders) {
    const cls = classifyPlaceholder(raw);
    if (cls.base === "$scroll.content") continue;
    if (cls.status !== "supported") {
      values.set(raw, "");
      notes.push({
        level: "info",
        code: `placeholder-${cls.status}`,
        message: `${cls.base} is ${cls.status}${cls.reason ? ` (${cls.reason})` : ""}; rendered empty.`,
      });
      continue;
    }
    const value = resolveOne(raw, ctx, fetched, notes);
    values.set(raw, value);
    if (value !== "") resolvedCount += 1;
  }

  return {
    values,
    notes,
    resolvedCount,
    unsupportedNames: [...unsupportedNames].sort(),
  };
}
