import { defineContentScript } from "wxt/utils/define-content-script";
import { createShadowRootUi } from "wxt/utils/content-script-ui/shadow-root";
import {
  isActionPaletteStreamEventV1,
  isActionPaletteRequestV1,
  type ActionPaletteRequestV1,
  type ActionPaletteResponseV1,
} from "../../utils/action-palette/protocol.js";
import "./style.css";

interface ToggleMessageV1 {
  readonly kind: "action-palette:toggle";
  readonly requestId: string;
}

type FrameToContentMessageV1 =
  | { readonly kind: "action-palette-frame:ready" }
  | { readonly kind: "action-palette-frame:close" }
  | {
      readonly kind: "action-palette-frame:request";
      readonly message: ActionPaletteRequestV1;
    };

type ContentToFrameMessageV1 =
  | { readonly kind: "action-palette-frame:open" }
  | { readonly kind: "action-palette-frame:close" }
  | {
      readonly kind: "action-palette-frame:response";
      readonly response: ActionPaletteResponseV1;
    }
  | {
      readonly kind: "action-palette-frame:stream";
      readonly event: Extract<ActionPaletteResponseV1, { kind: "action-palette:stream-event" }>;
    };

interface FocusSnapshotV1 {
  readonly element: HTMLElement | null;
  readonly ranges: readonly Range[];
}

export function isToggleMessageV1(value: unknown): value is ToggleMessageV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return Object.keys(message).length === 2 &&
    message.kind === "action-palette:toggle" &&
    typeof message.requestId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(message.requestId);
}

export function isFrameMessageV1(value: unknown): value is FrameToContentMessageV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (message.kind === "action-palette-frame:ready" || message.kind === "action-palette-frame:close") {
    return Object.keys(message).length === 1;
  }
  return message.kind === "action-palette-frame:request" &&
    Object.keys(message).length === 2 &&
    isActionPaletteRequestV1(message.message);
}

export function captureFocusV1(): FocusSnapshotV1 {
  const element = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = globalThis.getSelection?.();
  const ranges: Range[] = [];
  if (element?.isContentEditable && selection) {
    for (let index = 0; index < selection.rangeCount; index += 1) {
      ranges.push(selection.getRangeAt(index).cloneRange());
    }
  }
  return { element, ranges };
}

export function restoreFocusV1(snapshot: FocusSnapshotV1 | null): void {
  if (!snapshot) return;
  queueMicrotask(() => {
    if (!snapshot.element?.isConnected) return;
    snapshot.element.focus({ preventScroll: true });
    if (!snapshot.element.isContentEditable || snapshot.ranges.length === 0) return;
    const selection = globalThis.getSelection?.();
    if (!selection) return;
    selection.removeAllRanges();
    for (const range of snapshot.ranges) {
      if (range.startContainer.isConnected && range.endContainer.isConnected) selection.addRange(range);
    }
  });
}

/**
 * Attach the frame load listener before either assigning its URL or appending
 * it. A cached extension page may finish loading while `append()` is running;
 * registering afterwards loses the one-shot transport handshake and leaves a
 * permanently blank palette frame.
 */
export function appendActionPaletteFrameV1(
  container: HTMLElement,
  iframe: HTMLIFrameElement,
  src: string,
  onLoad: () => void,
): void {
  iframe.addEventListener("load", onLoad, { once: true });
  iframe.src = src;
  container.append(iframe);
}

/**
 * Tear down the frame transport after every close. Reusing a detached or
 * invalidated MessagePort can leave the retained iframe visibly blank on the
 * next shortcut; a fresh frame is cheap and gives every open a new handshake.
 */
export async function releaseActionPaletteHostV1(
  host: PromiseLike<{ remove(): void }> | null,
): Promise<void> {
  if (!host) return;
  try {
    const ui = await host;
    ui.remove();
  } catch {
    // A failed mount has no retained transport to release.
  }
}

/**
 * The eager content-script shell does no DOM work. It loads the React host only
 * after the service worker routes the configured extension command here.
 */
