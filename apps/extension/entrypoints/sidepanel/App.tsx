/**
 * Side panel UI (spec 002 Task 4/5 + spec 003 Task 4).
 *
 * Thin imperative shell over the pure `reduce` state machine (utils/panel-state):
 *   - on mount, pull the current entity (`get-current-entity`) so there is no
 *     race with the SW's `entity-changed` push, and subscribe to future pushes;
 *   - whenever the machine enters `loading`, run the session-auth read path and
 *     dispatch the result tagged with the load's correlation token (stale
 *     results are discarded by the reducer);
 *   - render each state (idle / unsupported / loading / loaded / error) in a
 *     narrow-first layout (~320-400px, PLAN §6 risk 2). No inline scripts.
 *
 * The Debug section (Ping / WASM smoke) from spec 002 is retained.
 */
import React, { useEffect, useReducer, useState } from "react";
import type { AtlassianEntity } from "@atlcli/core";
import {
  isEntityChangedForWindow,
  type ExtResponse,
} from "../../utils/messages.js";
import type { PanelEvent } from "../../utils/panel-state.js";
import { pullCurrentEntity } from "../../utils/detection-pull.js";
import { profileFromTabUrl } from "../../utils/profile.js";
import { loadConfluencePage, ReadError, type ReadErrorKind } from "../../utils/read-path.js";
import {
  initialPanelState,
  reduce,
  type PanelState,
} from "../../utils/panel-state.js";
import { TemplateSection } from "./TemplateSection.js";
import { PdfSection } from "./PdfSection.js";

const manifest = chrome.runtime.getManifest();

/** Typed wrapper around the SW round-trip. */
async function sendToWorker(
  message: { kind: "ping" } | { kind: "wasm-smoke"; a: number; b: number }
): Promise<ExtResponse> {
  return (await chrome.runtime.sendMessage(message)) as ExtResponse;
}

/** Host of a URL for user-facing "log in to <site>" copy. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A one-line human label for a detected-but-not-exportable entity. */
function describeEntity(entity: AtlassianEntity): string {
  switch (entity.product) {
    case "confluence":
      if (entity.type === "space") return `Confluence space ${entity.spaceKey}`;
      return "Confluence content";
    case "jira":
      if (entity.type === "issue") return `Jira issue ${entity.issueKey}`;
      return `Jira board ${entity.projectKey}`;
  }
}

const ERROR_COPY: Record<ReadErrorKind, string> = {
  "not-logged-in": "You don't appear to be logged in to this Atlassian site.",
  "access-denied": "You don't have access to this page (or it was deleted).",
  network: "Network error reaching Confluence.",
  unknown: "Something went wrong loading this page.",
};

