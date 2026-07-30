/**
 * Pure Atlassian Whiteboard linked-card renderer.
 *
 * Embedded Whiteboards carry a navigation URL in page ADF, but no public
 * preview/body bytes. This renderer intentionally consumes only that retained
 * parameter and the host-proven site origin: it never calls a port and never
 * claims that Whiteboard content was exported.
 */
import type { ExportBlock, ExportNote } from "@atlcli/confluence";
import { macroParamText } from "./params.js";
import type {
  MacroExportContext,
  MacroInstance,
  MacroRenderer,
  MacroRenderResult,
} from "./types.js";

const WHITEBOARD_EXTENSION_TYPE = "com.atlassian.confluence.macro.core";
const WHITEBOARD_EXTENSION_KEY = "native-embed:whiteboard";
const WHITEBOARD_LABEL = "Atlassian Whiteboard";

export type WhiteboardTargetFailure =
  | "missing-url"
  | "trusted-site-unavailable"
  | "malformed-url"
  | "unsupported-scheme"
  | "protocol-relative"
  | "unsafe-relative"
  | "credentials"
  | "fragment"
  | "cross-site"
  | "malformed-route"
  | "invalid-space-key"
  | "invalid-whiteboard-id";

export type WhiteboardTargetVerdict =
  | { safe: true; url: string }
  | { safe: false; reason: WhiteboardTargetFailure };

/**
 * Validate and canonicalize an untrusted embedded-Whiteboard URL.
 *
 * Only the documented Cloud navigation route is accepted. Relative input must
 * be origin-relative (`/wiki/...`) so it cannot inherit a source page path.
 * Queries are deliberately discarded: no query parameter is required for
 * ordinary Whiteboard navigation.
 */
export function whiteboardTargetVerdict(
  rawUrl: string | undefined,
  siteOrigin: string | undefined,
): WhiteboardTargetVerdict {
  const raw = rawUrl?.trim();
  if (!raw) return { safe: false, reason: "missing-url" };

  const trusted = trustedOrigin(siteOrigin);
  if (!trusted) return { safe: false, reason: "trusted-site-unavailable" };

  if (raw.startsWith("//")) return { safe: false, reason: "protocol-relative" };
  // URL parsers normalize these bytes or treat backslashes as path separators.
  // Reject them before parsing so validation applies to exactly what ADF held.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f\\]/u.test(raw) || hasDotPathSegment(raw)) {
    return { safe: false, reason: "malformed-url" };
  }

  const hasScheme = /^[a-z][a-z0-9+.-]*:/iu.test(raw);
  if (!hasScheme && !raw.startsWith("/")) {
    return { safe: false, reason: "unsafe-relative" };
  }

  let target: URL;
  try {
    target = new URL(raw, trusted.origin);
  } catch {
    return { safe: false, reason: "malformed-url" };
  }

  if (target.protocol !== "https:") {
    return { safe: false, reason: "unsupported-scheme" };
  }
  if (target.username || target.password) {
    return { safe: false, reason: "credentials" };
  }
  if (raw.includes("#")) {
    return { safe: false, reason: "fragment" };
  }
  if (target.origin !== trusted.origin) {
    return { safe: false, reason: "cross-site" };
  }

  const match = target.pathname.match(
    /^\/wiki\/spaces\/([^/]+)\/whiteboard\/([^/]+)\/?$/u,
  );
  if (!match) return { safe: false, reason: "malformed-route" };

  const spaceKey = decodePathSegment(match[1]!);
  const whiteboardId = decodePathSegment(match[2]!);
  if (spaceKey === undefined || whiteboardId === undefined) {
    return { safe: false, reason: "malformed-route" };
  }
  // Atlassian documents custom space keys as 1–255 alphanumerics. The leading
  // "~" additionally covers Confluence personal-space routes.
  if (!/^~?[a-z0-9]{1,255}$/iu.test(spaceKey)) {
    return { safe: false, reason: "invalid-space-key" };
  }
  // REST v2 documents the Whiteboard path id as an integer.
  if (!/^[1-9][0-9]*$/u.test(whiteboardId)) {
    return { safe: false, reason: "invalid-whiteboard-id" };
  }

  return {
    safe: true,
    url:
      `${trusted.origin}/wiki/spaces/${encodeURIComponent(spaceKey)}` +
      `/whiteboard/${whiteboardId}`,
  };
}

function trustedOrigin(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.origin === "null"
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function decodePathSegment(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.includes("/") || decoded.includes("\\") ? undefined : decoded;
  } catch {
    return undefined;
  }
}

function hasDotPathSegment(value: string): boolean {
  const withoutQueryOrFragment = value.split(/[?#]/u, 1)[0] ?? "";
  return /(?:^|\/)(?:\.{1,2}|%2e(?:%2e)?)(?:\/|$)/iu.test(
    withoutQueryOrFragment,
  );
}

function fallbackBlock(): ExportBlock {
  return {
    type: "paragraph",
    content: [{ type: "text", text: `${WHITEBOARD_LABEL} (link unavailable)` }],
  };
}

function failureNote(
  macroName: string,
  reason: WhiteboardTargetFailure,
): ExportNote {
  const explanation: Record<WhiteboardTargetFailure, string> = {
    "missing-url": "has no navigation target",
    "trusted-site-unavailable": "could not be checked against a trusted site",
    "malformed-url": "has a malformed navigation target",
    "unsupported-scheme": "uses an unsupported URL scheme",
    "protocol-relative": "uses a protocol-relative target",
    "unsafe-relative": "uses an unsafe relative target",
    credentials: "contains URL credentials",
    fragment: "contains a fragment destination",
    "cross-site": "points to a different site",
    "malformed-route": "does not use the documented Whiteboard route",
    "invalid-space-key": "contains an invalid space key",
    "invalid-whiteboard-id": "contains an invalid Whiteboard id",
  };
  return {
    level: "warning",
    code: "macro-degraded",
    message:
      `The embedded Atlassian Whiteboard ${explanation[reason]}; ` +
      "a visible non-clickable fallback was emitted.",
    macroName,
  };
}

export function whiteboardRenderer(): MacroRenderer {
  return {
    id: "whiteboard-linked-card",
    macros: [WHITEBOARD_EXTENSION_KEY],
    requiresLivePort: false,
    async render(
      macro: MacroInstance,
      ctx: MacroExportContext,
    ): Promise<MacroRenderResult> {
      if (
        macro.adfExtension?.extensionType !== WHITEBOARD_EXTENSION_TYPE ||
        macro.adfExtension.extensionKey.toLowerCase() !== WHITEBOARD_EXTENSION_KEY
      ) {
        return { kind: "skip" };
      }

      const verdict = whiteboardTargetVerdict(
        macroParamText(macro.params, "url"),
        ctx.siteOrigin,
      );
      if (!verdict.safe) {
        return {
          kind: "blocks",
          blocks: [fallbackBlock()],
          notes: [failureNote(macro.name, verdict.reason)],
        };
      }

      return {
        kind: "blocks",
        blocks: [{
          type: "smartCard",
          card: {
            appearance: "block",
            source: "url",
            url: verdict.url,
            target: { kind: "external", href: verdict.url },
            title: WHITEBOARD_LABEL,
          },
        }],
        notes: [{
          level: "info",
          code: "macro-rendered-via",
          message:
            "The embedded Atlassian Whiteboard was represented as a linked card; " +
            "Whiteboard pixels and editable content were not exported.",
          macroName: macro.name,
        }],
      };
    },
  };
}
