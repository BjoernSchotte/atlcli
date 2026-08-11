import type React from "react";
import { Window } from "happy-dom";

const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "location",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLSelectElement",
  "HTMLButtonElement",
  "HTMLFormElement",
  "Element",
  "SVGElement",
  "Node",
  "DocumentFragment",
  "ShadowRoot",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "FocusEvent",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "MutationObserver",
] as const;

const TRACKED = [...DOM_GLOBALS, "IS_REACT_ACT_ENVIRONMENT"] as const;

export interface PaletteReactHarness {
  setup(): void;
  teardown(): Promise<void>;
  leakedGlobals(): string[];
  render(node: React.ReactNode): Promise<void>;
  flush(times?: number): Promise<void>;
  window(): Window;
  container(): HTMLElement;
  html(): string;
  find(testId: string): HTMLElement;
  maybeFind(testId: string): HTMLElement | null;
  click(testId: string): Promise<void>;
  keyDown(testId: string, key: string, options?: KeyboardEventInit): Promise<void>;
  setValue(testId: string, value: string): Promise<void>;
}

export function createPaletteReactHarness(): PaletteReactHarness {
  const pristine = new Map<string, PropertyDescriptor | undefined>(
    TRACKED.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  let saved: Array<{ key: string; descriptor: PropertyDescriptor | undefined }> = [];
  let win: Window | null = null;
  let host: HTMLElement | null = null;
  let root: { render(node: React.ReactNode): void; unmount(): void } | null = null;

  function install(key: string, value: unknown): void {
    saved.push({ key, descriptor: Object.getOwnPropertyDescriptor(globalThis, key) });
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }

  function currentWindow(): Window {
    if (!win) throw new Error("harness.setup() was not called");
    return win;
  }

  function currentHost(): HTMLElement {
    if (!host) throw new Error("harness.setup() was not called");
    return host;
  }

  async function flush(times = 4): Promise<void> {
    const { act } = await import("react");
    for (let index = 0; index < times; index += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  async function dispatch(
    element: HTMLElement,
    event: Event,
  ): Promise<void> {
    const { act } = await import("react");
    await act(async () => {
      element.dispatchEvent(event);
    });
    await flush();
  }

  return {
    setup(): void {
      win = new Window({ url: "https://example.atlassian.net/wiki" });
      for (const key of DOM_GLOBALS) {
        const value = key === "window" ? win : (win as unknown as Record<string, unknown>)[key];
        if (value !== undefined) install(key, value);
      }
      install("IS_REACT_ACT_ENVIRONMENT", true);
      host = win.document.createElement("div") as unknown as HTMLElement;
      win.document.body.appendChild(host as unknown as never);
    },

    async teardown(): Promise<void> {
      if (root) {
        const { act } = await import("react");
        const current = root;
        await act(async () => current.unmount());
      }
      root = null;
      try {
        await win?.happyDOM?.close();
      } catch {
        // Already closed; teardown must remain idempotent.
      }
      for (const { key, descriptor } of [...saved].reverse()) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as unknown as Record<string, unknown>)[key];
      }
      saved = [];
      win = null;
      host = null;
    },

    leakedGlobals(): string[] {
      return [...pristine]
        .filter(([key, before]) => {
          const after = Object.getOwnPropertyDescriptor(globalThis, key);
          if ((before === undefined) !== (after === undefined)) return true;
          if (!before || !after) return false;
          return before.value !== after.value || before.get !== after.get;
        })
        .map(([key]) => key);
    },

    async render(node: React.ReactNode): Promise<void> {
      const { act } = await import("react");
      const { createRoot } = await import("react-dom/client");
      if (!root) root = createRoot(currentHost());
      await act(async () => root!.render(node));
      await flush();
    },

    flush,
    window: currentWindow,
    container: currentHost,
    html: () => currentHost().innerHTML,

    find(testId: string): HTMLElement {
      const element = currentHost().querySelector(`[data-testid="${testId}"]`);
      if (!element) throw new Error(`No ${testId} in:\n${currentHost().innerHTML}`);
      return element as unknown as HTMLElement;
    },

    maybeFind(testId: string): HTMLElement | null {
      return currentHost().querySelector(
        `[data-testid="${testId}"]`,
      ) as unknown as HTMLElement | null;
    },

    async click(testId: string): Promise<void> {
      const scope = currentWindow() as unknown as { MouseEvent: typeof MouseEvent };
      await dispatch(
        this.find(testId),
        new scope.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    },

    async keyDown(
      testId: string,
      key: string,
      options: KeyboardEventInit = {},
    ): Promise<void> {
      const scope = currentWindow() as unknown as { KeyboardEvent: typeof KeyboardEvent };
      await dispatch(
        this.find(testId),
        new scope.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key,
          ...options,
        }),
      );
    },

    async setValue(testId: string, value: string): Promise<void> {
      const element = this.find(testId) as HTMLInputElement | HTMLTextAreaElement;
      const prototype = Object.getPrototypeOf(element) as object;
      const nativeSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (nativeSetter) nativeSetter.call(element, value);
      else element.value = value;
      const scope = currentWindow() as unknown as { Event: typeof Event };
      await dispatch(element, new scope.Event("input", { bubbles: true }));
      await dispatch(element, new scope.Event("change", { bubbles: true }));
    },
  };
}
