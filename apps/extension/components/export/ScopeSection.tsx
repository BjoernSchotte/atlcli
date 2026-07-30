/**
 * The shared scope form (spec 010 T5.1, Architecture point 7).
 *
 * **One scope, both engines.** This section sits *above* the PDF and Word
 * panels, not inside either — so the two buttons can never disagree about what
 * "the export" covers. That is the whole of Architecture point 7.
 *
 * **A view, not a state machine.** Every transition is
 * `reduceScope(state, event)` from `utils/scope-state.ts`, and every derived
 * value (`toExportScope`, `toLabelFilter`, `canUseSpaceScope`,
 * `parseLabelInput`) is one of that module's pure selectors. There is no scope
 * logic in this file — a second host renders a different form over the same
 * reducer, and the reducer's tests stay the specification.
 *
 * **Progressive disclosure is the mechanism, not a decoration.** The defaults
 * are today's behaviour — current page, no filters, macros resolved — and every
 * knob that is not that lives behind a closed `<details>`. The 90 % single-page
 * case must not get one click harder because tree exports exist, so the
 * closed-by-default property is pinned by a test rather than left to review.
 */
import React from "react";
import type { ScopeContext, ScopeEvent, ScopeState } from "../../utils/scope-state.js";
import {
  canUseSpaceScope,
  SCOPE_MAX_DEPTH,
  SCOPE_MIN_DEPTH,
  type ScopeKind,
} from "../../utils/scope-state.js";
import { useT } from "../../utils/i18n/context.js";
import type { MessageKey } from "../../utils/i18n/messages.js";
import { Button } from "../ui/button.js";
import {
  CheckboxField,
  FieldHelp,
  Label,
  Select,
} from "../ui/field.js";
import { cn } from "../ui/utils.js";

const DEPTHS: readonly number[] = Array.from(
  { length: SCOPE_MAX_DEPTH - SCOPE_MIN_DEPTH + 1 },
  (_, index) => SCOPE_MIN_DEPTH + index
);

const KIND_LABEL_KEYS: Record<ScopeKind, MessageKey> = {
  page: "scope.kind.page",
  tree: "scope.kind.tree",
  space: "scope.kind.space",
};

const KIND_DETAIL_KEYS: Record<ScopeKind, MessageKey> = {
  page: "scope.kind.pageDetail",
  tree: "scope.kind.treeDetail",
  space: "scope.kind.spaceDetail",
};

export interface ScopeSectionProps {
  state: ScopeState;
  dispatch: (event: ScopeEvent) => void;
  /** Host facts (page id, space key) — supplied per render, never stored. */
  context: ScopeContext;
  /** `false` turns dynamic macro resolution off (spec 010 T5.4). Default ON. */
  resolveMacros: boolean;
  onResolveMacrosChange: (next: boolean) => void;
  /** An export is running: the form is read-only until it finishes. */
  disabled?: boolean;
}

