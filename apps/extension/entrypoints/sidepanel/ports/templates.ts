/**
 * Chrome adapter for {@link TemplateLibraryPort} (spec 010 T5.2).
 *
 * The whole adapter is "call `idbTemplateLibrary` and hand its result back":
 * `IdbTemplateLibrary` already implements every method the port declares,
 * including `resolve`'s space-beats-global precedence, which is the shared
 * `resolveTemplate` from `@atlcli/core`. Nothing about template precedence is
 * decided here — that is the point of the port existing at all.
 *
 * ## Why the library is constructed per call, not once
 *
 * `siteOrigin` comes from {@link SiteContext}, which is `null` until the
 * page-context adapter has resolved the active tab. Capturing it at
 * `createChromePorts()` time would bind every later call to whatever the URL was
 * at panel-open — in practice `undefined`, which the store records as the
 * `unknown-site` sentinel. Those sentinel rows match EVERY site
 * (`belongsToSite`), so a template uploaded before the tab resolved would leak
 * across tenants and, worse, collide with a real-origin row of the same logical
 * id — exactly the `TemplateResolutionConflictError` class wave 1 had to repair
 * in the store itself. `chromeDocxTemplateStore` already re-reads the site per
 * call for this reason; this adapter does the same, deliberately.
 */
import type {
  TemplateLibraryItem,
  TemplateLibraryPort,
  TemplateSettingValue,
} from "../../../utils/ports/export.js";
import { profileFromTabUrl } from "../../../utils/profile.js";
import {
  idbTemplateLibrary,
  type IdbTemplateLibrary,
  type StoredTemplateEntry,
} from "../../../utils/templates/library.js";
import type { SiteContext } from "./site-context.js";

/**
 * `StoredTemplateEntry` carries everything `TemplateLibraryItem` needs plus the
 * physical `siteOrigin`. Returned as-is rather than re-projected: dropping
 * fields here would only mean the panel loses the ability to explain WHICH site
 * a row came from, and the extra property is structurally harmless.
 */
function toItem(entry: StoredTemplateEntry): TemplateLibraryItem {
  return entry;
}

export function chromeTemplateLibrary(site: SiteContext): TemplateLibraryPort {
  const library = (): IdbTemplateLibrary =>
    idbTemplateLibrary({
      // Read at CALL time — see the module header.
      ...(siteOriginOf(site) ? { siteOrigin: siteOriginOf(site)! } : {}),
    });

  return {
    async listAll(engine) {
      return (await library().listAll(engine)).map(toItem);
    },

    getBytes(entry) {
      return library().getBytes(entry);
    },

    async add(input) {
      return toItem(await library().add(input));
    },

    async assignToSpace(entry, spaceKey) {
      return toItem(await library().assignToSpace(entry, spaceKey));
    },

    remove(recordKey) {
      return library().remove(recordKey);
    },

    getActiveTemplateId(engine, spaceKey) {
      return library().getActiveTemplateId(engine, spaceKey);
    },

    setActiveTemplateId(engine, spaceKey, templateId) {
      return library().setActiveTemplateId(engine, spaceKey, templateId);
    },

    readSettings(engine, spaceKey, templateId) {
      return library().readSettings(engine, spaceKey, templateId) as Promise<
        Record<string, TemplateSettingValue>
      >;
    },

    writeSettings(engine, spaceKey, templateId, values) {
      return library().writeSettings(engine, spaceKey, templateId, values);
    },
  };
}

/** The active tab's Atlassian origin, or `undefined` off an Atlassian host. */
function siteOriginOf(site: SiteContext): string | undefined {
  const profile = site.url ? profileFromTabUrl(site.url) : null;
  return profile ? profile.baseUrl : undefined;
}
