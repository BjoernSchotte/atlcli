import { extractEntityFromUrl, type AtlassianEntity } from "@atlcli/core";
import {
  parseActionSurfaceContextV1,
  type ActionEntityV1,
  type ActionSurfaceContextV1,
} from "@atlcli/action-registry";

export interface ActionPaletteSenderV1 {
  readonly tabId: number;
  readonly documentId: string;
  readonly frameId: number;
  readonly origin: string;
  readonly url?: string;
}

export interface ActionPaletteTabV1 {
  readonly id: number;
  readonly url?: string;
}

export interface ActionPaletteContextBindingV1 extends ActionPaletteSenderV1 {
  readonly frameId: 0;
  readonly url: string;
}

export interface DerivedActionPaletteContextV1 {
  readonly binding: ActionPaletteContextBindingV1;
  readonly context: ActionSurfaceContextV1;
}

export class ActionPaletteContextError extends Error {
  constructor(readonly code: "unsupported-context" | "stale-context") {
    super(code);
    this.name = "ActionPaletteContextError";
  }
}

function isAtlassianCloudOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.atlassian\.net$/iu.test(url.hostname) &&
      url.origin === origin;
  } catch {
    return false;
  }
}

function projectEntity(entity: AtlassianEntity, url: string): ActionEntityV1 {
  if (entity.product === "confluence" && entity.type === "page") {
    return { kind: "atlcli.entity.confluence-page", id: entity.pageId, key: entity.spaceKey, url };
  }
  if (entity.product === "confluence" && entity.type === "blogpost") {
    return { kind: "atlcli.entity.confluence-blogpost", id: entity.contentId, key: entity.spaceKey, url };
  }
  if (entity.product === "confluence") {
    return { kind: "atlcli.entity.confluence-space", id: entity.spaceKey, key: entity.spaceKey, url };
  }
  if (entity.type === "issue") {
    return { kind: "atlcli.entity.jira-issue", id: entity.issueKey, key: entity.issueKey, url };
  }
  return { kind: "atlcli.entity.jira-board", id: entity.boardId, key: entity.projectKey, url };
}

export function deriveActionPaletteContextV1(input: {
  readonly sender: ActionPaletteSenderV1;
  readonly tab: ActionPaletteTabV1;
  readonly locale: string;
  readonly capabilities: readonly string[];
}): DerivedActionPaletteContextV1 {
  const { sender, tab } = input;
  if (!Number.isSafeInteger(sender.tabId) || sender.tabId < 0 || sender.frameId !== 0 ||
      !sender.documentId || tab.id !== sender.tabId || !tab.url) {
    throw new ActionPaletteContextError("unsupported-context");
  }
  let tabUrl: URL;
  try {
    tabUrl = new URL(tab.url);
  } catch {
    throw new ActionPaletteContextError("unsupported-context");
  }
  if (!isAtlassianCloudOrigin(tabUrl.origin)) {
    throw new ActionPaletteContextError("unsupported-context");
  }
  if (sender.origin !== tabUrl.origin) {
    throw new ActionPaletteContextError("stale-context");
  }
  if (sender.url !== undefined) {
    let senderUrl: URL;
    try {
      senderUrl = new URL(sender.url);
    } catch {
      throw new ActionPaletteContextError("stale-context");
    }
    if (senderUrl.origin !== tabUrl.origin) throw new ActionPaletteContextError("stale-context");
  }
  const entity = extractEntityFromUrl(tab.url);
  const context = parseActionSurfaceContextV1({
    siteOrigin: tabUrl.origin,
    product: entity?.product ?? "atlassian",
    ...(entity ? { entity: projectEntity(entity, tab.url) } : {}),
    locale: input.locale,
    capabilities: [...new Set(input.capabilities)].sort(),
  });
  return {
    binding: {
      tabId: sender.tabId,
      documentId: sender.documentId,
      frameId: 0,
      origin: sender.origin,
      url: tab.url,
    },
    context,
  };
}

export function bindingsEqualV1(
  left: ActionPaletteContextBindingV1,
  right: ActionPaletteContextBindingV1,
): boolean {
  return left.tabId === right.tabId && left.documentId === right.documentId &&
    left.frameId === 0 && right.frameId === 0 && left.origin === right.origin && left.url === right.url;
}
