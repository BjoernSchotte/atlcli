import { expect, test } from "bun:test";
import { AstroExportBlockOverrideErrorV1, createAstroExportBlockOverrideRegistryV1 } from "./overrides.js";

const selection = { schema: "atlcli.export-blocks-astro-overrides/1" as const, selected: { heading: "brand-heading" } };
const available = [{ id: "brand-heading", version: "1.0.0", slot: "heading" as const, module: "@example/heading" }];

test("only resolves operator-selected installed descriptors in their declared slot", () => {
  expect(createAstroExportBlockOverrideRegistryV1(available, selection).get("heading")).toEqual(available[0]);
  expect(() => createAstroExportBlockOverrideRegistryV1(available, { ...selection, selected: { heading: "page-controlled" } })).toThrow(AstroExportBlockOverrideErrorV1);
  expect(() => createAstroExportBlockOverrideRegistryV1(available, { ...selection, selected: { paragraph: "brand-heading" } })).toThrow("does not implement");
});
