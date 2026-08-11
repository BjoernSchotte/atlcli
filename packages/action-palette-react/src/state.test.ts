import { describe, expect, test } from "bun:test";
import { searchActionCatalog } from "@atlcli/action-registry";
import {
  ACTION_PALETTE_MESSAGE_KEYS_V1,
  ACTION_PALETTE_MESSAGES_DE_V1,
  ACTION_PALETTE_MESSAGES_EN_V1,
  INITIAL_ACTION_PALETTE_STATE_V1,
  createActionInputValuesV1,
  formatActionPaletteMessageV1,
  mergeActionPaletteMessagesV1,
  reduceActionPaletteStateV1,
  validateActionPaletteInputV1,
} from "./index.js";
import { createPaletteCatalogV1, paletteModuleV1 } from "./testing/fixtures.js";

describe("presenter dictionaries", () => {
  test("keep English and German keys in exact parity", () => {
    expect(Object.keys(ACTION_PALETTE_MESSAGES_EN_V1).sort()).toEqual(
      [...ACTION_PALETTE_MESSAGE_KEYS_V1].sort(),
    );
    expect(Object.keys(ACTION_PALETTE_MESSAGES_DE_V1).sort()).toEqual(
      [...ACTION_PALETTE_MESSAGE_KEYS_V1].sort(),
    );
    expect(Object.values(ACTION_PALETTE_MESSAGES_EN_V1).every(Boolean)).toBe(true);
    expect(Object.values(ACTION_PALETTE_MESSAGES_DE_V1).every(Boolean)).toBe(true);
  });

  test("selects German, merges overrides, and never exposes missing placeholders", () => {
    expect(mergeActionPaletteMessagesV1("de-CH")["palette.close"]).toBe("Schließen");
    expect(
      mergeActionPaletteMessagesV1("fr-FR", { "palette.close": "Dismiss" })[
        "palette.close"
      ],
    ).toBe("Dismiss");
    expect(formatActionPaletteMessageV1("{count} for {action} {missing}", {
      count: 2,
      action: "Export",
    })).toBe("2 for Export ");
  });
});

describe("pure palette state machine", () => {
  const catalog = createPaletteCatalogV1();
  const results = searchActionCatalog(catalog, "");

  test("resets, moves, selects, filters, repairs, and returns to root", () => {
    let state = reduceActionPaletteStateV1(INITIAL_ACTION_PALETTE_STATE_V1, {
      type: "reset",
      results,
    });
    expect(state.selection.activeActionId).toBe("test.palette.export-pdf");
    state = reduceActionPaletteStateV1(state, { type: "move", move: "next", results });
    expect(state.selection.activeActionId).toBe("test.palette.quick-ask");
    state = reduceActionPaletteStateV1(state, {
      type: "select",
      actionId: "test.palette.unavailable",
      results,
    });
    expect(state.selection.activeActionId).toBe("test.palette.unavailable");
    const filtered = searchActionCatalog(catalog, "ask");
    state = reduceActionPaletteStateV1(state, {
      type: "query",
      query: "ask",
      results: filtered,
    });
    expect(state.selection.activeActionId).toBe("test.palette.quick-ask");
    state = reduceActionPaletteStateV1(state, {
      type: "action-panel",
      actionId: "test.palette.quick-ask",
    });
    expect(state.screen.kind).toBe("action-panel");
    state = reduceActionPaletteStateV1(state, { type: "back", results: filtered });
    expect(state.screen.kind).toBe("root");
  });

  test("models input, execution, and each structured result", () => {
    const schema = paletteModuleV1.actions[1]!.input!;
    let state = reduceActionPaletteStateV1(INITIAL_ACTION_PALETTE_STATE_V1, {
      type: "input",
      actionId: "test.palette.quick-ask",
      schema,
    });
    expect(state.screen).toEqual({
      kind: "input",
      actionId: "test.palette.quick-ask",
      schema,
      values: { question: "" },
      errors: {},
    });
    state = reduceActionPaletteStateV1(state, {
      type: "input-values",
      values: { question: "Explain this" },
    });
    state = reduceActionPaletteStateV1(state, {
      type: "executing",
      actionId: "test.palette.quick-ask",
    });
    expect(state.screen.kind).toBe("executing");
    for (const result of [
      { status: "completed", messageKey: "done" },
      {
        status: "failed",
        errorCode: "failed",
        messageKey: "failed",
        retryable: false,
      },
      {
        status: "open-surface",
        target: { kind: "sidebar", screen: "research" },
      },
    ] as const) {
      state = reduceActionPaletteStateV1(state, {
        type: "result",
        actionId: "test.palette.quick-ask",
        result,
      });
      expect(state.screen).toEqual({
        kind: "result",
        actionId: "test.palette.quick-ask",
        result,
      });
    }
  });
});

describe("bounded input validation", () => {
  const schema = paletteModuleV1.actions[1]!.input!;

  test("creates exact empty values and validates code points", () => {
    expect(createActionInputValuesV1(schema)).toEqual({ question: "" });
    expect(validateActionPaletteInputV1(schema, {})).toEqual({ question: "required" });
    expect(validateActionPaletteInputV1(schema, { question: "x" })).toEqual({
      question: "too-short",
    });
    expect(validateActionPaletteInputV1(schema, { question: "👍👍" })).toEqual({});
    expect(validateActionPaletteInputV1(schema, { question: "x".repeat(201) })).toEqual({
      question: "too-long",
    });
  });

  test("rejects an undeclared select value", () => {
    expect(
      validateActionPaletteInputV1(
        {
          schemaVersion: 1,
          fields: [
            {
              type: "select",
              id: "mode",
              label: { key: "mode", fallback: "Mode" },
              options: [{ id: "short", label: { key: "short", fallback: "Short" } }],
            },
          ],
          submitLabel: { key: "run", fallback: "Run" },
        },
        { mode: "invented" },
      ),
    ).toEqual({ mode: "invalid-option" });
  });
});
