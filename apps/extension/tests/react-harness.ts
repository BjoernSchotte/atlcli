/**
 * happy-dom + React harness shared by the panel's view tests.
 *
 * Not a test file — a helper, like `build-helper.ts`.
 *
 * **Why this exists as a module rather than a copied `beforeEach`.** A wave-1
 * defect left a torn-down happy-dom `window` on `globalThis`, and the damage
 * showed up as ~30 failures in `packages/diagram`'s SVG rendering — a package
 * that never mentions the extension. Scoped runs stayed green throughout. The
 * restore is therefore done from **captured property descriptors** (never
 * `delete`-and-hope) and every consumer asserts, in its own `afterAll`, that
 * the process-wide globals came back exactly as they were. Doing that once,
 * here, is what keeps the three consumers from each getting it subtly wrong.
 *
 * `chrome` is deleted for the whole file by default: these are tests of the
 * *portable* layer, and a component that quietly reaches for `chrome.*` must
 * fail here rather than in a Forge host.
 */
import type React from "react";
import { Window } from "happy-dom";

const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "location",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "KeyboardEvent",
  "File",
  "FileList",
  "Blob",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "MutationObserver",
] as const;

const TRACKED = [...DOM_GLOBALS, "chrome", "IS_REACT_ACT_ENVIRONMENT"] as const;

export interface ReactHarness {
  /** Call from `beforeEach`. */
  setup(): void;
  /** Call from `afterEach`. */
  teardown(): Promise<void>;
  /** Call from `afterAll`: `expect(harness.leakedGlobals()).toEqual([])`. */
  leakedGlobals(): string[];
  render(node: React.ReactNode): Promise<void>;
  /** Let queued promises settle and let React commit what they produced. */
  flush(times?: number): Promise<void>;
  container(): HTMLElement;
  html(): string;
  find(testId: string): HTMLElement;
  maybeFind(testId: string): HTMLElement | null;
  click(testId: string): Promise<void>;
  /** Set an `<input>`/`<select>`/`<textarea>` value and fire React's onChange. */
  setValue(testId: string, value: string): Promise<void>;
  /** Click a checkbox/radio — React wires `onChange` to the click event. */
  toggle(testId: string): Promise<boolean>;
  /** Open or close a `<details>` and fire its toggle event. */
  setOpen(testId: string, open: boolean): Promise<void>;
}

export function createReactHarness(
  options: { url?: string; keepChrome?: boolean } = {}
): ReactHarness {
  // Snapshotted at module load — i.e. before any `beforeEach` has run.
  const pristine = new Map<string, PropertyDescriptor | undefined>(
    TRACKED.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  );

  let saved: { key: string; descriptor: PropertyDescriptor | undefined }[] = [];
  let win: Window | null = null;
  let host: HTMLElement | null = null;
  let root: { render: (node: React.ReactNode) => void; unmount: () => void } | null = null;

  function install(key: string, value: unknown): void {
    saved.push({ key, descriptor: Object.getOwnPropertyDescriptor(globalThis, key) });
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  async function flush(times = 4): Promise<void> {
    const { act } = await import("react");
    for (let i = 0; i < times; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  function containerOrThrow(): HTMLElement {
    if (!host) throw new Error("harness.setup() was not called");
    return host;
  }

  async function dispatch(element: HTMLElement, type: string): Promise<void> {
    const { act } = await import("react");
    const scope = win as unknown as { Event: typeof Event; MouseEvent: typeof MouseEvent };
    await act(async () => {
      const event =
        type === "click"
          ? new scope.MouseEvent("click", { bubbles: true, cancelable: true })
          : new scope.Event(type, { bubbles: true });
      element.dispatchEvent(event);
    });
    await flush();
  }

  return {
    setup(): void {
      if (!options.keepChrome) {
        saved.push({
          key: "chrome",
          descriptor: Object.getOwnPropertyDescriptor(globalThis, "chrome"),
        });
        delete (globalThis as unknown as Record<string, unknown>).chrome;
      }
      win = new Window({ url: options.url ?? "https://example.atlassian.net/wiki" });
      for (const key of DOM_GLOBALS) {
        const value = key === "window" ? win : (win as unknown as Record<string, unknown>)[key];
        if (value === undefined) continue;
        install(key, value);
      }
      install("IS_REACT_ACT_ENVIRONMENT", true);
      host = win.document.createElement("div") as unknown as HTMLElement;
      win.document.body.appendChild(host as unknown as never);
    },

    async teardown(): Promise<void> {
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
      // Reverse order so a key installed twice lands back on its oldest value.
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
      if (!root) root = createRoot(containerOrThrow());
      await act(async () => {
        root!.render(node);
      });
      await flush();
    },

    flush,
    container: containerOrThrow,

    html(): string {
      return containerOrThrow().innerHTML;
    },

    find(testId: string): HTMLElement {
      const element = containerOrThrow().querySelector(`[data-testid="${testId}"]`);
      if (!element) {
        throw new Error(
          `no element with data-testid="${testId}" in:\n${containerOrThrow().innerHTML}`
        );
      }
      return element as unknown as HTMLElement;
    },

    maybeFind(testId: string): HTMLElement | null {
      return containerOrThrow().querySelector(
        `[data-testid="${testId}"]`
      ) as unknown as HTMLElement | null;
    },

    async click(testId: string): Promise<void> {
      await dispatch(this.find(testId), "click");
    },

    async setValue(testId: string, value: string): Promise<void> {
      const element = this.find(testId) as unknown as HTMLInputElement;
      // React installs its own `value` setter on controlled inputs and uses it
      // to remember the last value it saw. Assigning through *that* setter
      // updates the tracker too, so React concludes nothing changed and never
      // fires `onChange`. Writing through the prototype's native setter is what
      // makes the change observable — the same trick React's own test utils use.
      const prototype = Object.getPrototypeOf(element) as object;
      const native = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (native) native.call(element, value);
      else element.value = value;
      await dispatch(element as unknown as HTMLElement, "input");
      await dispatch(element as unknown as HTMLElement, "change");
    },

    async toggle(testId: string): Promise<boolean> {
      const element = this.find(testId) as unknown as HTMLInputElement;
      await dispatch(element as unknown as HTMLElement, "click");
      return element.checked;
    },

    async setOpen(testId: string, open: boolean): Promise<void> {
      const element = this.find(testId) as unknown as HTMLDetailsElement;
      element.open = open;
      await dispatch(element as unknown as HTMLElement, "toggle");
    },
  };
}
