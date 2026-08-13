import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendActionPaletteFrameV1,
  captureFocusV1,
  isFrameMessageV1,
  isToggleMessageV1,
  releaseActionPaletteHostV1,
  restoreFocusV1,
  setActionPaletteHostVisibleV1,
} from "../entrypoints/atlassian-action-palette.content/index.js";
import { createReactHarness } from "./react-harness.js";

const dom = createReactHarness();
beforeEach(() => dom.setup());
afterEach(() => dom.teardown());
afterAll(() => expect(dom.leakedGlobals()).toEqual([]));

describe("action palette content-shell protocol", () => {
  test("accepts only exact toggle and authority-free frame requests", () => {
    expect(isToggleMessageV1({ kind: "action-palette:toggle", requestId: "toggle:1" })).toBe(true);
    expect(isToggleMessageV1({ kind: "action-palette:toggle", requestId: "toggle:1", tabId: 7 })).toBe(false);
    expect(isFrameMessageV1({ kind: "action-palette-frame:ready" })).toBe(true);
    expect(isFrameMessageV1({
      kind: "action-palette-frame:request",
      message: { kind: "action-palette:catalog", requestId: "catalog:1", locale: "en-US" },
    })).toBe(true);
    expect(isFrameMessageV1({
      kind: "action-palette-frame:request",
      message: {
        kind: "action-palette:catalog",
        requestId: "catalog:1",
        locale: "en-US",
        siteOrigin: "https://attacker.invalid",
      },
    })).toBe(false);
  });

  test("restores the exact contenteditable focus and selection range", async () => {
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.textContent = "Editable selection survives";
    document.body.append(editor);
    editor.focus();
    const range = document.createRange();
    range.setStart(editor.firstChild!, 0);
    range.setEnd(editor.firstChild!, 8);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const snapshot = captureFocusV1();

    const temporary = document.createElement("button");
    document.body.append(temporary);
    temporary.focus();
    selection.removeAllRanges();
    restoreFocusV1(snapshot);
    await Promise.resolve();

    expect(document.activeElement).toBe(editor);
    expect(window.getSelection()?.toString()).toBe("Editable");
  });

  test("registers the frame handshake before a cached append can complete", () => {
    const container = document.createElement("div");
    const iframe = document.createElement("iframe");
    let handshakes = 0;
    const append = container.append.bind(container);
    container.append = (...nodes: (Node | string)[]): void => {
      append(...nodes);
      iframe.dispatchEvent(new Event("load"));
    };

    appendActionPaletteFrameV1(
      container,
      iframe,
      "chrome-extension://fixture/action-palette.html",
      () => { handshakes += 1; },
    );
    iframe.dispatchEvent(new Event("load"));

    expect(container.firstElementChild).toBe(iframe);
    expect(iframe.src).toBe("chrome-extension://fixture/action-palette.html");
    expect(handshakes).toBe(1);
  });

  test("awaits retained frame release before the next open is acknowledged", async () => {
    let resolveHost: ((host: { remove(): void }) => void) | undefined;
    let removals = 0;
    const pending = new Promise<{ remove(): void }>((resolve) => { resolveHost = resolve; });

    const releasing = releaseActionPaletteHostV1(pending);
    expect(removals).toBe(0);
    resolveHost?.({ remove: () => { removals += 1; } });
    await releasing;

    expect(removals).toBe(1);
  });

  test("keeps the prewarmed full-viewport host visually and accessibly hidden", () => {
    const host = document.createElement("div");

    setActionPaletteHostVisibleV1(host, false);
    expect(host.style.pointerEvents).toBe("none");
    expect(host.hidden).toBe(true);
    expect(host.getAttribute("aria-hidden")).toBe("true");

    setActionPaletteHostVisibleV1(host, true);
    expect(host.style.pointerEvents).toBe("auto");
    expect(host.hidden).toBe(false);
    expect(host.hasAttribute("aria-hidden")).toBe(false);
  });
});
