import React, { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  createActionCatalog,
  type ActionIconTokenV1,
  type ActionResultV1,
} from "@atlcli/action-registry";
import {
  Activity,
  FileText,
  FileType2,
  PanelRightOpen,
  Puzzle,
  Search,
  Settings,
  Sparkles,
} from "lucide-react";
import {
  ActionPaletteV1,
  type ActionPaletteExecutorV1,
} from "@atlcli/action-palette-react";
import {
  isActionPaletteStreamEventV1,
  type ActionPaletteCatalogProjectionV1,
  type ActionPaletteRequestV1,
  type ActionPaletteResponseV1,
} from "../../utils/action-palette/protocol.js";
import "@atlcli/action-palette-react/styles.css";
import "./style.css";

type FramePhaseV1 = "closed" | "loading" | "ready" | "error";

type ContentToFrameMessageV1 =
  | { readonly kind: "action-palette-frame:open" }
  | { readonly kind: "action-palette-frame:close" }
  | { readonly kind: "action-palette-frame:response"; readonly response: ActionPaletteResponseV1 }
  | { readonly kind: "action-palette-frame:stream"; readonly event: Extract<ActionPaletteResponseV1, { kind: "action-palette:stream-event" }> };

type FrameToContentMessageV1 =
  | { readonly kind: "action-palette-frame:ready" }
  | { readonly kind: "action-palette-frame:close" }
  | { readonly kind: "action-palette-frame:request"; readonly message: ActionPaletteRequestV1 };

interface FrameViewV1 {
  readonly phase: FramePhaseV1;
  readonly catalog: ActionPaletteCatalogProjectionV1 | null;
  readonly shortcut: { readonly status: "assigned" | "unbound"; readonly value: string | null };
}

const CLOSED_VIEW: FrameViewV1 = {
  phase: "closed",
  catalog: null,
  shortcut: { status: "unbound", value: null },
};

let channel: MessagePort | null = null;
const pending = new Map<string, (response: ActionPaletteResponseV1) => void>();
const streamListeners = new Map<string, (event: Extract<ActionPaletteResponseV1, { kind: "action-palette:stream-event" }>) => void>();
const listeners = new Set<(message: ContentToFrameMessageV1) => void>();
let queuedControl: Extract<ContentToFrameMessageV1, { kind: "action-palette-frame:open" | "action-palette-frame:close" }> | null = null;

function isContentMessageV1(value: unknown): value is ContentToFrameMessageV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (message.kind === "action-palette-frame:open" || message.kind === "action-palette-frame:close") {
    return Object.keys(message).length === 1;
  }
  if (message.kind === "action-palette-frame:stream") {
    return Object.keys(message).length === 2 && isActionPaletteStreamEventV1(message.event);
  }
  return message.kind === "action-palette-frame:response" &&
    Object.keys(message).length === 2 && Boolean(message.response && typeof message.response === "object");
}

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window.parent ||
      !/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.atlassian\.net$/iu.test(event.origin) ||
      !event.data || typeof event.data !== "object" ||
      Object.keys(event.data).length !== 1 ||
      (event.data as { kind?: unknown }).kind !== "action-palette-frame:connect" ||
      event.ports.length !== 1 || channel) return;
  channel = event.ports[0]!;
  channel.addEventListener("message", (portEvent: MessageEvent<unknown>) => {
    if (!isContentMessageV1(portEvent.data)) return;
    if (portEvent.data.kind === "action-palette-frame:response") {
      const resolve = pending.get(portEvent.data.response.requestId);
      if (resolve) {
        pending.delete(portEvent.data.response.requestId);
        resolve(portEvent.data.response);
      }
      return;
    }
    if (portEvent.data.kind === "action-palette-frame:stream") {
      streamListeners.get(portEvent.data.event.executionId)?.(portEvent.data.event);
      return;
    }
    if (listeners.size === 0) queuedControl = portEvent.data;
    else for (const listener of listeners) listener(portEvent.data);
  });
  channel.start();
  channel.postMessage({ kind: "action-palette-frame:ready" } satisfies FrameToContentMessageV1);
});

