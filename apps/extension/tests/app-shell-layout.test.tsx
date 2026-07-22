/**
 * The shell's width is host configuration, and it has to actually reach the DOM.
 *
 * `AppShell` is mounted by two hosts: the 400 px side panel and the
 * large-preview page, which owns a whole browser tab. It used to hard-code
 * `max-w-[400px]`, so the "large" preview rendered as a narrow column with the
 * PDF page shrunk to panel size — the opposite of the reason that page exists.
 *
 * `PreviewShellConfig.layout` already carried the words "compact" and "full"
 * and read as if it drove this. It did not: it only decided whether to show the
 * "Open large preview" button, plus a `data-layout` attribute. That is the same
 * shape as the two defects fixed just before this one — `containerWidth` on
 * `renderPage` and `ownOrigin` on the tab observer — an option that exists, is
 * typed, is documented, and is read by nobody for the thing it names.
 *
 * Hence two assertions rather than one: the width must differ per layout, AND
 * the preview entrypoint must actually pass `layout="full"`. Without the second,
 * the first is satisfied by a prop nothing sets.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import React from "react";
import { Window } from "happy-dom";
import { AppShell } from "../components/app/AppShell.js";
import { I18nProvider } from "../utils/i18n/context.js";
import type { ResolvedScreen, ScreenProps } from "../utils/screens/registry.js";

const DOM_GLOBALS = ["window", "document", "navigator", "Element", "Node", "HTMLElement"] as const;

let saved: { key: string; descriptor: PropertyDescriptor | undefined }[] = [];
let win: Window | null = null;
let container: HTMLElement | null = null;
let root: { render: (node: React.ReactNode) => void; unmount: () => void } | null = null;

beforeEach(() => {
  win = new Window({ url: "https://example.test/" });
  saved = [];
  for (const key of DOM_GLOBALS) {
    const value = key === "window" ? win : (win as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    saved.push({ key, descriptor: Object.getOwnPropertyDescriptor(globalThis, key) });
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  saved.push({ key: "IS_REACT_ACT_ENVIRONMENT", descriptor: undefined });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    value: true,
    writable: true,
    configurable: true,
  });
  container = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(container as unknown as never);
});

afterEach(async () => {
  if (root) {
    const { act } = await import("react");
    const current = root;
    await act(async () => {
      current.unmount();
    });
  }
  root = null;
  try {
    await win?.happyDOM?.close();
  } catch {
    /* already closed */
  }
  for (const { key, descriptor } of [...saved].reverse()) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as unknown as Record<string, unknown>)[key];
  }
  win = null;
  container = null;
});

const NOOP_SCREEN: ResolvedScreen = {
  definition: {
    id: "preview",
    labelKey: "screen.preview.label",
    icon: () => null,
    component: () => React.createElement("div", { "data-testid": "screen-body" }),
  },
  available: true,
  visible: true,
  reasonKey: null,
  unmet: [],
} as unknown as ResolvedScreen;

async function mountShell(layout?: "compact" | "full"): Promise<HTMLElement> {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  if (!root) root = createRoot(container!);
  await act(async () => {
    root!.render(
      <I18nProvider locale="en">
        <AppShell
          title="atlcli"
          version="0.0.0"
          screens={[NOOP_SCREEN]}
          active={NOOP_SCREEN}
          onNavigate={() => undefined}
          screenProps={{} as unknown as ScreenProps}
          {...(layout ? { layout } : {})}
        />
      </I18nProvider>
    );
  });
  const shell = container!.querySelector('[data-testid="app-shell"]');
  if (!shell) throw new Error(`no app shell in:\n${container!.innerHTML}`);
  return shell as unknown as HTMLElement;
}

describe("AppShell width is host configuration", () => {
  it("keeps the 400 px side-panel cap by default", async () => {
    const shell = await mountShell();
    expect(shell.className).toContain("max-w-[400px]");
  });

  it("keeps it for an explicit compact host", async () => {
    const shell = await mountShell("compact");
    expect(shell.className).toContain("max-w-[400px]");
  });

  it("drops the cap for a host that owns a whole tab", async () => {
    const shell = await mountShell("full");
    // The assertion that matters is the ABSENCE of the panel cap: a "large"
    // view capped at panel width is the bug this file exists for.
    expect(shell.className).not.toContain("max-w-[400px]");
    expect(shell.className).toContain("max-w-none");
    expect(shell.className).toContain("h-dvh");
    expect(shell.className).toContain("overflow-hidden");
    expect(shell.querySelector('[data-testid="app-nav"]')).toBeNull();
    expect(shell.querySelector('[data-testid="app-version"]')).toBeNull();
    expect(shell.querySelector('[data-testid="screen-preview"]')?.className).toContain("flex-1");
  });

  it("is actually wired: the large-preview entrypoint asks for the full width", async () => {
    // `layout` defaults to "compact", so the fix above is inert unless the tab
    // host opts in. A component test cannot see that — it passes the prop
    // itself.
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      new URL("../entrypoints/preview/App.tsx", import.meta.url),
      "utf8"
    );
    expect(source).toMatch(/layout=("full"|{"full"})/);
    expect(source).toMatch(/closePreview:\s*\(\)\s*=>\s*window\.close\(\)/);
  });
});
