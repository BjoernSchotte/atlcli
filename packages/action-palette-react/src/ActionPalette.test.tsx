import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import {
  ACTION_GROUP_IDS,
  createActionCatalog,
  type ActionModuleV1,
  type ActionResultV1,
} from "@atlcli/action-registry";
import {
  ACTION_PALETTE_MESSAGES_EN_V1,
  ActionPaletteV1,
  type ActionPaletteExecuteRequestV1,
  type ActionPaletteExecutorV1,
} from "./index.js";
import {
  createPaletteCatalogV1,
  longLabelActionV1,
  paletteContextV1,
  paletteModuleV1,
} from "./testing/fixtures.js";
import { createPaletteReactHarness } from "./testing/react-harness.js";

const dom = createPaletteReactHarness();

beforeEach(() => dom.setup());
afterEach(() => dom.teardown());
afterAll(() => expect(dom.leakedGlobals()).toEqual([]));

interface RecordedExecution {
  readonly request: ActionPaletteExecuteRequestV1;
  readonly signal: AbortSignal;
}

function executorReturning(
  result: ActionResultV1 | (() => Promise<ActionResultV1>),
  calls: RecordedExecution[] = [],
): ActionPaletteExecutorV1 {
  return {
    async execute(request, signal) {
      calls.push({ request, signal });
      return typeof result === "function" ? result() : result;
    },
  };
}

function defaultPalette(
  overrides: Partial<Parameters<typeof ActionPaletteV1>[0]> = {},
) {
  return (
    <ActionPaletteV1
      open
      catalog={createPaletteCatalogV1()}
      executor={executorReturning({ status: "completed", messageKey: "done" })}
      contextLabel="Confluence · Fixture page"
      {...overrides}
    />
  );
}

function activeOption(): HTMLElement | null {
  const activeId = dom.find("palette-search").getAttribute("aria-activedescendant");
  return activeId ? dom.container().querySelector(`[id="${activeId}"]`) : null;
}

function expectActiveElement(expected: HTMLElement): void {
  expect(Object.is(dom.window().document.activeElement, expected)).toBe(true);
}

describe("root dialog and keyboard contract", () => {
  test("renders labelled combobox/listbox groups and focuses search", async () => {
    const opened: number[] = [];
    await dom.render(defaultPalette({ lifecycle: { onOpened: () => opened.push(1) } }));

    const dialog = dom.find("action-palette").querySelector("[role='dialog']")!;
    const search = dom.find("palette-search");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(search.getAttribute("role")).toBe("combobox");
    expect(search.getAttribute("aria-controls")).toBeTruthy();
    expect(dom.container().querySelectorAll("[role='group']")).toHaveLength(3);
    expect(dom.container().querySelectorAll("[role='option']")).toHaveLength(3);
    expectActiveElement(search);
    expect(activeOption()?.textContent).toContain("Export current page as PDF");
    expect(opened).toEqual([1]);
  });

  test("renders optional host-owned footer status without changing the keyboard contract", async () => {
    await dom.render(defaultPalette({ footerLeading: <span><kbd>⌘⇧K</kbd> Open palette</span> }));
    expect(dom.find("palette-footer-leading").textContent).toContain("⌘⇧K Open palette");
    expect(dom.find("palette-search").getAttribute("aria-activedescendant")).toBeTruthy();
  });

  test("moves through all visible rows, including unavailable rows, without wrapping", async () => {
    const calls: RecordedExecution[] = [];
    await dom.render(defaultPalette({ executor: executorReturning({ status: "completed", messageKey: "done" }, calls) }));
    await dom.keyDown("palette-search", "End");
    expect(activeOption()?.textContent).toContain("Needs another host");
    expect(activeOption()?.getAttribute("aria-disabled")).toBe("true");
    expect(activeOption()?.textContent).toContain("This capability is not available");
    await dom.keyDown("palette-search", "ArrowDown");
    expect(activeOption()?.textContent).toContain("Needs another host");
    await dom.keyDown("palette-search", "Enter");
    expect(calls).toHaveLength(0);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 140));
    });
    expect(dom.container().querySelector("[role='status']")?.textContent).toContain(
      "This capability is not available",
    );
    await dom.keyDown("palette-search", "Home");
    expect(activeOption()?.textContent).toContain("Export current page as PDF");
  });

  test("implements the complete root roving-key matrix and scrolls the active row", async () => {
    await dom.render(defaultPalette());
    const ask = dom.find("palette-option-test.palette.quick-ask");
    let scrollCount = 0;
    ask.scrollIntoView = () => scrollCount += 1;
    await dom.keyDown("palette-search", "ArrowDown");
    expect(activeOption()).toBe(ask);
    expect(scrollCount).toBe(1);
    await dom.keyDown("palette-search", "ArrowUp");
    expect(activeOption()?.textContent).toContain("Export current page as PDF");
    await dom.keyDown("palette-search", "End");
    expect(activeOption()?.textContent).toContain("Needs another host");
    await dom.keyDown("palette-search", "Home");
    expect(activeOption()?.textContent).toContain("Export current page as PDF");
  });

  test("suppresses navigation and execution while an IME composition is active", async () => {
    const calls: RecordedExecution[] = [];
    await dom.render(defaultPalette({ executor: executorReturning({ status: "completed", messageKey: "done" }, calls) }));
    const before = dom.find("palette-search").getAttribute("aria-activedescendant");
    await dom.keyDown("palette-search", "ArrowDown", { isComposing: true });
    await dom.keyDown("palette-search", "Enter", { isComposing: true });
    expect(dom.find("palette-search").getAttribute("aria-activedescendant")).toBe(before);
    expect(calls).toHaveLength(0);
  });

  test("shows a teaching empty state, clears query on Escape, then requests close", async () => {
    let closeCount = 0;
    await dom.render(defaultPalette({ lifecycle: { onCloseRequested: () => closeCount += 1 } }));
    await dom.setValue("palette-search", "no action can match this phrase");
    expect(dom.find("palette-empty").textContent).toContain("No matching actions");
    await dom.keyDown("palette-search", "Escape");
    expect((dom.find("palette-search") as HTMLInputElement).value).toBe("");
    expect(dom.maybeFind("palette-empty")).toBeNull();
    await dom.keyDown("palette-search", "Escape");
    expect(closeCount).toBe(1);
  });

  test("uses safe action fallbacks for unknown contribution text keys", async () => {
    await dom.render(
      defaultPalette({ resolveText: (text) => text.key.startsWith("atlcli.") ? "localized" : text.fallback }),
    );
    expect(dom.find("palette-option-test.palette.unavailable").textContent).toContain(
      "Needs another host",
    );
    expect(dom.html()).not.toContain("unknown.contribution.title");
  });

  test("keeps long localized labels intact in the accessible DOM", async () => {
    const module: ActionModuleV1 = {
      schemaVersion: 1,
      id: "test.palette-module",
      actions: [longLabelActionV1()],
    };
    const catalog = createActionCatalog([module], paletteContextV1);
    await dom.render(defaultPalette({ catalog }));
    expect(dom.find("palette-option-test.palette.long-label").textContent).toContain(
      "Eine sehr lange lokalisierte Aktionsbezeichnung",
    );
  });
});

