import { describe, expect, it } from "bun:test";
import { exportDocx } from "./export.js";
import { buildDocx, para } from "./fixtures.js";

describe("DOCX artifact determinism", () => {
  it("pins every ZIP entry to exportDate across independent render times", async () => {
    const input = {
      details: {
        id: "42",
        title: "Deterministic guide",
        storage: "<p>Stable body</p>",
      },
      exportDate: new Date("2026-07-23T00:00:00.000Z"),
      template: {
        name: "deterministic.docx",
        modificationDate: new Date("2026-07-20T00:00:00.000Z"),
      },
    };
    const olderTemplate = buildDocx({
      body: para("$scroll.title") + para("$scroll.content"),
      date: new Date("2020-01-01T00:00:00.000Z"),
    });
    const newerTemplate = buildDocx({
      body: para("$scroll.title") + para("$scroll.content"),
      date: new Date("2025-01-01T00:00:00.000Z"),
    });

    const older = await exportDocx({
      ...input,
      templateBytes: olderTemplate,
    });
    const newer = await exportDocx({
      ...input,
      templateBytes: newerTemplate,
    });

    expect(newer.bytes).toEqual(older.bytes);
  });
});
