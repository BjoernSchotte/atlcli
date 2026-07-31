import { expect, test } from "bun:test";
import { diagramMacroRenderer } from "./diagram.js";
import { exportViewFallbackRenderer } from "./export-view.js";
import { jiraMacroRenderer } from "./jira.js";
import { tocRenderer } from "./toc.js";
import { whiteboardRenderer } from "./whiteboard.js";

test("built-in renderers declare only the closed web publication model", () => {
  const models = [
    tocRenderer().webRenderModel,
    jiraMacroRenderer().webRenderModel,
    diagramMacroRenderer().webRenderModel,
    whiteboardRenderer().webRenderModel,
    exportViewFallbackRenderer({ htmlToExportBlocks: () => ({ blocks: [], notes: [] }) }).webRenderModel,
  ];

  expect(models).toEqual([
    { kind: "toc", dependencies: [] },
    { kind: "jira-data", dependencies: ["jira"] },
    { kind: "diagram", dependencies: ["attachment"] },
    { kind: "smart-card", dependencies: [] },
    { kind: "unknown", dependencies: ["export-view"] },
  ]);
});
