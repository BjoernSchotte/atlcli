import {
  EMPTY_ACTION_SELECTION_V1,
  moveActionSelectionV1,
  repairActionSelectionV1,
  selectActionByIdV1,
  type ActionInputSchemaV1,
  type ActionInputValuesV1,
  type ActionResultV1,
  type ActionSearchResultV1,
  type ActionSelectionMoveV1,
  type ActionSelectionStateV1,
} from "@atlcli/action-registry";

export type ActionInputErrorCodeV1 =
  | "required"
  | "too-short"
  | "too-long"
  | "invalid-option";

export type ActionInputErrorsV1 = Readonly<
  Record<string, ActionInputErrorCodeV1>
>;

export type ActionPaletteScreenV1 =
  | { readonly kind: "root" }
  | { readonly kind: "action-panel"; readonly actionId: string }
  | {
      readonly kind: "input";
      readonly actionId: string;
      readonly schema: ActionInputSchemaV1;
      readonly values: ActionInputValuesV1;
      readonly errors: ActionInputErrorsV1;
    }
  | { readonly kind: "executing"; readonly actionId: string }
  | {
      readonly kind: "result";
      readonly actionId: string;
      readonly result: ActionResultV1;
    };

export interface ActionPaletteMachineStateV1 {
  readonly query: string;
  readonly selection: ActionSelectionStateV1;
  readonly screen: ActionPaletteScreenV1;
}

export type ActionPaletteMachineEventV1 =
  | {
      readonly type: "reset";
      readonly results: readonly ActionSearchResultV1[];
    }
  | {
      readonly type: "query";
      readonly query: string;
      readonly results: readonly ActionSearchResultV1[];
    }
  | {
      readonly type: "move";
      readonly move: ActionSelectionMoveV1;
      readonly results: readonly ActionSearchResultV1[];
    }
  | {
      readonly type: "select";
      readonly actionId: string;
      readonly results: readonly ActionSearchResultV1[];
    }
  | { readonly type: "action-panel"; readonly actionId: string }
  | {
      readonly type: "input";
      readonly actionId: string;
      readonly schema: ActionInputSchemaV1;
      readonly values?: ActionInputValuesV1;
      readonly errors?: ActionInputErrorsV1;
    }
  | { readonly type: "input-values"; readonly values: ActionInputValuesV1 }
  | { readonly type: "input-errors"; readonly errors: ActionInputErrorsV1 }
  | { readonly type: "executing"; readonly actionId: string }
  | {
      readonly type: "result";
      readonly actionId: string;
      readonly result: ActionResultV1;
    }
  | {
      readonly type: "back";
      readonly results: readonly ActionSearchResultV1[];
    };

export const INITIAL_ACTION_PALETTE_STATE_V1: ActionPaletteMachineStateV1 =
  Object.freeze({
    query: "",
    selection: EMPTY_ACTION_SELECTION_V1,
    screen: Object.freeze({ kind: "root" as const }),
  });

export function createActionInputValuesV1(
  schema: ActionInputSchemaV1,
): ActionInputValuesV1 {
  return Object.freeze(
    Object.fromEntries(schema.fields.map((field) => [field.id, ""])),
  );
}

export function validateActionPaletteInputV1(
  schema: ActionInputSchemaV1,
  values: ActionInputValuesV1,
): ActionInputErrorsV1 {
  const errors: Record<string, ActionInputErrorCodeV1> = {};
  for (const field of schema.fields) {
    const value = values[field.id] ?? "";
    if (field.required && value.trim() === "") {
      errors[field.id] = "required";
      continue;
    }
    if (field.type === "text") {
      const length = [...value].length;
      if (value !== "" && field.minLength !== undefined && length < field.minLength) {
        errors[field.id] = "too-short";
      } else if (length > field.maxLength) {
        errors[field.id] = "too-long";
      }
    } else if (
      value !== "" &&
      !field.options.some((option) => option.id === value)
    ) {
      errors[field.id] = "invalid-option";
    }
  }
  return Object.freeze(errors);
}

export function reduceActionPaletteStateV1(
  state: ActionPaletteMachineStateV1,
  event: ActionPaletteMachineEventV1,
): ActionPaletteMachineStateV1 {
  switch (event.type) {
    case "reset":
      return {
        query: "",
        selection: moveActionSelectionV1(
          EMPTY_ACTION_SELECTION_V1,
          event.results,
          "first",
        ),
        screen: { kind: "root" },
      };
    case "query":
      return {
        query: event.query,
        selection: repairActionSelectionV1(state.selection, event.results),
        screen: { kind: "root" },
      };
    case "move":
      return {
        ...state,
        selection: moveActionSelectionV1(state.selection, event.results, event.move),
      };
    case "select": {
      const selection = selectActionByIdV1(event.actionId, event.results);
      return selection ? { ...state, selection } : state;
    }
    case "action-panel":
      return { ...state, screen: { kind: "action-panel", actionId: event.actionId } };
    case "input":
      return {
        ...state,
        screen: {
          kind: "input",
          actionId: event.actionId,
          schema: event.schema,
          values: event.values ?? createActionInputValuesV1(event.schema),
          errors: event.errors ?? {},
        },
      };
    case "input-values":
      return state.screen.kind === "input"
        ? { ...state, screen: { ...state.screen, values: event.values } }
        : state;
    case "input-errors":
      return state.screen.kind === "input"
        ? { ...state, screen: { ...state.screen, errors: event.errors } }
        : state;
    case "executing":
      return { ...state, screen: { kind: "executing", actionId: event.actionId } };
    case "result":
      return {
        ...state,
        screen: { kind: "result", actionId: event.actionId, result: event.result },
      };
    case "back":
      return {
        ...state,
        selection: repairActionSelectionV1(state.selection, event.results),
        screen: { kind: "root" },
      };
  }
}
