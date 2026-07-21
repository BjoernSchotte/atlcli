/**
 * `buildMacroResolutionOptions` — the contract every host depends on.
 */
import { describe, expect, test } from "bun:test";
import type { ConfluenceClient } from "@atlcli/confluence";
import type { ExternalAssetPolicy } from "@atlcli/export-macros";
import { buildMacroResolutionOptions } from "./macro-options.js";
import type { JiraClientLike, JiraIssueLike } from "./ports.js";

const BASE = "https://acme.atlassian.net";

const confluence = {
  async getPage() {
    return { id: "1", version: 1, storage: "" };
  },
} as unknown as ConfluenceClient;

const jira: JiraClientLike = {
  async getIssue(): Promise<JiraIssueLike> {
    return { key: "A-1", fields: {} };
  },
  async search() {
    return { issues: [] };
  },
};

describe("buildMacroResolutionOptions", () => {
  test("contextFor builds the context from the page it is GIVEN, never a remembered root", () => {
    // The resolver calls contextFor(block.sourcePage ?? ctx.page). Substituting
    // the export root here would resolve every child page's macros against the
    // wrong page while the report still looked successful.
    const options = buildMacroResolutionOptions({
      siteBaseUrl: BASE,
      confluence,
      targetEngine: "docx",
    });
    const root = options.contextFor!({ id: "100", spaceKey: "DOC" });
    const child = options.contextFor!({ id: "200", spaceKey: "DOC" });
    expect(root.page.id).toBe("100");
    expect(child.page.id).toBe("200");
    expect(child.siteId).toBe(BASE);
  });

  test("shares one set of ports across pages (per-page memoisation lives inside them)", () => {
    const options = buildMacroResolutionOptions({
      siteBaseUrl: BASE,
      confluence,
      targetEngine: "docx",
    });
    const a = options.contextFor!({ id: "1", spaceKey: "DOC" });
    const b = options.contextFor!({ id: "2", spaceKey: "DOC" });
    expect(a.confluence).toBe(b.confluence);
    expect(a.exportView).toBe(b.exportView);
    expect(a.attachments).toBe(b.attachments);
    expect(a.externalAssets).toBe(b.externalAssets);
    // A fresh visited set per page: sharing it would make one page's include
    // chain look like a cycle on the next.
    expect(a.visited).not.toBe(b.visited);
  });

  test("omits the Jira port when the host has no Jira client", () => {
    const without = buildMacroResolutionOptions({
      siteBaseUrl: BASE,
      confluence,
      targetEngine: "docx",
    });
    expect(without.contextFor!({ id: "1", spaceKey: "D" }).jira).toBeUndefined();
    const with_ = buildMacroResolutionOptions({
      siteBaseUrl: BASE,
      confluence,
      jira,
      targetEngine: "docx",
    });
    expect(with_.contextFor!({ id: "1", spaceKey: "D" }).jira).toBeDefined();
  });

  test("carries the engine flags the renderers branch on", () => {
    const pdf = buildMacroResolutionOptions({
      siteBaseUrl: BASE,
      confluence,
      targetEngine: "pdf",
      nativeTocPresent: true,
      live: false,
    });
    const ctx = pdf.contextFor!({ id: "1", spaceKey: "D" });
    expect(ctx.flags?.targetEngine).toBe("pdf");
    expect(ctx.flags?.nativeTocPresent).toBe(true);
    expect(pdf.live).toBe(false);
  });

  test("`live` is absent (not false) when the host does not set it", () => {
    const options = buildMacroResolutionOptions({
      siteBaseUrl: BASE,
      confluence,
      targetEngine: "docx",
    });
    expect("live" in options).toBe(false);
  });

  test("defaults to the same-origin-only policy, and honours a host-supplied one", () => {
    const strict = buildMacroResolutionOptions({
      siteBaseUrl: BASE,
      confluence,
      targetEngine: "docx",
    });
    const strictAssets = strict.contextFor!({ id: "1", spaceKey: "D" }).externalAssets!;
    // No network: the policy rejects before any fetch is attempted.
    expect(
      strictAssets
        .fetch("https://cdn.example.com/x.png", { maxBytes: 10 })
        .then(() => "resolved")
        .catch((e: Error) => e.message)
    ).resolves.toMatch(/blocked by the export asset policy/);

    const wideOpen: ExternalAssetPolicy = { allow: () => true };
    const calls: string[] = [];
    const custom = buildMacroResolutionOptions({
      siteBaseUrl: BASE,
      confluence,
      targetEngine: "docx",
      policy: wideOpen,
      externalAssets: {
        async fetch(url) {
          calls.push(url);
          return { bytes: new Uint8Array([1]) };
        },
      },
    });
    const ctx = custom.contextFor!({ id: "1", spaceKey: "D" });
    expect(ctx.externalAssets).toBeDefined();
    void ctx.externalAssets!.fetch("https://cdn.example.com/x.png", { maxBytes: 10 });
    expect(calls).toEqual(["https://cdn.example.com/x.png"]);
  });

  test("forwards the host's abort signal into every macro context", () => {
    const controller = new AbortController();
    const options = buildMacroResolutionOptions({
      siteBaseUrl: BASE,
      confluence,
      targetEngine: "docx",
      signal: controller.signal,
    });
    expect(options.contextFor!({ id: "1", spaceKey: "D" }).signal).toBe(
      controller.signal
    );
  });
});