describe("focus lifecycle and nested action panel", () => {
  test("traps focus at both ends and restores the exact host element", async () => {
    const hostButton = dom.window().document.createElement("button") as unknown as HTMLButtonElement;
    hostButton.textContent = "Host editor control";
    dom.window().document.body.appendChild(hostButton as unknown as never);
    hostButton.focus();
    const props = {
      catalog: createPaletteCatalogV1(),
      executor: executorReturning({ status: "completed", messageKey: "done" }),
    };
    await dom.render(<ActionPaletteV1 open {...props} />);
    expectActiveElement(dom.find("palette-search"));
    await dom.keyDown("palette-search", "Tab", { shiftKey: true });
    const results = dom.find("palette-results-region");
    expectActiveElement(results);
    await dom.keyDown("palette-results-region", "Tab");
    expectActiveElement(dom.find("palette-search"));
    await dom.render(<ActionPaletteV1 open={false} {...props} />);
    expectActiveElement(hostButton);
  });

  test("opens the action panel, roves through disabled items, blocks them, and returns", async () => {
    const calls: RecordedExecution[] = [];
    await dom.render(defaultPalette({ executor: executorReturning({ status: "completed", messageKey: "done" }, calls) }));
    await dom.keyDown("palette-search", "Enter", { metaKey: true });
    const panel = dom.find("palette-action-panel");
    const first = dom.find("palette-panel-action-test.palette.open-activity");
    const disabled = dom.find("palette-panel-action-test.palette.needs-capability");
    expect(panel.textContent).toContain("Actions for Export current page as PDF");
    expectActiveElement(first);
    await dom.keyDown("palette-action-panel", "ArrowDown");
    expectActiveElement(disabled);
    await dom.keyDown("palette-action-panel", "ArrowUp");
    expectActiveElement(first);
    await dom.keyDown("palette-action-panel", "End");
    expectActiveElement(disabled);
    await dom.keyDown("palette-action-panel", "Home");
    expectActiveElement(first);
    await dom.keyDown("palette-action-panel", "ArrowDown");
    await dom.click("palette-panel-action-test.palette.needs-capability");
    expect(calls).toHaveLength(0);
    await dom.keyDown("palette-action-panel", "Escape");
    expect(dom.maybeFind("palette-action-panel")).toBeNull();
    expectActiveElement(dom.find("palette-search"));
  });

  test("renders into a host-supplied ShadowRoot portal", async () => {
    const host = dom.window().document.createElement("div");
    dom.window().document.body.appendChild(host);
    const shadowRoot = host.attachShadow({ mode: "open" });
    await dom.render(defaultPalette({ portalTarget: shadowRoot as unknown as ShadowRoot }));
    expect(shadowRoot.querySelector("[role='dialog']")).not.toBeNull();
    expect(dom.container().querySelector("[role='dialog']")).toBeNull();
  });

  test("shows an action-panel empty state for actions without secondary affordances", async () => {
    await dom.render(defaultPalette());
    await dom.keyDown("palette-search", "ArrowDown");
    await dom.keyDown("palette-search", "Enter", { ctrlKey: true });
    expect(dom.find("palette-action-panel").textContent).toContain(
      "This action has no additional options",
    );
  });
});