function post(message: FrameToContentMessageV1): void {
  if (!channel) throw new Error("The action palette transport is not connected.");
  channel.postMessage(message);
}

function requestId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function request(
  message: ActionPaletteRequestV1,
  timeoutMs = 3_000,
): Promise<ActionPaletteResponseV1> {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      pending.delete(message.requestId);
      reject(new Error("The action palette request timed out."));
    }, timeoutMs);
    pending.set(message.requestId, (response) => {
      globalThis.clearTimeout(timeout);
      resolve(response);
    });
    try {
      post({ kind: "action-palette-frame:request", message });
    } catch (error) {
      globalThis.clearTimeout(timeout);
      pending.delete(message.requestId);
      reject(error);
    }
  });
}

function contextLabel(catalog: ActionPaletteCatalogProjectionV1): string {
  const product = catalog.context.product === "confluence"
    ? "Confluence"
    : catalog.context.product === "jira"
      ? "Jira"
      : "Atlassian";
  const identity = catalog.context.entity?.key ?? catalog.context.entity?.id;
  return identity ? `${product} · ${identity}` : product;
}

function actionIcon(token: ActionIconTokenV1): ReactNode {
  const Icon = token === "activity"
    ? Activity
    : token === "document-docx"
      ? FileType2
      : token === "document-pdf"
        ? FileText
        : token === "research"
          ? Search
          : token === "settings"
            ? Settings
            : token === "sidebar"
              ? PanelRightOpen
              : token === "sparkles"
                ? Sparkles
                : Puzzle;
  return <Icon size={18} strokeWidth={1.8} />;
}

function HostStatus({
  phase,
  onRetry,
  onClose,
}: {
  readonly phase: "loading" | "error";
  readonly onRetry: () => void;
  readonly onClose: () => void;
}): ReactNode {
  const loading = phase === "loading";
  return (
    <div className="atlcli-action-palette-layer" data-testid={`palette-host-${phase}`}>
      <button type="button" className="atlcli-action-palette-backdrop" aria-label="Close" onClick={onClose} />
      <section
        className="atlcli-action-palette-frame atlcli-action-palette-host-status"
        role="dialog"
        aria-modal="true"
        aria-labelledby="atlcli-action-palette-host-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <span className={loading ? "atlcli-action-palette-progress" : "atlcli-action-palette-status-mark"} aria-hidden="true">
          {loading ? "" : "!"}
        </span>
        <h1 id="atlcli-action-palette-host-title">
          {loading ? "Loading actions…" : "Actions are temporarily unavailable"}
        </h1>
        <p aria-live="polite">
          {loading
            ? "Checking the current Atlassian context and available capabilities."
            : "The extension could not validate this page. You can try again without reloading it."}
        </p>
        <div className="atlcli-action-palette-host-actions">
          {!loading ? <button type="button" className="atlcli-action-palette-primary" onClick={onRetry}>Try again</button> : null}
          <button type="button" className="atlcli-action-palette-secondary" onClick={onClose}>Close</button>
        </div>
      </section>
    </div>
  );
}

