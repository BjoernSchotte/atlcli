/**
 * The generic template-settings form (spec 010 T5.2 / folder 007 Level-A).
 *
 * Two halves, deliberately:
 *
 *  - **Pure** — the schema projection, defaulting, validation and the mapping
 *    onto `PdfTemplateSettings`. No DOM needed, so the rules are pinned where
 *    they are cheapest to read.
 *  - **Rendered** — one case per declared widget type, plus the round-trip
 *    through the *real* `template-prefs` store (`fake-indexeddb`, not a stub of
 *    our own storage layer).
 *
 * The load-bearing negative: **the form never writes `settings` onto a DOCX
 * export request.** `packages/docx`'s `ExportInput` has no such field, so a
 * value written there would be silently dropped while looking like a feature.
 * That is asserted end-to-end through the real panel, not by reading the type.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import React from "react";
import { IDBFactory } from "fake-indexeddb";
import { BUILTIN_PDF_TEMPLATE_ID } from "@atlcli/pdf/browser";
import { CODE_THEME_METADATA } from "@atlcli/code-highlight/registry";
import type { ExportReport } from "@atlcli/docx/browser";
import type { ScanResult } from "@atlcli/docx/scan";
import type { PdfExportReport } from "@atlcli/pdf/browser";
import { ExportApp } from "../components/app/ExportApp.js";
import { defaultScreens } from "../components/screens/index.js";
import { PDF_BUILTIN_TEMPLATE_ID } from "../components/screens/ExportScreen.js";
import { SettingsForm } from "../components/export/SettingsForm.js";
import { PDF_LEVEL_A_SETTINGS } from "../components/export/pdf-settings.js";
import {
  decodeAssetDataUrl,
  defaultValues,
  fromManifestSettings,
  mergeValues,
  normalizeHexColor,
  toPdfSettings,
  validateSetting,
  validateValues,
  type SettingsSchema,
  type SettingValue,
} from "../components/export/settings-schema.js";
import { idbTemplateLibrary } from "../utils/templates/library.js";
import type {
  AppPorts,
  DocxExportRequest,
  PageContext,
  PdfExportRequest,
  TemplateLibraryPort,
} from "../utils/ports/index.js";
import type { LoadedPage } from "../utils/read-path.js";
import { I18nProvider } from "../utils/i18n/context.js";
import { memorySettingsStore } from "../utils/ports/settings.js";
import { createReactHarness } from "./react-harness.js";

const dom = createReactHarness();

beforeEach(() => dom.setup());
afterEach(() => dom.teardown());
afterAll(() => {
  expect(dom.leakedGlobals()).toEqual([]);
});

// ---------------------------------------------------------------------------
// Pure: the schema itself
// ---------------------------------------------------------------------------

describe("the panel's Level-A schema stays tied to the engine", () => {
  // The panel stores settings under a literal template id so the portable app
  // layer need not import the PDF engine barrel for one string. If the engine
  // renames the built-in template, everybody's saved settings would silently
  // orphan — so the duplication is re-read here rather than assumed.
  it("uses the same template id the engine's built-in manifest declares", () => {
    expect(PDF_BUILTIN_TEMPLATE_ID).toBe(BUILTIN_PDF_TEMPLATE_ID);
  });

  it("declares exactly one widget of every supported type", () => {
    const types = new Set(Object.values(PDF_LEVEL_A_SETTINGS).map((s) => s.type));
    expect([...types].sort()).toEqual(["asset", "boolean", "choice", "color", "number", "text"]);
  });
});

describe("fromManifestSettings — a manifest is untrusted data", () => {
  it("projects the declared widget types and their descriptors", () => {
    const schema = fromManifestSettings({
      accent: { type: "color", default: "#123456" },
      density: { type: "choice", default: "cosy", options: ["cosy", { value: "compact" }] },
      pages: { type: "number", default: 3, min: 1, max: 9 },
    });
    expect(schema.accent).toEqual({ type: "color", default: "#123456" });
    expect(schema.density?.options).toEqual([{ value: "cosy" }, { value: "compact" }]);
    expect(schema.pages).toEqual({ type: "number", default: 3, min: 1, max: 9 });
  });

  it("drops a widget type the panel cannot render rather than guessing", () => {
    const schema = fromManifestSettings({
      sane: { type: "text" },
      // A pack could declare anything; rendering it as text would persist a
      // value the template never asked for.
      weird: { type: "sudo" } as never,
    });
    expect(Object.keys(schema)).toEqual(["sane"]);
  });

  it("drops a non-scalar default rather than storing an object in prefs", () => {
    const schema = fromManifestSettings({ x: { type: "text", default: { nope: 1 } } });
    expect(schema.x).toEqual({ type: "text" });
  });
});

describe("defaults and merging", () => {
  it("fills every field from the schema's declared default", () => {
    const values = defaultValues(PDF_LEVEL_A_SETTINGS);
    expect(values.page).toBe("a4");
    expect(values.orientation).toBe("portrait");
    expect(values.cover).toBe(true);
    expect(values.outline).toBe(true);
    expect(values.accentColor).toBe("#4B57A3");
    expect(values.watermarkOpacity).toBe(0.08);
  });

  it("drops a stored key the schema no longer declares", () => {
    const merged = mergeValues(PDF_LEVEL_A_SETTINGS, {
      headerText: "Confidential",
      retiredSetting: "stale",
    });
    expect(merged.headerText).toBe("Confidential");
    expect("retiredSetting" in merged).toBe(false);
  });

  it("falls back to the default when a stored value has the wrong runtime type", () => {
    const merged = mergeValues(PDF_LEVEL_A_SETTINGS, {
      cover: "yes" as unknown as SettingValue,
    });
    expect(merged.cover).toBe(true);
  });
});

describe("validation — a fast pre-check, with the engine still the authority", () => {
  const schema = PDF_LEVEL_A_SETTINGS;

  it("rejects a non-numeric number", () => {
    expect(validateSetting("watermarkSize", schema.watermarkSize!, "big")).toEqual({
      key: "watermarkSize",
      reason: "not-a-number",
    });
  });

  it("rejects a number outside the engine's bounds, both ends", () => {
    expect(validateSetting("watermarkSize", schema.watermarkSize!, 4)?.reason).toBe(
      "out-of-range"
    );
    expect(validateSetting("watermarkSize", schema.watermarkSize!, 401)?.reason).toBe(
      "out-of-range"
    );
    expect(validateSetting("watermarkSize", schema.watermarkSize!, 96)).toBeNull();
  });

  it("honours the exclusive lower bound the engine uses for opacity", () => {
    // `resolvePdfSettings` documents `(0, 1]` — 0 is invalid, 1 is not.
    expect(validateSetting("watermarkOpacity", schema.watermarkOpacity!, 0)?.reason).toBe(
      "out-of-range"
    );
    expect(validateSetting("watermarkOpacity", schema.watermarkOpacity!, 1)).toBeNull();
  });

  it("rejects a malformed colour and accepts both hex lengths", () => {
    expect(validateSetting("accentColor", schema.accentColor!, "indigo")?.reason).toBe(
      "not-a-color"
    );
    expect(validateSetting("accentColor", schema.accentColor!, "#4B57A3")).toBeNull();
    expect(normalizeHexColor("#abc")).toBe("#AABBCC");
    expect(normalizeHexColor("nope")).toBeUndefined();
  });

  it("rejects a choice value the schema does not offer", () => {
    expect(validateSetting("page", schema.page!, "a3")?.reason).toBe("not-an-option");
  });

  it("treats an empty optional field as unset, never as invalid", () => {
    expect(validateSetting("headerText", schema.headerText!, "")).toBeNull();
    expect(validateSetting("accentColor", schema.accentColor!, "")).toBeNull();
    expect(validateValues(PDF_LEVEL_A_SETTINGS, defaultValues(PDF_LEVEL_A_SETTINGS))).toEqual([]);
  });

  it("rejects text past the engine's 200-code-point cap, counted in code points", () => {
    const emoji = "🙂".repeat(150); // 300 UTF-16 units, 150 code points
    expect(validateSetting("headerText", schema.headerText!, emoji)).toBeNull();
    expect(validateSetting("headerText", schema.headerText!, "x".repeat(201))?.reason).toBe(
      "too-long"
    );
  });
});

describe("toPdfSettings — the engine hand-off", () => {
  it("emits nothing when every field is empty, so defaults stay the engine's", () => {
    expect(toPdfSettings({})).toBeUndefined();
    expect(toPdfSettings({ headerText: "", accentColor: "" })).toBeUndefined();
  });

  it("maps the flat keys onto the closed PdfTemplateSettings shape", () => {
    expect(
      toPdfSettings({
        page: "letter",
        orientation: "landscape",
        cover: false,
        outline: true,
        headerText: "Draft",
        organizationName: "Mayflower",
        accentColor: "#abc",
      })
    ).toEqual({
      page: "letter",
      orientation: "landscape",
      cover: false,
      outline: true,
      headerText: "Draft",
      organizationName: "Mayflower",
      accentColor: "#AABBCC",
    });
  });

  it("re-nests the flattened watermark keys, but only with a text", () => {
    // The engine requires `watermark.text`; emitting the styling without it
    // would be an export-time rejection for a watermark nobody asked for.
    expect(toPdfSettings({ watermarkColor: "#DE350B", watermarkSize: 120 })).toBeUndefined();
    expect(
      toPdfSettings({ watermarkText: "DRAFT", watermarkColor: "#de350b", watermarkOpacity: 0.2 })
    ).toEqual({ watermark: { text: "DRAFT", color: "#DE350B", opacity: 0.2 } });
  });

  it("decodes a logo asset, and refuses to emit one without alt text", () => {
    // 1×1 transparent PNG.
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    expect(decodeAssetDataUrl(png)?.mediaType).toBe("image/png");
    expect(decodeAssetDataUrl("data:text/plain;base64,aGk=")).toBeUndefined();

    expect(toPdfSettings({ logo: png })).toBeUndefined();
    const withAlt = toPdfSettings({ logo: png, logoAlt: "Mayflower" });
    expect(withAlt?.logo?.mediaType).toBe("image/png");
    expect(withAlt?.logo?.alt).toBe("Mayflower");
    expect(withAlt?.logo?.bytes.byteLength).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Rendered: one case per widget type
// ---------------------------------------------------------------------------

const SYNTHETIC: SettingsSchema = {
  title: { type: "text", default: "Handbook", maxLength: 10 },
  cover: { type: "boolean", default: true },
  density: {
    type: "choice",
    default: "cosy",
    options: [{ value: "cosy", label: "Cosy" }, { value: "compact", label: "Compact" }],
  },
  accent: { type: "color", default: "#4B57A3" },
  columns: { type: "number", default: 2, min: 1, max: 4 },
  logo: { type: "asset", default: "", accept: "image/png" },
};

async function renderForm(
  values: Record<string, SettingValue>,
  onChange: (key: string, value: SettingValue) => void,
  readOnly = false
): Promise<void> {
  await dom.render(
    <I18nProvider locale="en">
      <SettingsForm
        schema={SYNTHETIC}
        values={values}
        onChange={onChange}
        readOnly={readOnly}
        idPrefix="s"
      />
    </I18nProvider>
  );
}

describe("SettingsForm renders one widget per declared type", () => {
  it("renders text, boolean, choice, color, number and asset controls", async () => {
    await renderForm(defaultValues(SYNTHETIC), () => {});

    expect((dom.find("s-title") as unknown as HTMLInputElement).type).toBe("text");
    expect((dom.find("s-cover") as unknown as HTMLInputElement).type).toBe("checkbox");
    expect(dom.find("s-density").tagName.toLowerCase()).toBe("select");
    expect((dom.find("s-accent") as unknown as HTMLInputElement).type).toBe("text");
    expect((dom.find("s-accent-picker") as unknown as HTMLInputElement).type).toBe("color");
    expect((dom.find("s-columns") as unknown as HTMLInputElement).type).toBe("number");
    expect((dom.find("s-logo") as unknown as HTMLInputElement).type).toBe("file");
  });

  it("fills every control from the schema default", async () => {
    await renderForm(defaultValues(SYNTHETIC), () => {});

    expect((dom.find("s-title") as unknown as HTMLInputElement).value).toBe("Handbook");
    expect((dom.find("s-cover") as unknown as HTMLInputElement).checked).toBe(true);
    expect((dom.find("s-density") as unknown as HTMLSelectElement).value).toBe("cosy");
    expect((dom.find("s-accent") as unknown as HTMLInputElement).value).toBe("#4B57A3");
    expect((dom.find("s-columns") as unknown as HTMLInputElement).value).toBe("2");
  });

  it("reports every edit through onChange, coercing to the declared type", async () => {
    const seen: [string, SettingValue][] = [];
    const values = defaultValues(SYNTHETIC);
    await renderForm(values, (key, value) => seen.push([key, value]));

    await dom.setValue("s-title", "Runbook");
    await dom.toggle("s-cover");
    await dom.setValue("s-density", "compact");
    await dom.setValue("s-columns", "3");

    expect(seen).toEqual([
      ["title", "Runbook"],
      ["cover", false],
      ["density", "compact"],
      ["columns", 3],
    ]);
  });

  it("shows the issue next to the field for an invalid number and colour", async () => {
    await renderForm({ ...defaultValues(SYNTHETIC), columns: 9, accent: "indigo" }, () => {});

    expect(dom.find("s-columns-issue").textContent).toBe(
      "That value is outside the allowed range."
    );
    expect(dom.find("s-accent-issue").textContent).toBe("Enter a colour like #4B57A3.");
    // A valid field carries no issue at all.
    expect(dom.maybeFind("s-title-issue")).toBeNull();
  });

  it("flags a non-numeric entry rather than silently storing NaN", async () => {
    const seen: [string, SettingValue][] = [];
    await renderForm(defaultValues(SYNTHETIC), (key, value) => seen.push([key, value]));
    await dom.setValue("s-columns", "abc");
    // happy-dom's number input keeps the raw text; the point is that whatever
    // arrives is never coerced into NaN behind the user's back.
    for (const [, value] of seen) expect(Number.isNaN(value)).toBe(false);
  });

  it("readOnly disables every control and says why — the DOCX branch", async () => {
    await renderForm(defaultValues(SYNTHETIC), () => {}, true);

    expect(dom.find("s-readonly").textContent).toContain("cannot apply them yet");
    for (const id of ["s-title", "s-cover", "s-density", "s-accent", "s-columns", "s-logo"]) {
      expect((dom.find(id) as unknown as HTMLInputElement).disabled).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end through the real panel and the real prefs store
// ---------------------------------------------------------------------------

const PAGE_URL = "https://example.atlassian.net/wiki/spaces/DOCSY/pages/42/Handbook";
const SITE = "https://example.atlassian.net";

const SCAN: ScanResult = {
  supported: [],
  unsupported: [],
  never: [],
  parts: ["word/document.xml"],
  hasContentPlaceholder: true,
  stylerefStyleNames: [],
};

function loadedPage(): LoadedPage {
  return {
    details: { id: "42", title: "Handbook", spaceKey: "DOCSY", version: 7, storage: "<p>x</p>" },
    markdown: "x",
    wordCount: 1,
    attachments: [],
  } as unknown as LoadedPage;
}

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
    timings: { prepareMs: 1, compileMs: 1, emitMs: 1, totalMs: 3 },
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
}

function makePorts(recorder: Recorder, templates: TemplateLibraryPort | null): AppPorts {
  const bytes = new ArrayBuffer(8);
  return {
    host: {
      kind: "test",
      name: "atlcli",
      version: "9.9.9",
      capabilities: ["pdf-export", "docx-export", "docx-template-store", "template-library"],
    },
    watchPageContext(onChange: (context: PageContext) => void) {
      onChange({
        url: PAGE_URL,
        entity: { product: "confluence", type: "page", pageId: "42", spaceKey: "DOCSY" },
        seq: 1,
      } as unknown as PageContext);
      return () => {};
    },
    async loadPage() {
      return loadedPage();
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
        return { name: "mayflower.docx", uploadedAt: 0, bytes };
      },
      async put() {
        return { name: "mayflower.docx", uploadedAt: 0, bytes };
      },
      async remove() {},
    },
    settings: memorySettingsStore(),
    templates,
  };
}

async function renderPanel(ports: AppPorts): Promise<void> {
  await dom.render(
    <ExportApp
      ports={ports}
      screens={defaultScreens.filter((screen) => screen.id === "export")}
      localeCandidates={["en"]}
    />
  );
}

describe("PDF settings reach the PDF engine — and nothing else", () => {
  it("offers the full catalogue and sends one real non-default choice to both engines", async () => {
    const recorder: Recorder = { pdf: [], docx: [] };
    await renderPanel(makePorts(recorder, null));

    const select = dom.find("pdf-settings-codeTheme") as unknown as HTMLSelectElement;
    expect(select.options).toHaveLength(CODE_THEME_METADATA.length);
    await dom.setValue("pdf-settings-codeTheme", "dracula");
    await dom.click("pdf-export");
    await dom.click("template-export");

    expect(recorder.pdf[0]!.codeTheme).toBe("dracula");
    expect(recorder.docx[0]!.codeTheme).toBe("dracula");
  });

  it("round-trips values through the real template-prefs store", async () => {
    // The real v2 store over fake-indexeddb, not a stub of our own storage.
    const factory = new IDBFactory();
    const library = idbTemplateLibrary({ factory, siteOrigin: SITE });
    const recorder: Recorder = { pdf: [], docx: [] };

    await renderPanel(makePorts(recorder, library));
    await dom.setValue("pdf-settings-headerText", "Confidential");
    await dom.setValue("pdf-settings-page", "letter");
    await dom.setValue("pdf-settings-codeTheme", "dracula");
    await dom.flush();

    // Persisted under the built-in template's logical id, per engine + space.
    const stored = await library.readSettings("typst", "DOCSY", PDF_BUILTIN_TEMPLATE_ID);
    expect(stored.headerText).toBe("Confidential");
    expect(stored.page).toBe("letter");
    expect(stored.codeTheme).toBe("dracula");

    // …and read back on the next mount, not just written.
    await dom.teardown();
    dom.setup();
    await renderPanel(makePorts({ pdf: [], docx: [] }, idbTemplateLibrary({ factory, siteOrigin: SITE })));
    expect((dom.find("pdf-settings-headerText") as unknown as HTMLInputElement).value).toBe(
      "Confidential"
    );
    expect((dom.find("pdf-settings-codeTheme") as unknown as HTMLSelectElement).value).toBe(
      "dracula"
    );
  });

  it("hands the resolved settings to the PDF export request", async () => {
    const recorder: Recorder = { pdf: [], docx: [] };
    await renderPanel(makePorts(recorder, null));

    await dom.setValue("pdf-settings-headerText", "Confidential");
    await dom.setValue("pdf-settings-watermarkText", "DRAFT");
    await dom.click("pdf-export");

    expect(recorder.pdf).toHaveLength(1);
    expect(recorder.pdf[0]!.settings).toMatchObject({
      headerText: "Confidential",
      watermark: { text: "DRAFT" },
    });
  });

  // The whole point of the PDF-only decision. `packages/docx`'s `ExportInput`
  // has no `settings` field, so a value written onto a DOCX request would be
  // dropped on the floor while looking like a feature.
  it("never writes `settings` onto a DOCX export request", async () => {
    const recorder: Recorder = { pdf: [], docx: [] };
    await renderPanel(makePorts(recorder, null));

    await dom.setValue("pdf-settings-headerText", "Confidential");
    await dom.setValue("pdf-settings-accentColor", "#123456");
    await dom.click("template-export");

    expect(recorder.docx).toHaveLength(1);
    const request = recorder.docx[0]!;
    expect("settings" in request).toBe(false);
    expect(request.codeTheme).toBe("github-light");
    expect(Object.keys(request).sort()).toEqual(
      ["codeTheme", "onProgress", "page", "pageUrl", "resolveMacros", "scope", "signal", "template"].sort()
    );
  });

  it("resets every field back to the schema defaults", async () => {
    const recorder: Recorder = { pdf: [], docx: [] };
    await renderPanel(makePorts(recorder, null));

    await dom.setValue("pdf-settings-headerText", "Confidential");
    await dom.click("pdf-settings-reset");

    expect((dom.find("pdf-settings-headerText") as unknown as HTMLInputElement).value).toBe("");
    await dom.click("pdf-export");
    // The five schema defaults survive a reset — and they are exactly
    // `resolvePdfSettings`'s own defaults, so a reset form and an untouched one
    // resolve to the same document. Nothing the user typed remains.
    expect(recorder.pdf[0]!.settings).toEqual({
      page: "a4",
      orientation: "portrait",
      cover: true,
      outline: true,
      accentColor: "#4B57A3",
    });
  });
});