describe("input, execution, and result states", () => {
  test("validates the Quick AI form and submits multiline input only with Cmd/Ctrl+Enter", async () => {
    const calls: RecordedExecution[] = [];
    await dom.render(defaultPalette({ executor: executorReturning({ status: "completed", messageKey: "done" }, calls) }));
    await dom.keyDown("palette-search", "ArrowDown");
    await dom.keyDown("palette-search", "Enter");
    const question = dom.find("palette-input-question");
    expect(question.tagName).toBe("TEXTAREA");
    expectActiveElement(question);
    await dom.keyDown("palette-input-form", "Enter", { metaKey: true });
    expect(dom.find("palette-input-form").textContent).toContain("Please complete this field");
    expect(calls).toHaveLength(0);
    await dom.setValue("palette-input-question", "Explain this page");
    await dom.keyDown("palette-input-question", "Enter");
    expect(calls).toHaveLength(0);
    expect(dom.find("palette-input-form").textContent).toContain("Confluence · Fixture page");
    await dom.keyDown("palette-input-question", "Enter", { ctrlKey: true });
    expect(dom.find("palette-input-form").textContent).toContain("Please complete this field");
    expect(calls).toHaveLength(0);
    await dom.click("palette-input-disclosure");
    await dom.keyDown("palette-input-question", "Enter", { ctrlKey: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.request).toEqual({
      schemaVersion: 1,
      actionId: "test.palette.quick-ask",
      locale: "en-US",
      input: { question: "Explain this page", disclosure: "true" },
    });
    expect(dom.find("palette-result-completed").textContent).toContain("Action completed");
  });

  test("backs out of input and result states through Escape", async () => {
    await dom.render(defaultPalette());
    await dom.keyDown("palette-search", "ArrowDown");
    await dom.keyDown("palette-search", "Enter");
    await dom.keyDown("palette-input-form", "Escape");
    expect(dom.maybeFind("palette-input-form")).toBeNull();
    expectActiveElement(dom.find("palette-search"));
    await dom.keyDown("palette-search", "Home");
    await dom.keyDown("palette-search", "Enter");
    expect(dom.find("palette-result-completed")).not.toBeNull();
    await dom.keyDown("palette-result-completed", "Escape");
    expect(dom.maybeFind("palette-result-completed")).toBeNull();
    expectActiveElement(dom.find("palette-search"));
  });

  test("prevents double execution before a promise settles and renders a queued receipt", async () => {
    let resolveResult: ((value: ActionResultV1) => void) | undefined;
    const pending = new Promise<ActionResultV1>((resolve) => {
      resolveResult = resolve;
    });
    const calls: RecordedExecution[] = [];
    await dom.render(defaultPalette({ executor: executorReturning(() => pending, calls) }));
    const search = dom.find("palette-search");
    const scope = dom.window() as unknown as { KeyboardEvent: typeof KeyboardEvent };
    await act(async () => {
      for (let index = 0; index < 2; index += 1) {
        search.dispatchEvent(new scope.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Enter",
        }));
      }
    });
    expect(calls).toHaveLength(1);
    expect(dom.find("palette-executing").textContent).toContain("Export current page as PDF");
    await act(async () => resolveResult?.({
      status: "queued",
      receipt: {
        schemaVersion: 1,
        id: "receipt-1",
        actionId: "test.palette.export-pdf",
        status: "queued",
        host: "extension",
        createdAt: "2026-08-11T12:00:00.000Z",
        jobKind: "pdf",
      },
    }));
    await dom.flush();
    expect(dom.find("palette-result-queued").textContent).toContain("Action queued");
    expect(dom.find("palette-result-queued").textContent).toContain("PDF · queued");
  });

  test("aborts transient execution on close and never renders a late result", async () => {
    let resolveResult: ((value: ActionResultV1) => void) | undefined;
    const pending = new Promise<ActionResultV1>((resolve) => {
      resolveResult = resolve;
    });
    const calls: RecordedExecution[] = [];
    let closeCount = 0;
    await dom.render(defaultPalette({
      executor: executorReturning(() => pending, calls),
      lifecycle: { onCloseRequested: () => closeCount += 1 },
    }));
    await dom.keyDown("palette-search", "Enter");
    await dom.keyDown("palette-executing", "Escape");
    expect(closeCount).toBe(1);
    expect(calls[0]!.signal.aborted).toBe(true);
    resolveResult?.({ status: "completed", messageKey: "late" });
    await dom.flush();
    expect(dom.maybeFind("palette-result-completed")).toBeNull();
  });

  test("keeps thrown executor details private and supports retry", async () => {
    let attempts = 0;
    const executor: ActionPaletteExecutorV1 = {
      async execute() {
        attempts += 1;
        if (attempts === 1) throw new Error("secret tenant payload");
        return { status: "completed", messageKey: "done" };
      },
    };
    await dom.render(defaultPalette({ executor }));
    await dom.keyDown("palette-search", "Enter");
    expect(dom.find("palette-result-failed").textContent).toContain(
      "The action could not be completed",
    );
    expect(dom.html()).not.toContain("secret tenant payload");
    const retry = [...dom.find("palette-result-failed").querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Try again"),
    ) as HTMLElement;
    await act(async () => retry.click());
    await dom.flush();
    expect(attempts).toBe(2);
    expect(dom.find("palette-result-completed")).not.toBeNull();
  });

  test("renders result text as text only and respects disabled result affordances", async () => {
    const calls: RecordedExecution[] = [];
    const result: ActionResultV1 = {
      status: "completed",
      messageKey: "result.with-markup",
      actions: [
        {
          schemaVersion: 1,
          id: "test.result.disabled",
          title: { key: "test.result.disabled", fallback: "Disabled continuation" },
          intent: { kind: "surface.open", target: { kind: "sidebar", screen: "activity" } },
          requirements: [{ kind: "capability", capability: "test.capability.missing" }],
          effect: "read",
        },
      ],
    };
    await dom.render(defaultPalette({
      executor: executorReturning(result, calls),
      resolveResultText: () => "<script>unsafe()</script>",
    }));
    await dom.keyDown("palette-search", "Enter");
    const view = dom.find("palette-result-completed");
    expect(view.textContent).toContain("<script>unsafe()</script>");
    expect(view.querySelector("script")).toBeNull();
    const continuation = [...view.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Disabled continuation"),
    ) as HTMLElement;
    expect(continuation.getAttribute("aria-disabled")).toBe("true");
    await act(async () => continuation.click());
    await dom.flush();
    expect(calls).toHaveLength(1);
  });
});

