import { expect, test } from "bun:test";
import {
  EXPORT_NOTE_CODES as directNoteCodes,
  materializeTable as directMaterializeTable,
  type ExportBlock as DirectExportBlock,
} from "@atlcli/export-blocks";
import {
  EXPORT_NOTE_CODES as compatibilityNoteCodes,
  materializeTable as compatibilityMaterializeTable,
  type ExportBlock as CompatibilityExportBlock,
} from "./index.js";

test("@atlcli/confluence re-exports the exact standalone ExportBlock contract", () => {
  const direct: DirectExportBlock = {
    type: "paragraph",
    content: [{ type: "text", text: "shared" }],
  };
  const compatibility: CompatibilityExportBlock = direct;
  const roundTrip: DirectExportBlock = compatibility;

  expect(roundTrip).toBe(direct);
  expect(compatibilityNoteCodes).toBe(directNoteCodes);
  expect(compatibilityMaterializeTable).toBe(directMaterializeTable);
});