export function App(): React.JSX.Element {
  const [state, dispatch] = useReducer(reduce, initialPanelState);

  // ---- Detection: mount pull + push subscription (Task 1 wiring) -----------
  useEffect(() => {
    let cancelled = false;
    let panelWindowId: number | null = null;
    const send = (message: { kind: "get-current-entity"; windowId: number }): Promise<unknown> =>
      chrome.runtime.sendMessage(message);
    const safeDispatch = (event: PanelEvent): void => {
      if (!cancelled) dispatch(event);
    };
    const pull = (): void => {
      if (panelWindowId !== null) {
        void pullCurrentEntity(panelWindowId, send, safeDispatch);
      }
    };

    const listener = (message: unknown): void => {
      if (panelWindowId !== null && isEntityChangedForWindow(message, panelWindowId)) {
        const { detection } = message;
        dispatch({
          type: "detected",
          url: detection.url,
          entity: detection.entity,
          seq: detection.seq,
        });
      }
    };
    chrome.runtime.onMessage.addListener(listener);

    // A global side panel belongs to one Chrome window. Resolve that owning
    // window from the panel context (not from the service worker, where
    // "current window" falls back to the last-focused window), then pull the
    // exact active tab for it. Pushes received before the window id is known
    // are ignored; the immediate pull below recovers the current active URL.
    void chrome.windows
      .getCurrent()
      .then((currentWindow) => {
        if (cancelled || currentWindow.id === undefined) return;
        panelWindowId = currentWindow.id;
        pull();
      })
      .catch(() => {
        /* Window closed before initialization; do not fall back elsewhere. */
      });

    // Re-pull when the panel regains visibility/focus. After an extension reload
    // an already-open Confluence tab fires no tab event, so the mount pull is the
    // only detection path; re-pulling on visibility/focus recovers detection when
    // the user re-opens or refocuses the panel — no page reload needed (spec 003
    // E2E papercut). The reducer's seq guard keeps a stale pull from winning.
    const onVisible = (): void => {
      if (document.visibilityState === "visible") pull();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    return () => {
      cancelled = true;
      chrome.runtime.onMessage.removeListener(listener);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  // ---- Load effect: fires once per `loading` entry (keyed on the token) -----
  const loadKey = state.status === "loading" ? state.token : 0;
  useEffect(() => {
    if (state.status !== "loading") return;
    const { token, contentId, ref } = state;
    let cancelled = false;

    const profile = profileFromTabUrl(ref.url);
    if (!profile) {
      dispatch({ type: "load-failed", token, kind: "unknown" });
      return;
    }

    void loadConfluencePage(contentId, profile)
      .then((page) => {
        if (!cancelled) dispatch({ type: "load-succeeded", token, page });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const kind: ReadErrorKind = err instanceof ReadError ? err.kind : "unknown";
        dispatch({ type: "load-failed", token, kind });
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey]);

  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        fontSize: 13,
        padding: 12,
        maxWidth: 400,
        boxSizing: "border-box",
        lineHeight: 1.5,
      }}
    >
      <header style={{ marginBottom: 12 }}>
        <h1 style={{ fontSize: 15, margin: 0 }}>{manifest.name}</h1>
        <p style={{ margin: "2px 0 0", color: "#666" }}>v{manifest.version}</p>
      </header>

      <DetectionView state={state} onRetry={() => dispatch({ type: "retry" })} />

      <TemplateSection
        loadedPage={state.status === "loaded" ? state.page : null}
        pageUrl={state.status === "loaded" ? state.ref.url : null}
      />

      <PdfSection
        loadedPage={state.status === "loaded" ? state.page : null}
        pageUrl={state.status === "loaded" ? state.ref.url : null}
      />

      <DebugSection />
    </main>
  );
}

/** Renders the current panel state (PLAN §2.4). */
function DetectionView({
  state,
  onRetry,
}: {
  state: PanelState;
  onRetry: () => void;
}): React.JSX.Element {
  switch (state.status) {
    case "idle":
      return (
        <StatusCard testId="state-idle" tone="muted">
          No Atlassian page detected. Open a Confluence page to export it.
        </StatusCard>
      );

    case "unsupported":
      return (
        <StatusCard testId="state-unsupported" tone="muted">
          Detected <strong>{describeEntity(state.entity)}</strong>. Nothing to export here yet —
          open a Confluence page or blog post.
        </StatusCard>
      );

    case "loading":
      return (
        <StatusCard testId="state-loading" tone="info">
          Loading page…
        </StatusCard>
      );

    case "error":
      return (
        <StatusCard testId="state-error" tone="danger">
          <p style={{ margin: "0 0 8px" }} data-testid={`error-${state.kind}`}>
            {ERROR_COPY[state.kind]}
            {state.kind === "not-logged-in" && (
              <>
                {" "}
                Log in to <strong>{hostOf(state.ref.url)}</strong> in this tab, then retry.
              </>
            )}
          </p>
          <button type="button" onClick={onRetry} data-testid="retry">
            Retry
          </button>
        </StatusCard>
      );

    case "loaded":
      return <LoadedView state={state} onRetry={onRetry} />;
  }
}

function LoadedView({
  state,
  onRetry,
}: {
  state: Extract<PanelState, { status: "loaded" }>;
  onRetry: () => void;
}): React.JSX.Element {
  const { page } = state;
  const { details, markdown, wordCount, attachments } = page;
  const author = details.modifiedBy?.displayName;
  const modified = details.modified ? new Date(details.modified).toLocaleString() : undefined;

  return (
    <section
      data-testid="state-loaded"
      style={{
        border: "1px solid #dfe1e6",
        borderRadius: 6,
        padding: 10,
        marginBottom: 16,
      }}
    >
      <h2 style={{ fontSize: 14, margin: "0 0 6px" }} data-testid="loaded-title">
        {details.title}
      </h2>

      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: "2px 8px",
          margin: "0 0 8px",
          color: "#42526e",
        }}
      >
        <Meta label="Space" value={details.spaceKey ?? "—"} testId="loaded-space" />
        <Meta label="Version" value={details.version != null ? `v${details.version}` : "—"} testId="loaded-version" />
        {modified && <Meta label="Modified" value={author ? `${modified} · ${author}` : modified} testId="loaded-modified" />}
        <Meta label="Words" value={String(wordCount)} testId="loaded-wordcount" />
        <Meta label="Attachments" value={String(attachments.length)} testId="loaded-attachment-count" />
      </dl>

      {attachments.length > 0 && (
        <details style={{ marginBottom: 8 }}>
          <summary style={{ cursor: "pointer" }}>Attachments ({attachments.length})</summary>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }} data-testid="attachment-list">
            {attachments.map((a) => (
              <li key={a.link || a.name}>
                {a.name}{" "}
                <span style={{ color: "#7a869a" }}>
                  ({a.mediaType}
                  {a.size ? `, ${formatBytes(a.size)}` : ""})
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <details>
        <summary style={{ cursor: "pointer" }}>Markdown preview (debug)</summary>
        <pre
          data-testid="markdown-preview"
          style={{
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            background: "#f4f5f7",
            padding: 8,
            borderRadius: 4,
            marginTop: 6,
            maxHeight: 260,
            overflow: "auto",
            fontSize: 12,
          }}
        >
          {markdown}
        </pre>
      </details>

      <div style={{ marginTop: 8 }}>
        <button type="button" onClick={onRetry} data-testid="reload">
          Reload
        </button>
      </div>
    </section>
  );
}

function Meta({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId: string;
}): React.JSX.Element {
  return (
    <>
      <dt style={{ fontWeight: 600 }}>{label}</dt>
      <dd style={{ margin: 0 }} data-testid={testId}>
        {value}
      </dd>
    </>
  );
}

function StatusCard({
  children,
  tone,
  testId,
}: {
  children: React.ReactNode;
  tone: "muted" | "info" | "danger";
  testId: string;
}): React.JSX.Element {
  const palette = {
    muted: { background: "#f4f5f7", color: "#42526e" },
    info: { background: "#deebff", color: "#0747a6" },
    danger: { background: "#ffebe6", color: "#bf2600" },
  }[tone];
  return (
    <section
      data-testid={testId}
      style={{ padding: 8, borderRadius: 6, marginBottom: 16, ...palette }}
    >
      {children}
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Spec-002 debug round-trips (retained). */
function DebugSection(): React.JSX.Element {
  const [pingResult, setPingResult] = useState<string>("");
  const [wasmResult, setWasmResult] = useState<string>("");
  const [busy, setBusy] = useState<"ping" | "wasm" | null>(null);

  async function onPing(): Promise<void> {
    setBusy("ping");
    setPingResult("");
    try {
      const res = await sendToWorker({ kind: "ping" });
      setPingResult(res.kind === "pong" ? "pong" : `unexpected: ${res.kind}`);
    } catch (err) {
      setPingResult(`error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  async function onWasmSmoke(): Promise<void> {
    setBusy("wasm");
    setWasmResult("");
    const a = 40;
    const b = 2;
    try {
      const res = await sendToWorker({ kind: "wasm-smoke", a, b });
      if (res.kind === "wasm-smoke-result" && res.ok) {
        setWasmResult(`${a} + ${b} = ${res.result}`);
      } else if (res.kind === "wasm-smoke-result") {
        setWasmResult(`error: ${res.error}`);
      } else {
        setWasmResult(`unexpected: ${res.kind}`);
      }
    } catch (err) {
      setWasmResult(`error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <h2 style={{ fontSize: 12, textTransform: "uppercase", color: "#666" }}>Debug</h2>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
        <button type="button" onClick={onPing} disabled={busy !== null}>
          Ping
        </button>
        <span data-testid="ping-result">{pingResult}</span>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button type="button" onClick={onWasmSmoke} disabled={busy !== null}>
          WASM smoke
        </button>
        <span data-testid="wasm-result">{wasmResult}</span>
      </div>
    </section>
  );
}
