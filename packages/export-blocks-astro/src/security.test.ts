import { expect, test } from "bun:test";
import {
  safeExportBlockAssetSrcV1,
  safeExportBlockColorV1,
  safeExportBlockHrefV1,
  safeExportBlockPercentageV1,
} from "./security.js";

test("security helpers reject active URL and CSS values", () => {
  expect(safeExportBlockHrefV1("https://example.test/a")).toBe("https://example.test/a");
  expect(safeExportBlockHrefV1("java\tscript:alert(1)")).toBeUndefined();
  expect(safeExportBlockHrefV1("data:text/html,boom")).toBeUndefined();
  expect(safeExportBlockHrefV1("//evil.test/path")).toBeUndefined();
  expect(safeExportBlockAssetSrcV1("/assets/a.svg")).toBe("/assets/a.svg");
  expect(safeExportBlockAssetSrcV1("https://evil.test/a.svg")).toBeUndefined();
  expect(safeExportBlockAssetSrcV1("data:image/svg+xml,boom")).toBeUndefined();
  expect(safeExportBlockColorV1("#0c66e4")).toBe("#0c66e4");
  expect(safeExportBlockColorV1("red;background:url(https://evil.test)")).toBeUndefined();
  expect(safeExportBlockPercentageV1(33.333)).toBe("33.333%");
  expect(safeExportBlockPercentageV1("0%;background:url(https://evil.test)")).toBeUndefined();
});
