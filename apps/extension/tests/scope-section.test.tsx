/**
 * The shared scope form (spec 010 T5.1, Architecture point 7).
 *
 * Four properties are load-bearing enough to be pinned rather than reviewed:
 *
 *  - **Advanced is closed by default.** The 90 % case is a single page with no
 *    filters, and that case must not get one interaction harder because tree
 *    exports exist. Progressive disclosure is the mechanism; a regression here
 *    is invisible in a screenshot and obvious in daily use.
 *  - **"Entire space" is gated on a space key**, not merely warned about — a
 *    space scope with no space key throws in `validateExportScope`.
 *  - **A space export asks first**, with the page count when the host can
 *    supply one and count-free wording when it cannot.
 *  - **The macro toggle defaults ON**, because an export that silently drops
 *    Jira status is a worse surprise than one that takes a moment longer.
 *
 * There is exactly one scope form for both engines: the assertion that DOCX and
 * PDF receive the *same* `ExportScope` object is the mechanical statement of
 * Architecture point 7.
 *
 * Rendered under happy-dom with `globalThis.chrome` deleted — no HTTP is mocked
 * anywhere; the ports are fakes.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import React from "react";
import type { ExportReport } from "@atlcli/docx/browser";
import type { ScanResult } from "@atlcli/docx/scan";
import type { PdfExportReport } from "@atlcli/pdf/browser";
import { ExportApp } from "../components/app/ExportApp.js";
import { defaultScreens } from "../components/screens/index.js";
import type {
  AppPorts,
  DocxExportRequest,
  PdfExportRequest,
  PageContext,
} from "../utils/ports/index.js";
import type { LoadedPage } from "../utils/read-path.js";
import { memorySettingsStore } from "../utils/ports/settings.js";
import { createReactHarness } from "./react-harness.js";

const dom = createReactHarness();

beforeEach(() => dom.setup());
afterEach(() => dom.teardown());
afterAll(() => {
  expect(dom.leakedGlobals()).toEqual([]);
});

// ---------------------------------------------------------------------------
// Fakes — ports only. Nothing here mocks HTTP.
// ---------------------------------------------------------------------------

const PAGE_URL = "https://example.atlassian.net/wiki/spaces/DOCSY/pages/42/Handbook";

function loadedPage(spaceKey: string | undefined): LoadedPage {
  return {
    details: {
      id: "42",
      title: "Handbook",
      spaceKey,
      version: 7,
      storage: "<p>Ship it.</p>",
    },
    markdown: "Ship it.",
    wordCount: 2,
    attachments: [],
  } as unknown as LoadedPage;
}

const SCAN: ScanResult = {
  supported: [],
  unsupported: [],
  never: [],
  parts: ["word/document.xml"],
  hasContentPlaceholder: true,
  stylerefStyleNames: [],
};

function pdfReport(): PdfExportReport {
  return {
    filename: "Handbook.pdf",
    profile: "tagged",
    compilerVersion: "test",
    embeddedImages: 0,
    renderedDiagrams: 0,
    skippedAssets: 0,
    notes: [],
    complete: true,
    timings: { prepareMs: 1, compileMs: 2, emitMs: 3, totalMs: 6 },
  } as unknown as PdfExportReport;
}

function docxReport(): ExportReport {
  return {
    resolvedCount: 0,
    unsupportedNames: [],
    skippedImages: 0,
    embeddedImages: 0,
    renderedDiagrams: 0,
    durationMs: 1,
    filename: "Handbook.docx",
    notes: [],
    complete: true,
    scan: SCAN,
    timings: {
      resolveMs: 0,
      bodyMs: 0,
      logoFetchMs: 0,
      includeFetchMs: 0,
      renderMs: 0,
      imageFetchMs: 0,
      imageFetches: 0,
      diagramRenderMs: 0,
      diagramRasterMs: 0,
    },
  } as unknown as ExportReport;
}

interface Recorder {
  pdf: PdfExportRequest[];
  docx: DocxExportRequest[];
  counts: { spaceKey?: string }[];
}

function makePorts(
  recorder: Recorder,
  options: { spaceKey?: string; pageCount?: number | null } = {}
): AppPorts {
  const spaceKey = "spaceKey" in options ? options.spaceKey : "DOCSY";
  const templateBytes = new ArrayBuffer(8);

  const ports: AppPorts = {
    host: {
      kind: "test",
      name: "atlcli",
      version: "9.9.9",
      capabilities: ["pdf-export", "docx-export", "docx-template-store"],
    },
    watchPageContext(onChange: (context: PageContext) => void) {
      onChange({
        url: PAGE_URL,
        entity: { product: "confluence", type: "page", pageId: "42", spaceKey: spaceKey ?? "" },
        seq: 1,
      } as unknown as PageContext);
      return () => {};
    },
    async loadPage() {
      return loadedPage(spaceKey);
    },
    pdf: {
      async run(request) {
        recorder.pdf.push(request);
        return pdfReport();
      },
    },
    docx: {
      async scan() {
        return SCAN;
      },
      async run(request) {
        recorder.docx.push(request);
        return docxReport();
      },
    },
    docxTemplates: {
      async get() {
        return { name: "mayflower.docx", uploadedAt: 0, bytes: templateBytes };
      },
      async put() {
        return { name: "mayflower.docx", uploadedAt: 0, bytes: templateBytes };
      },
      async remove() {},
    },
    settings: memorySettingsStore(),
  };

  if (options.pageCount !== undefined && options.pageCount !== null) {
    ports.countScopePages = async (request) => {
      recorder.counts.push({
        spaceKey: request.scope.kind === "space" ? request.scope.spaceKey : undefined,
      });
      return options.pageCount as number;
    };
  }
  return ports;
}

function newRecorder(): Recorder {
  return { pdf: [], docx: [], counts: [] };
}

async function renderApp(ports: AppPorts): Promise<void> {
  await dom.render(
    <ExportApp
      ports={ports}
      screens={defaultScreens.filter((screen) => screen.id === "export")}
      localeCandidates={["en"]}
    />
  );
}

// ---------------------------------------------------------------------------

describe("ScopeSection — defaults keep the single-page case unchanged", () => {
  it("starts on 'Current page' with the Advanced disclosure closed", async () => {
    await renderApp(makePorts(newRecorder()));

    const page = dom.find("scope-kind-page") as unknown as HTMLInputElement;
    expect(page.checked).toBe(true);

    const advanced = dom.find("scope-advanced") as unknown as HTMLDetailsElement;
    expect(advanced.open).toBe(false);

    // Depth and include-root belong to the tree scope and are not even mounted.
    expect(dom.maybeFind("scope-tree-options")).toBeNull();

    // The fifteen Level-A settings are folded away too, for the same reason:
    // a user who never changes one must not scroll past them to reach Word.
    const settings = dom.find("pdf-settings-form") as unknown as HTMLDetailsElement;
    expect(settings.tagName.toLowerCase()).toBe("details");
    expect(settings.open).toBe(false);
  });

  it("sends no scope filters at all for the default single-page export", async () => {
    const recorder = newRecorder();
    await renderApp(makePorts(recorder));

    await dom.click("pdf-export");

    expect(recorder.pdf).toHaveLength(1);
    const request = recorder.pdf[0]!;
    expect(request.scope).toEqual({ kind: "page", pageId: "42" });
    expect(request.labels).toBeUndefined();
    // No confirmation stood between the click and the export.
    expect(dom.maybeFind("scope-space-confirm")).toBeNull();
  });

  it("defaults the dynamic-macro toggle to ON", async () => {
    const recorder = newRecorder();
    await renderApp(makePorts(recorder));

    await dom.setOpen("scope-advanced", true);
    const toggle = dom.find("scope-resolve-macros") as unknown as HTMLInputElement;
    expect(toggle.checked).toBe(true);

    await dom.click("pdf-export");
    expect(recorder.pdf[0]!.resolveMacros).toBe(true);
  });

  it("turns macro resolution off, which is what makes an export deterministic", async () => {
    const recorder = newRecorder();
    await renderApp(makePorts(recorder));

    await dom.setOpen("scope-advanced", true);
    expect(await dom.toggle("scope-resolve-macros")).toBe(false);

    await dom.click("pdf-export");
    expect(recorder.pdf[0]!.resolveMacros).toBe(false);
  });
});

describe("ScopeSection — the space option is gated on a space key", () => {
  it("enables 'Entire space' when the loaded page reports one", async () => {
    await renderApp(makePorts(newRecorder(), { spaceKey: "DOCSY" }));
    const space = dom.find("scope-kind-space") as unknown as HTMLInputElement;
    expect(space.disabled).toBe(false);
  });

  it("disables it — with a reason — when the page reports no space", async () => {
    await renderApp(makePorts(newRecorder(), { spaceKey: undefined }));
    const space = dom.find("scope-kind-space") as unknown as HTMLInputElement;
    expect(space.disabled).toBe(true);
    expect(dom.html()).toContain("This page reports no space");
  });
});

describe("ScopeSection — tree scope", () => {
  it("reveals depth and include-root, and carries them into the request", async () => {
    const recorder = newRecorder();
    await renderApp(makePorts(recorder));

    await dom.toggle("scope-kind-tree");
    expect(dom.maybeFind("scope-tree-options")).not.toBeNull();

    await dom.setValue("scope-depth", "2");
    expect(await dom.toggle("scope-include-root")).toBe(false);

    await dom.click("pdf-export");
    expect(recorder.pdf[0]!.scope).toEqual({
      kind: "tree",
      rootPageId: "42",
      includeRoot: false,
      maxDepth: 2,
    });
  });

  it("turns label input into a normalized OR filter with the prune-subtree default", async () => {
    const recorder = newRecorder();
    await renderApp(makePorts(recorder));

    await dom.setOpen("scope-advanced", true);
    await dom.setValue("scope-labels-include", "handbook, public");
    await dom.setValue("scope-labels-exclude", "internal");

    await dom.click("pdf-export");
    expect(recorder.pdf[0]!.labels).toEqual({
      include: ["handbook", "public"],
      exclude: ["internal"],
      excludeMode: "prune-subtree",
    });
  });
});

describe("ScopeSection — one scope, both engines (Architecture point 7)", () => {
  it("hands the identical scope to the PDF and the Word panel", async () => {
    const recorder = newRecorder();
    await renderApp(makePorts(recorder));

    await dom.toggle("scope-kind-tree");
    await dom.setOpen("scope-advanced", true);
    await dom.setValue("scope-labels-include", "handbook");

    await dom.click("pdf-export");
    await dom.click("template-export");

    expect(recorder.pdf).toHaveLength(1);
    expect(recorder.docx).toHaveLength(1);
    expect(recorder.docx[0]!.scope).toEqual(recorder.pdf[0]!.scope);
    expect(recorder.docx[0]!.labels).toEqual(recorder.pdf[0]!.labels);
    // There is one form, not one per engine.
    expect(dom.container().querySelectorAll('[data-testid="scope-section"]')).toHaveLength(1);
  });
});

describe("ScopeSection — the space-export confirmation", () => {
  it("asks before a space export and names the page count", async () => {
    const recorder = newRecorder();
    await renderApp(makePorts(recorder, { pageCount: 212 }));

    await dom.toggle("scope-kind-space");
    await dom.click("pdf-export");

    // Nothing started yet: the confirmation stands between click and export.
    expect(recorder.pdf).toHaveLength(0);
    expect(dom.find("scope-space-confirm-count").textContent).toBe("212 pages, continue?");
    expect(dom.find("scope-space-confirm").textContent).toContain(
      "Export the whole space DOCSY?"
    );

    await dom.click("scope-space-confirm-yes");
    expect(recorder.pdf).toHaveLength(1);
    expect(recorder.pdf[0]!.scope).toEqual({ kind: "space", spaceKey: "DOCSY" });
    expect(dom.maybeFind("scope-space-confirm")).toBeNull();
  });

  it("cancelling the confirmation starts nothing", async () => {
    const recorder = newRecorder();
    await renderApp(makePorts(recorder, { pageCount: 3 }));

    await dom.toggle("scope-kind-space");
    await dom.click("pdf-export");
    await dom.click("scope-space-confirm-no");

    expect(recorder.pdf).toHaveLength(0);
    expect(dom.maybeFind("scope-space-confirm")).toBeNull();
  });

  it("still asks — with count-free wording — when the host cannot count", async () => {
    const recorder = newRecorder();
    // No `countScopePages` on these ports at all.
    await renderApp(makePorts(recorder));

    await dom.toggle("scope-kind-space");
    await dom.click("pdf-export");

    expect(recorder.pdf).toHaveLength(0);
    expect(dom.find("scope-space-confirm-count").textContent).toBe(
      "Every page in DOCSY will be exported. This can take a while."
    );
    await dom.click("scope-space-confirm-yes");
    expect(recorder.pdf).toHaveLength(1);
  });

  it("gates the Word export the same way — the confirmation is not PDF-specific", async () => {
    const recorder = newRecorder();
    await renderApp(makePorts(recorder, { pageCount: 7 }));

    await dom.toggle("scope-kind-space");
    await dom.click("template-export");
    expect(recorder.docx).toHaveLength(0);

    await dom.click("scope-space-confirm-yes");
    expect(recorder.docx).toHaveLength(1);
    expect(recorder.docx[0]!.scope).toEqual({ kind: "space", spaceKey: "DOCSY" });
  });

  it("retracts the question when the scope changes underneath it", async () => {
    const recorder = newRecorder();
    await renderApp(makePorts(recorder, { pageCount: 42 }));

    await dom.toggle("scope-kind-space");
    await dom.click("pdf-export");
    expect(dom.maybeFind("scope-space-confirm")).not.toBeNull();

    // The pending closure captured the space scope; answering it after a
    // switch would export something the dialog no longer describes.
    await dom.toggle("scope-kind-page");
    expect(dom.maybeFind("scope-space-confirm")).toBeNull();
    expect(recorder.pdf).toHaveLength(0);
  });

  it("does not ask for a page or a tree export", async () => {
    const recorder = newRecorder();
    await renderApp(makePorts(recorder, { pageCount: 999 }));

    await dom.toggle("scope-kind-tree");
    await dom.click("pdf-export");

    expect(dom.maybeFind("scope-space-confirm")).toBeNull();
    expect(recorder.pdf).toHaveLength(1);
  });
});

describe("ScopeSection — the multi-page progress line", () => {
  it('renders "Page n/total: title" while the walk reports progress', async () => {
    const recorder = newRecorder();
    const ports = makePorts(recorder);
    // A holder rather than a `let`: control-flow analysis narrows a `let`
    // assigned only inside the executor to `never` at the call site below.
    const gate: { release?: () => void } = {};
    ports.pdf = {
      async run(request) {
        request.onProgress?.({ fetched: 37, total: 210, currentTitle: "Runbook" });
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
        return pdfReport();
      },
    };

    await renderApp(ports);
    await dom.click("pdf-export");

    expect(dom.find("pdf-progress").textContent).toBe("Page 37/210: Runbook");
    // Cancel stays reachable mid-walk.
    expect(dom.maybeFind("pdf-cancel")).not.toBeNull();

    await dom.click("pdf-cancel");
    expect(dom.maybeFind("pdf-progress")).toBeNull();
    gate.release?.();
    await dom.flush();
  });
});