describe("failure containment and accessibility", () => {
  test("contains render failures in a recoverable dialog", async () => {
    const originalError = console.error;
    console.error = () => undefined;
    try {
      await dom.render(defaultPalette({
        resolveIcon: () => {
          throw new Error("fixture renderer failed");
        },
      }));
    } finally {
      console.error = originalError;
    }
    const fallback = dom.find("palette-error-boundary");
    expect(fallback.textContent).toContain("The action palette stopped responding");
    expect(dom.html()).not.toContain("fixture renderer failed");
  });

  test("has zero serious or critical axe violations in root and input states", async () => {
    await dom.render(defaultPalette());
    const axe = (await import("axe-core")).default;
    const rootResult = await axe.run(
      dom.find("action-palette").querySelector("[role='dialog']") as HTMLElement,
      {
      rules: { "color-contrast": { enabled: false } },
      },
    );
    expect(
      rootResult.violations.filter((violation) =>
        violation.impact === "serious" || violation.impact === "critical",
      ),
    ).toEqual([]);

    await dom.keyDown("palette-search", "ArrowDown");
    await dom.keyDown("palette-search", "Enter");
    const inputResult = await axe.run(
      dom.find("action-palette").querySelector("[role='dialog']") as HTMLElement,
      {
      rules: { "color-contrast": { enabled: false } },
      },
    );
    expect(
      inputResult.violations.filter((violation) =>
        violation.impact === "serious" || violation.impact === "critical",
      ),
    ).toEqual([]);
  });

  test("selects the German host dictionary and honors an explicit English override", async () => {
    await dom.render(defaultPalette({ catalog: createPaletteCatalogV1({ locale: "de-DE" }) }));
    expect(dom.find("palette-search").getAttribute("placeholder")).toBe(
      "Aktionen durchsuchen…",
    );
    expect(dom.find("palette-close").getAttribute("aria-label")).toBe("Schließen");

    await dom.render(defaultPalette({
      catalog: createPaletteCatalogV1({ locale: "de-DE" }),
      messages: ACTION_PALETTE_MESSAGES_EN_V1,
    }));
    expect(dom.find("palette-search").getAttribute("placeholder")).toBe("Search actions…");
  });
});