function App(): ReactNode {
  const [view, setView] = useState<FrameViewV1>(CLOSED_VIEW);
  const [generation, setGeneration] = useState(0);
  const close = useCallback(() => {
    setGeneration((value) => value + 1);
    setView(CLOSED_VIEW);
    post({ kind: "action-palette-frame:close" });
  }, []);
  const open = useCallback(async () => {
    const current = generation + 1;
    setGeneration(current);
    setView({ ...CLOSED_VIEW, phase: "loading" });
    const locale = navigator.language || "en";
    try {
      const [catalogResponse, diagnosticsResponse] = await Promise.all([
        request({ kind: "action-palette:catalog", requestId: requestId("catalog"), locale }),
        request({ kind: "action-palette:diagnostics", requestId: requestId("diagnostics") }),
      ]);
      setGeneration((latest) => {
        if (latest !== current) return latest;
        if (catalogResponse.kind !== "action-palette:catalog-result") {
          setView({ ...CLOSED_VIEW, phase: "error" });
          return latest;
        }
        setView({
          phase: "ready",
          catalog: catalogResponse.catalog,
          shortcut: diagnosticsResponse.kind === "action-palette:diagnostics-result"
            ? diagnosticsResponse.shortcut
            : CLOSED_VIEW.shortcut,
        });
        return latest;
      });
    } catch {
      setGeneration((latest) => {
        if (latest === current) setView({ ...CLOSED_VIEW, phase: "error" });
        return latest;
      });
    }
  }, [generation]);
  useEffect(() => {
    const listener = (message: ContentToFrameMessageV1): void => {
      if (message.kind === "action-palette-frame:open") void open();
      else if (message.kind === "action-palette-frame:close") {
        setGeneration((value) => value + 1);
        setView(CLOSED_VIEW);
      }
    };
    listeners.add(listener);
    if (queuedControl) {
      const message = queuedControl;
      queuedControl = null;
      listener(message);
    }
    return () => { listeners.delete(listener); };
  }, [open]);
  const projection = view.catalog;
  const catalog = useMemo(
    () => projection ? createActionCatalog(projection.modules, projection.context) : null,
    [projection],
  );
  const executor = useMemo<ActionPaletteExecutorV1 | null>(() => {
    if (!projection) return null;
    let active: {
      readonly id: string;
      readonly actionId: string;
      cancelled: boolean;
    } | null = null;
    return {
    async execute(execution, signal, onStream): Promise<ActionResultV1> {
      const id = requestId("execute");
      active = { id, actionId: execution.actionId, cancelled: false };
      let lastStreamSequence = -1;
      if (onStream) {
        streamListeners.set(id, (event) => {
          if (event.sequence <= lastStreamSequence) return;
          lastStreamSequence = event.sequence;
          onStream({
            sequence: event.sequence,
            status: event.status,
            ...(event.delta === undefined ? {} : { delta: event.delta }),
          });
        });
      }
      const abort = (): void => {
        if (active?.id === id && active.cancelled) return;
        void request({
          kind: "action-palette:stream-control",
          requestId: requestId("control"),
          executionId: id,
          command: "detach",
        }).catch(() => undefined);
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      try {
        const response = await request({
          kind: "action-palette:execute",
          requestId: id,
          catalogRevision: projection.revision,
          actionId: execution.actionId,
          locale: execution.locale,
          ...(execution.input ? { input: execution.input } : {}),
        }, 120_000);
        if (response.kind === "action-palette:execute-result") return response.result;
        if (response.kind === "action-palette:error") {
          return {
            status: "failed",
            errorCode: response.code,
            messageKey: `atlcli.action.error.${response.code}`,
            retryable: response.retryable,
          };
        }
        throw new Error("Unexpected action palette response.");
      } finally {
        signal.removeEventListener("abort", abort);
        streamListeners.delete(id);
        if (active?.id === id) active = null;
      }
    },
    async cancel(execution) {
      if (!active || active.actionId !== execution.actionId) return;
      active.cancelled = true;
      await request({
        kind: "action-palette:stream-control",
        requestId: requestId("control"),
        executionId: active.id,
        command: "abort",
      });
    },
  };
  }, [projection]);

  if (view.phase === "closed") return null;
  if (view.phase === "loading" || view.phase === "error") {
    return <HostStatus phase={view.phase} onRetry={() => void open()} onClose={close} />;
  }
  if (!projection || !catalog || !executor) return null;
  return (
    <ActionPaletteV1
      open
      catalog={catalog}
      executor={executor}
      contextLabel={contextLabel(projection)}
      resolveIcon={actionIcon}
      footerLeading={view.shortcut.status === "assigned"
        ? <span><kbd>{view.shortcut.value}</kbd> Toggle</span>
        : <span>Shortcut not assigned · configure in Settings</span>}
      lifecycle={{ onCloseRequested: close }}
    />
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Action palette root is missing.");
createRoot(root).render(<App />);