/** One label chip list plus its comma-separated input. */
function LabelField({
  field,
  labels,
  dispatch,
  disabled,
  labelKey,
  helpKey,
}: {
  field: "include" | "exclude";
  labels: readonly string[];
  dispatch: (event: ScopeEvent) => void;
  disabled?: boolean;
  labelKey: MessageKey;
  helpKey: MessageKey;
}): React.JSX.Element {
  const t = useT();
  const inputId = `scope-labels-${field}`;
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={inputId}>{t(labelKey)}</Label>
      <input
        id={inputId}
        type="text"
        // A plain comma-separated text field rather than a chip editor: the
        // reducer normalizes on every keystroke (`set-labels`), so what the user
        // typed and what the export filters on can never drift apart.
        value={labels.join(", ")}
        disabled={disabled}
        data-testid={inputId}
        placeholder={t("scope.labels.placeholder")}
        onChange={(event) =>
          dispatch({ type: "set-labels", field, input: event.target.value })
        }
        className="h-11 w-full rounded-md border bg-background px-2.5 text-sm text-foreground placeholder:text-muted-foreground disabled:opacity-50"
      />
      <FieldHelp>{t(helpKey)}</FieldHelp>
      {labels.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-1 p-0" data-testid={`${inputId}-chips`}>
          {labels.map((label) => (
            <li key={label}>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => dispatch({ type: "remove-label", field, label })}
                title={t("scope.labels.remove", { label })}
              >
                {label} ×
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ScopeSection({
  state,
  dispatch,
  context,
  resolveMacros,
  onResolveMacrosChange,
  disabled,
}: ScopeSectionProps): React.JSX.Element {
  const t = useT();
  const spaceAllowed = canUseSpaceScope(context);

  return (
    <section data-testid="scope-section" className="flex flex-col gap-2">
      <div role="radiogroup" aria-label={t("scope.title")} className="grid grid-cols-3 gap-1.5">
        {(["page", "tree", "space"] as const).map((kind) => {
          const unavailable = kind === "space" && !spaceAllowed;
          return (
            <label
              key={kind}
              className={cn(
                "relative min-w-0",
                disabled || unavailable ? "cursor-not-allowed opacity-50" : "cursor-pointer"
              )}
            >
              <input
                type="radio"
                className="peer sr-only"
                name="scope-kind"
                value={kind}
                checked={state.kind === kind}
                disabled={disabled || unavailable}
                data-testid={`scope-kind-${kind}`}
                onChange={() => dispatch({ type: "set-kind", kind })}
              />
              <span
                className={cn(
                  "grid min-h-[58px] min-w-0 content-center gap-1 rounded-lg border bg-card px-2 py-2",
                  "text-left transition-colors peer-focus-visible:outline peer-focus-visible:outline-2",
                  "peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring",
                  "peer-checked:border-primary/45 peer-checked:bg-accent peer-checked:text-primary",
                  !disabled && !unavailable && "hover:border-input hover:bg-muted"
                )}
              >
                <strong className="truncate text-xs font-bold leading-tight">
                  {t(KIND_LABEL_KEYS[kind])}
                </strong>
                <span className="truncate text-xs leading-tight text-muted-foreground">
                  {t(KIND_DETAIL_KEYS[kind])}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      {!spaceAllowed && (
        <FieldHelp data-testid="scope-space-unavailable">
          {t("scope.kind.spaceUnavailable")}
        </FieldHelp>
      )}

      {state.kind === "tree" && (
        <div className="flex flex-col gap-1.5" data-testid="scope-tree-options">
          <div className="flex items-center gap-2">
            <Label htmlFor="scope-depth" className="shrink-0">
              {t("scope.depth.label")}
            </Label>
            <Select
              id="scope-depth"
              data-testid="scope-depth"
              className="w-20"
              value={String(state.maxDepth)}
              disabled={disabled}
              onChange={(event) =>
                dispatch({ type: "set-max-depth", depth: Number(event.target.value) })
              }
            >
              {DEPTHS.map((depth) => (
                <option key={depth} value={String(depth)}>
                  {depth}
                </option>
              ))}
            </Select>
          </div>
          <CheckboxField
            data-testid="scope-include-root"
            checked={state.includeRoot}
            disabled={disabled}
            label={t("scope.includeRoot.label")}
            onChange={(event) =>
              dispatch({ type: "set-include-root", includeRoot: event.target.checked })
            }
          />
        </div>
      )}

      {/*
        Closed by default, and it must stay that way: the single-page export is
        the overwhelmingly common case and it needs zero interaction with any of
        this. `<details>` gives the disclosure, the keyboard behaviour and the
        screen-reader semantics for free.
      */}
      <details data-testid="scope-advanced" className="border-t">
        <summary className="flex min-h-11 cursor-pointer items-center text-xs font-semibold text-muted-foreground">
          {t("scope.advanced")}
        </summary>
        <div className="mt-2 flex flex-col gap-3">
          <LabelField
            field="include"
            labels={state.includeLabels}
            dispatch={dispatch}
            disabled={disabled}
            labelKey="scope.labels.include"
            helpKey="scope.labels.includeHelp"
          />
          <LabelField
            field="exclude"
            labels={state.excludeLabels}
            dispatch={dispatch}
            disabled={disabled}
            labelKey="scope.labels.exclude"
            helpKey="scope.labels.excludeHelp"
          />

          <div className="flex flex-col gap-1">
            <Label htmlFor="scope-exclude-mode">{t("scope.excludeMode.label")}</Label>
            <Select
              id="scope-exclude-mode"
              data-testid="scope-exclude-mode"
              value={state.excludeMode}
              disabled={disabled}
              onChange={(event) =>
                dispatch({
                  type: "set-exclude-mode",
                  mode: event.target.value as ScopeState["excludeMode"],
                })
              }
            >
              <option value="prune-subtree">{t("scope.excludeMode.pruneSubtree")}</option>
              <option value="page-only">{t("scope.excludeMode.pageOnly")}</option>
            </Select>
            <FieldHelp>
              {state.excludeMode === "prune-subtree"
                ? t("scope.excludeMode.pruneSubtreeHelp")
                : t("scope.excludeMode.pageOnlyHelp")}
            </FieldHelp>
          </div>

          {/*
            Default ON: an export that silently omits Jira status and
            `export_view` content is a worse surprise than one that takes a
            moment longer. OFF is offered because it makes an export
            deterministic and network-free, which is what a reproducible build
            wants.
          */}
          <CheckboxField
            data-testid="scope-resolve-macros"
            checked={resolveMacros}
            disabled={disabled}
            label={t("scope.macros.label")}
            help={
              resolveMacros ? t("scope.macros.onHelp") : t("scope.macros.offHelp")
            }
            onChange={(event) => onResolveMacrosChange(event.target.checked)}
          />
        </div>
      </details>
    </section>
  );
}
