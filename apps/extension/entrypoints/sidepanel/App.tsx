/**
 * Side panel UI (spec 002 Task 4/5).
 *
 * Narrow-first layout (~320-400px, PLAN §6 risk 2). Shows the extension
 * name/version, a placeholder status line (page detection arrives in spec 003),
 * and a debug section that exercises the two message round-trips:
 *   - Ping:  panel -> SW -> panel (pong)
 *   - WASM:  panel -> SW -> offscreen -> SW -> panel (computed sum)
 *
 * All assets are bundled locally; no inline scripts, no remote-hosted UI.
 */
import React, { useState } from "react";
import type { ExtResponse } from "../../utils/messages.js";

const manifest = chrome.runtime.getManifest();

/** Typed wrapper around the SW round-trip. */
async function sendToWorker(
  message: { kind: "ping" } | { kind: "wasm-smoke"; a: number; b: number }
): Promise<ExtResponse> {
  return (await chrome.runtime.sendMessage(message)) as ExtResponse;
}

export function App(): React.JSX.Element {
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

      <section
        style={{
          padding: 8,
          borderRadius: 6,
          background: "#f4f5f7",
          color: "#42526e",
          marginBottom: 16,
        }}
      >
        no Atlassian page detected
      </section>

      <section>
        <h2 style={{ fontSize: 12, textTransform: "uppercase", color: "#666" }}>
          Debug
        </h2>

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
    </main>
  );
}