export default defineContentScript({
  matches: ["https://*.atlassian.net/*"],
  runAt: "document_start",
  world: "ISOLATED",
  cssInjectionMode: "ui",

  main(ctx) {
    let open = false;
    let focusSnapshot: FocusSnapshotV1 | null = null;
    let frameReady = false;
    let port: MessagePort | null = null;
    let frame: HTMLIFrameElement | null = null;
    let hostPromise: Promise<Awaited<ReturnType<typeof createShadowRootUi<HTMLIFrameElement>>>> | null = null;

    const post = (message: ContentToFrameMessageV1): void => port?.postMessage(message);
    const close = async (): Promise<void> => {
      if (!open) return;
      open = false;
      post({ kind: "action-palette-frame:close" });
      if (hostPromise) void hostPromise.then((ui) => {
        ui.shadowHost.style.pointerEvents = "none";
        ui.shadowHost.setAttribute("aria-hidden", "true");
      });
      const snapshot = focusSnapshot;
      focusSnapshot = null;
      const closingHost = hostPromise;
      hostPromise = null;
      restoreFocusV1(snapshot);
      await releaseActionPaletteHostV1(closingHost);
      try {
        const warmHost = await getHost();
        if (!open) {
          warmHost.shadowHost.style.pointerEvents = "none";
          warmHost.shadowHost.setAttribute("aria-hidden", "true");
        }
      } catch {
        // Prewarming is an optimization. A later open still retries getHost.
        hostPromise = null;
      }
    };
    const onPortMessage = (event: MessageEvent<unknown>): void => {
      if (!isFrameMessageV1(event.data)) return;
      if (event.data.kind === "action-palette-frame:ready") {
        frameReady = true;
        if (open) post({ kind: "action-palette-frame:open" });
        return;
      }
      if (event.data.kind === "action-palette-frame:close") {
        void close();
        return;
      }
      if (!open) return;
      const requestMessage = event.data.message;
      void chrome.runtime.sendMessage(requestMessage).then((response: unknown) => {
        if (!response || typeof response !== "object" || Array.isArray(response) ||
            (response as { requestId?: unknown }).requestId !== requestMessage.requestId) return;
        post({ kind: "action-palette-frame:response", response: response as ActionPaletteResponseV1 });
      }).catch(() => {
        post({
          kind: "action-palette-frame:response",
          response: {
            kind: "action-palette:error",
            requestId: requestMessage.requestId,
            code: "execution-failed",
            retryable: true,
          },
        });
      });
    };
    const getHost = async () => {
      hostPromise ??= createShadowRootUi<HTMLIFrameElement>(ctx, {
        name: "atlcli-action-palette-root",
        position: "modal",
        zIndex: 2_147_483_646,
        mode: "open",
        inheritStyles: false,
        isolateEvents: true,
        onMount(container) {
          const iframe = document.createElement("iframe");
          iframe.title = "atlcli actions";
          iframe.allow = "clipboard-write";
          const channel = new MessageChannel();
          port = channel.port1;
          port.addEventListener("message", onPortMessage);
          port.start();
          appendActionPaletteFrameV1(
            container,
            iframe,
            chrome.runtime.getURL("/action-palette.html"),
            () => {
              iframe.contentWindow?.postMessage(
                { kind: "action-palette-frame:connect" },
                chrome.runtime.getURL("/").slice(0, -1),
                [channel.port2],
              );
            },
          );
          frame = iframe;
          return iframe;
        },
        onRemove(mounted) {
          // An immediately reopened palette may already own a new frame. The
          // stale host must never clear that newer transport's state.
          if (mounted && frame !== mounted) return;
          port?.removeEventListener("message", onPortMessage);
          port?.close();
          port = null;
          frame = null;
          frameReady = false;
        },
      });
      const ui = await hostPromise;
      ui.shadowHost.dataset.atlcliActionPaletteHost = "true";
      if (!ui.mounted) ui.mount();
      return ui;
    };
    const show = async (): Promise<void> => {
      focusSnapshot = captureFocusV1();
      open = true;
      const ui = await getHost();
      ui.shadowHost.style.pointerEvents = "auto";
      ui.shadowHost.removeAttribute("aria-hidden");
      frame?.focus({ preventScroll: true });
      if (frameReady) post({ kind: "action-palette-frame:open" });
    };
    const onMessage = (
      message: unknown,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response: ActionPaletteResponseV1) => void,
    ): boolean => {
      if (isActionPaletteStreamEventV1(message)) {
        if (open && sender.id === chrome.runtime.id) {
          post({ kind: "action-palette-frame:stream", event: message });
        }
        return false;
      }
      if (!isToggleMessageV1(message)) return false;
      void (open ? close() : show())
        .then(() => sendResponse({
          kind: "action-palette:toggle-result",
          requestId: message.requestId,
          accepted: true,
        }))
        .catch(() => sendResponse({
          kind: "action-palette:error",
          requestId: message.requestId,
          code: "execution-failed",
          retryable: true,
        }));
      return true;
    };
    chrome.runtime.onMessage.addListener(onMessage);
    ctx.onInvalidated(() => {
      chrome.runtime.onMessage.removeListener(onMessage);
      port?.removeEventListener("message", onPortMessage);
      port?.close();
    });
  },
});
