/**
 * Chrome host wiring (spec 010 Phase 0).
 *
 * The single place `chrome.*` meets the portable app. Note that
 * `chrome.runtime.getManifest()` is called *inside* {@link createChromePorts},
 * not at module scope: the module-scope call in the old `App.tsx:33` is what
 * made the panel unimportable outside an extension, and therefore why no test
 * ever imported it.
 *
 * ## Why `countScopePages` is absent (spec 010 T5.1, baseline A2)
 *
 * The port is optional precisely so a host can decline, and this one does. The
 * shared orchestration has **no discovery-only walk**: `fetchExportTree`
 * discovers and body-fetches in ONE pass (`TreeFetchOptions` carries no
 * bodies-off flag), so an honest pre-flight count would cost the same requests
 * as the export it is meant to let the user cancel — and would fetch every page
 * body twice for the users who say yes.
 *
 * The two alternatives are worse. A CQL `totalSize` probe would be exact only
 * for an unfiltered `space` scope and silently wrong for `tree` scope or any
 * label filter; a second traversal implemented here would be extension-only
 * engine logic, which this folder's hard rule forbids. So the space-export
 * confirmation uses its count-free wording, which is the documented fallback,
 * and this stays unwired until the shared layer offers a cheap count.
 */
import { profileFromTabUrl } from "../../../utils/profile.js";
import { ReadError, loadConfluencePage } from "../../../utils/read-path.js";
import type { AppPorts, HostCapability } from "../../../utils/ports/index.js";
import { createSiteContext } from "./site-context.js";
import { watchChromePageContext } from "./page-context.js";
import { chromePdfExportPort } from "./pdf.js";
import { chromeDocxExportPort, chromeDocxTemplateStore } from "./docx.js";
import { chromeTemplateLibrary } from "./templates.js";
import { chromeSettingsStore } from "./settings.js";
import { chromeChatAgentPort, chromeResearchPort } from "./research.js";
import { chromeBrowserLocalModelPortV1 } from "./local-model.js";

/**
 * What the Chrome side panel can actually do today.
 *
 * This list is the ONLY switch for the screens registered against a capability:
 * a screen whose capability is missing renders disabled-with-a-reason rather
 * than erroring, which is why an unlisted-but-implemented feature looks exactly
 * like an unimplemented one. `pdf-preview` (T5.3), `template-library` (T5.2) and
 * `durable-jobs` (T5.6) are listed here because their implementations landed —
 * adding the capability is the whole activation, no shell change.
 */
export const CHROME_CAPABILITIES: readonly HostCapability[] = [
  "pdf-export",
  "docx-export",
  "docx-template-store",
  "pdf-preview",
  "template-library",
  "durable-jobs",
  "research",
  "settings-persistence",
  "confluence-page-customization",
];

export function createChromePorts(): AppPorts {
  const manifest = chrome.runtime.getManifest();
  const site = createSiteContext();
  const research = chromeResearchPort();

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

    navigateToSource: async ({ url }) => {
      const targetProfile = profileFromTabUrl(url);
      if (!targetProfile) {
        throw new ReadError("unknown", "The citation is not on an approved Atlassian host.");
      }
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab?.id === undefined || !tab.url) {
        throw new ReadError("unknown", "The active Atlassian tab is unavailable.");
      }
      const activeProfile = profileFromTabUrl(tab.url);
      if (!activeProfile || new URL(tab.url).origin !== new URL(url).origin) {
        throw new ReadError("unknown", "The citation belongs to another Atlassian site.");
      }
      await chrome.tabs.update(tab.id, { url });
    },

    pdf: chromePdfExportPort(),
    docx: chromeDocxExportPort(),
    docxTemplates: chromeDocxTemplateStore(site),
    templates: chromeTemplateLibrary(site),
    settings: chromeSettingsStore(),
    research,
    chat: chromeChatAgentPort(research),
    localModel: chromeBrowserLocalModelPortV1(),
    // `countScopePages` is deliberately NOT supplied — see the note above.
  };
}
