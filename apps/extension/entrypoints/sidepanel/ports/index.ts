/**
 * Chrome host wiring (spec 010 Phase 0).
 *
 * The single place `chrome.*` meets the portable app. Note that
 * `chrome.runtime.getManifest()` is called *inside* {@link createChromePorts},
 * not at module scope: the module-scope call in the old `App.tsx:33` is what
 * made the panel unimportable outside an extension, and therefore why no test
 * ever imported it.
 */
import { profileFromTabUrl } from "../../../utils/profile.js";
import { ReadError, loadConfluencePage } from "../../../utils/read-path.js";
import type { AppPorts, HostCapability } from "../../../utils/ports/index.js";
import { createSiteContext } from "./site-context.js";
import { watchChromePageContext } from "./page-context.js";
import { chromePdfExportPort } from "./pdf.js";
import { chromeDocxExportPort, chromeDocxTemplateStore } from "./docx.js";
import { chromeSettingsStore } from "./settings.js";

/**
 * What the Chrome side panel can actually do today.
 *
 * `durable-jobs` (T5.6) and `pdf-preview` (T5.3) are deliberately absent: the
 * Activity screen is registered against `durable-jobs` and therefore renders as
 * disabled-with-a-reason until the capability is real. Adding the capability
 * here is what turns those screens on — no shell change.
 */
const CHROME_CAPABILITIES: readonly HostCapability[] = [
  "pdf-export",
  "docx-export",
  "docx-template-store",
  "settings-persistence",
];

export function createChromePorts(): AppPorts {
  const manifest = chrome.runtime.getManifest();
  const site = createSiteContext();

  return {
    host: {
      kind: "chrome-extension",
      name: manifest.name,
      version: manifest.version,
      capabilities: CHROME_CAPABILITIES,
    },

    watchPageContext: (onChange) => watchChromePageContext(site, onChange),

    // The host half is just "the active tab's origin becomes a session
    // profile"; everything after that is the existing, already-tested
    // `loadConfluencePage` (classification, the HTTP-200-without-id net,
    // best-effort attachment degradation).
    loadPage: (contentId) => {
      const profile = site.url ? profileFromTabUrl(site.url) : null;
      if (!profile) {
        throw new ReadError("unknown", "The active page is not on an approved Atlassian host.");
      }
      return loadConfluencePage(contentId, profile);
    },

    pdf: chromePdfExportPort(),
    docx: chromeDocxExportPort(),
    docxTemplates: chromeDocxTemplateStore(site),
    settings: chromeSettingsStore(),
  };
}
