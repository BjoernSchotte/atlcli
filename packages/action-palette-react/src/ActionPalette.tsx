import {
  Component,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  evaluateActionRequirementsV1,
  searchActionCatalog,
  type ActionAffordanceV1,
  type ActionCatalogEntryV1,
  type ActionInputSchemaV1,
  type ActionInputValuesV1,
  type ActionResultV1,
  type ActionSearchResultV1,
  type ActionTextV1,
} from "@atlcli/action-registry";
import {
  formatActionPaletteMessageV1,
  mergeActionPaletteMessagesV1,
  type ActionPaletteMessageKeyV1,
  type ActionPaletteMessagesV1,
} from "./messages.js";
import {
  INITIAL_ACTION_PALETTE_STATE_V1,
  createActionInputValuesV1,
  reduceActionPaletteStateV1,
  validateActionPaletteInputV1,
  type ActionInputErrorCodeV1,
  type ActionPaletteMachineStateV1,
} from "./state.js";
import type {
  ActionPaletteExecuteRequestV1,
  ActionPalettePropsV1,
  ActionPalettePublicPhaseV1,
  ActionPalettePublicStateV1,
} from "./types.js";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function defaultResolveText(text: ActionTextV1): string {
  return text.fallback;
}

function phaseOf(state: ActionPaletteMachineStateV1): ActionPalettePublicPhaseV1 {
  switch (state.screen.kind) {
    case "root":
      return "root";
    case "action-panel":
      return "action-panel";
    case "input":
      return "input";
    case "executing":
      return "executing";
    case "result":
      if (state.screen.result.status === "queued") return "queued";
      if (state.screen.result.status === "failed") return "failed";
      return "completed";
  }
}

function selectedEntry(
  results: readonly ActionSearchResultV1[],
  actionId: string | null,
): ActionCatalogEntryV1 | undefined {
  return results.find((result) => result.entry.action.id === actionId)?.entry;
}

function isCompositionEvent(event: ReactKeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
}

function useRestoredFocusV1(
  open: boolean,
  rootRef: RefObject<HTMLDivElement | null>,
  onOpened: (() => void) | undefined,
): void {
  useLayoutEffect(() => {
    if (!open) return;
    const ownerDocument = rootRef.current?.ownerDocument ?? globalThis.document;
    const previous = ownerDocument?.activeElement;
    const restorable =
      previous instanceof HTMLElement && !rootRef.current?.contains(previous)
        ? previous
        : null;
    onOpened?.();
    return () => {
      if (restorable?.isConnected) restorable.focus({ preventScroll: true });
    };
  }, [onOpened, open, rootRef]);
}

function useThrottledTextV1(value: string, delayMs = 120): string {
  const [visible, setVisible] = useState("");
  const lastChangedAt = useRef(Date.now());
  useEffect(() => {
    if (visible === value) return;
    const elapsed = Date.now() - lastChangedAt.current;
    const wait = Math.max(0, delayMs - elapsed);
    const timeout = globalThis.setTimeout(() => {
      lastChangedAt.current = Date.now();
      setVisible(value);
    }, wait);
    return () => globalThis.clearTimeout(timeout);
  }, [delayMs, value, visible]);
  return visible;
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) =>
      element.getAttribute("aria-hidden") !== "true" &&
      element.getAttribute("hidden") === null,
  );
}

function trapTabKey(event: ReactKeyboardEvent<HTMLDivElement>): void {
  if (event.key !== "Tab") return;
  const focusables = focusableElements(event.currentTarget);
  if (focusables.length === 0) {
    event.preventDefault();
    event.currentTarget.focus();
    return;
  }
  const ownerDocument = event.currentTarget.ownerDocument;
  const currentIndex = focusables.indexOf(ownerDocument.activeElement as HTMLElement);
  const nextIndex = event.shiftKey
    ? currentIndex <= 0
      ? focusables.length - 1
      : currentIndex - 1
    : currentIndex < 0 || currentIndex === focusables.length - 1
      ? 0
      : currentIndex + 1;
  if (
    (event.shiftKey && currentIndex <= 0) ||
    (!event.shiftKey && currentIndex === focusables.length - 1)
  ) {
    event.preventDefault();
    focusables[nextIndex]?.focus();
  }
}

interface ErrorBoundaryProps {
  readonly children: ReactNode;
  readonly messages: ActionPaletteMessagesV1;
  readonly onClose: () => void;
}

interface ErrorBoundaryState {
  readonly failed: boolean;
}

export class ActionPaletteErrorBoundaryV1 extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="atlcli-action-palette-layer" data-testid="palette-error-boundary">
        <div className="atlcli-action-palette-backdrop" aria-hidden="true" />
        <section
          className="atlcli-action-palette-frame atlcli-action-palette-fatal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="atlcli-action-palette-fatal-title"
        >
          <h2 id="atlcli-action-palette-fatal-title">
            {this.props.messages["palette.error.boundary.title"]}
          </h2>
          <p>{this.props.messages["palette.error.boundary.message"]}</p>
          <button type="button" onClick={this.props.onClose}>
            {this.props.messages["palette.close"]}
          </button>
        </section>
      </div>
    );
  }
}

interface GroupedResults {
  readonly group: string;
  readonly results: readonly ActionSearchResultV1[];
}

function groupResults(results: readonly ActionSearchResultV1[]): readonly GroupedResults[] {
  const groups = new Map<string, ActionSearchResultV1[]>();
  for (const result of results) {
    const group = result.entry.action.group;
    const existing = groups.get(group);
    if (existing) existing.push(result);
    else groups.set(group, [result]);
  }
  return [...groups].map(([group, groupedResults]) => ({
    group,
    results: groupedResults,
  }));
}

function fallbackGroupLabel(group: string): string {
  const token = group.split(".").at(-1) ?? group;
  return token.charAt(0).toLocaleUpperCase() + token.slice(1).replace(/-/gu, " ");
}

interface RootListProps {
  readonly results: readonly ActionSearchResultV1[];
  readonly activeActionId: string | null;
  readonly listboxId: string;
  readonly listboxLabel: string;
  readonly resolveText: (text: ActionTextV1) => string;
  readonly resolveIcon: ActionPalettePropsV1["resolveIcon"];
  readonly messages: ActionPaletteMessagesV1;
  readonly onSelect: (actionId: string) => void;
  readonly onActivate: (entry: ActionCatalogEntryV1) => void;
}

function RootList({
  results,
  activeActionId,
  listboxId,
  listboxLabel,
  resolveText,
  resolveIcon,
  messages,
  onSelect,
  onActivate,
}: RootListProps): ReactNode {
  const grouped = groupResults(results);
  return (
    <div
      id={listboxId}
      className="atlcli-action-palette-results"
      role="listbox"
      aria-label={listboxLabel}
    >
      {grouped.map(({ group, results: groupEntries }) => {
        const groupId = `${listboxId}-${group.replace(/[^a-z0-9-]/giu, "-")}`;
        return (
          <section
            className="atlcli-action-palette-group"
            role="group"
            aria-labelledby={groupId}
            key={group}
          >
            <h2 id={groupId} role="presentation">{fallbackGroupLabel(group)}</h2>
            {groupEntries.map((result) => {
              const { entry } = result;
              const selected = entry.action.id === activeActionId;
              const optionId = `${listboxId}-option-${entry.catalogIndex}`;
              const reasonId = `${optionId}-reason`;
              const unavailableReason = entry.availability.available
                ? undefined
                : entry.availability.reasons.map((reason) => resolveText(reason.message)).join(" ");
              return (
                <div
                  id={optionId}
                  className="atlcli-action-palette-option"
                  data-active={selected ? "true" : undefined}
                  data-testid={`palette-option-${entry.action.id}`}
                  role="option"
                  aria-selected={selected}
                  aria-disabled={!entry.availability.available}
                  aria-describedby={unavailableReason ? reasonId : undefined}
                  key={entry.action.id}
                  onPointerMove={() => onSelect(entry.action.id)}
                  onClick={() => onActivate(entry)}
                >
                  <span className="atlcli-action-palette-icon" aria-hidden="true">
                    {resolveIcon?.(entry.action.icon, entry)}
                  </span>
                  <span className="atlcli-action-palette-option-copy">
                    <span className="atlcli-action-palette-option-title" title={resolveText(entry.action.title)}>
                      {resolveText(entry.action.title)}
                    </span>
                    {entry.action.subtitle ? (
                      <span className="atlcli-action-palette-option-subtitle">
                        {resolveText(entry.action.subtitle)}
                      </span>
                    ) : null}
                    {unavailableReason ? (
                      <span id={reasonId} className="atlcli-action-palette-option-reason">
                        {unavailableReason}
                      </span>
                    ) : null}
                  </span>
                  <span className="atlcli-action-palette-option-meta">
                    {entry.availability.available ? "↵" : messages["palette.unavailable"]}
                  </span>
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

interface ActionPanelItem {
  readonly action: ActionAffordanceV1;
  readonly available: boolean;
  readonly reason?: string;
}

function ActionPanel({
  title,
  items,
  messages,
  resolveText,
  onBack,
  onRun,
}: {
  readonly title: string;
  readonly items: readonly ActionPanelItem[];
  readonly messages: ActionPaletteMessagesV1;
  readonly resolveText: (text: ActionTextV1) => string;
  readonly onBack: () => void;
  readonly onRun: (action: ActionAffordanceV1) => void;
}): ReactNode {
  const headingId = useId();
  const panelRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    panelRef.current
      ?.querySelector<HTMLButtonElement>("[data-palette-panel-action]")
      ?.focus({ preventScroll: true });
  }, []);
  const handleKeys = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (isCompositionEvent(event)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onBack();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        "[data-palette-panel-action]",
      ),
    ];
    if (buttons.length === 0) return;
    const currentIndex = buttons.indexOf(
      event.currentTarget.ownerDocument.activeElement as HTMLButtonElement,
    );
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : event.key === "ArrowDown"
            ? Math.min(buttons.length - 1, Math.max(0, currentIndex + 1))
            : Math.max(0, currentIndex < 0 ? buttons.length - 1 : currentIndex - 1);
    buttons[nextIndex]?.focus();
  };
  return (
    <section
      ref={panelRef}
      className="atlcli-action-palette-detail"
      aria-labelledby={headingId}
      onKeyDown={handleKeys}
      data-testid="palette-action-panel"
    >
      <header>
        <button type="button" className="atlcli-action-palette-back" onClick={onBack}>
          <span aria-hidden="true">←</span> {messages["palette.back"]}
        </button>
        <h2 id={headingId}>
          {formatActionPaletteMessageV1(messages["palette.actions.title"], {
            action: title,
          })}
        </h2>
      </header>
      {items.length === 0 ? (
        <p className="atlcli-action-palette-empty-copy">
          {messages["palette.actions.empty"]}
        </p>
      ) : (
        <div className="atlcli-action-palette-panel-actions">
          {items.map((item, index) => (
            <button
              type="button"
              data-palette-panel-action="true"
              data-testid={`palette-panel-action-${item.action.id}`}
              aria-disabled={!item.available}
              aria-describedby={item.reason ? `palette-panel-reason-${index}` : undefined}
              key={item.action.id}
              onClick={() => {
                if (item.available) onRun(item.action);
              }}
            >
              <span>{resolveText(item.action.title)}</span>
              {item.reason ? (
                <small id={`palette-panel-reason-${index}`}>{item.reason}</small>
              ) : (
                <kbd>↵</kbd>
              )}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

const ERROR_MESSAGE_BY_CODE: Readonly<
  Record<ActionInputErrorCodeV1, ActionPaletteMessageKeyV1>
> = {
  required: "palette.error.required",
  "too-short": "palette.error.too-short",
  "too-long": "palette.error.too-long",
  "invalid-option": "palette.error.invalid-option",
};

function InputForm({
  title,
  contextLabel,
  schema,
  values,
  errors,
  messages,
  resolveText,
  onValues,
  onSubmit,
  onBack,
}: {
  readonly title: string;
  readonly contextLabel?: string;
  readonly schema: ActionInputSchemaV1;
  readonly values: ActionInputValuesV1;
  readonly errors: Readonly<Record<string, ActionInputErrorCodeV1>>;
  readonly messages: ActionPaletteMessagesV1;
  readonly resolveText: (text: ActionTextV1) => string;
  readonly onValues: (values: ActionInputValuesV1) => void;
  readonly onSubmit: (form: HTMLFormElement) => void;
  readonly onBack: () => void;
}): ReactNode {
  const idPrefix = useId();
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (Object.keys(errors).length === 0) return;
    formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus();
  }, [errors]);
  useLayoutEffect(() => {
    formRef.current
      ?.querySelector<HTMLElement>("input, textarea, select")
      ?.focus({ preventScroll: true });
  }, []);
  const update = (fieldId: string, value: string): void => {
    onValues(Object.freeze({ ...values, [fieldId]: value }));
  };
  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onSubmit(event.currentTarget);
  };
  const handleKeys = (event: ReactKeyboardEvent<HTMLFormElement>): void => {
    if (isCompositionEvent(event)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onBack();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSubmit(event.currentTarget);
    }
  };
  return (
    <form
      ref={formRef}
      className="atlcli-action-palette-detail atlcli-action-palette-form"
      data-testid="palette-input-form"
      onSubmit={handleSubmit}
      onKeyDown={handleKeys}
      noValidate
    >
      <header>
        <button type="button" className="atlcli-action-palette-back" onClick={onBack}>
          <span aria-hidden="true">←</span> {messages["palette.back"]}
        </button>
        <h2>
          {formatActionPaletteMessageV1(messages["palette.input.title"], {
            action: title,
          })}
        </h2>
      </header>
      <div className="atlcli-action-palette-fields">
        {contextLabel ? (
          <div className="atlcli-action-palette-context-chips" aria-label="Current context">
            <span>{contextLabel}</span>
          </div>
        ) : null}
        {schema.fields.map((field) => {
          const fieldId = `${idPrefix}-${field.id}`;
          const error = errors[field.id];
          const errorId = error ? `${fieldId}-error` : undefined;
          const common = {
            id: fieldId,
            name: field.id,
            value: values[field.id] ?? "",
            "data-testid": `palette-input-${field.id}`,
            "aria-invalid": error ? (true as const) : undefined,
            "aria-describedby": errorId,
            onChange: (
              event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
            ) => update(field.id, event.currentTarget.value),
          };
          return (
            <div className="atlcli-action-palette-field" key={field.id}>
              <label htmlFor={fieldId}>{resolveText(field.label)}</label>
              {field.type === "boolean" ? (
                <input
                  id={fieldId}
                  name={field.id}
                  type="checkbox"
                  checked={(values[field.id] ?? "") === "true"}
                  required={field.required}
                  data-testid={`palette-input-${field.id}`}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={errorId}
                  onChange={(event) => update(field.id, event.currentTarget.checked ? "true" : "false")}
                />
              ) : field.type === "select" ? (
                <select {...common} required={field.required}>
                  <option value="" />
                  {field.options.map((option) => (
                    <option value={option.id} key={option.id}>
                      {resolveText(option.label)}
                    </option>
                  ))}
                </select>
              ) : field.multiline ? (
                <textarea
                  {...common}
                  required={field.required}
                  minLength={field.minLength}
                  maxLength={field.maxLength}
                  placeholder={field.placeholder ? resolveText(field.placeholder) : undefined}
                  rows={5}
                />
              ) : (
                <input
                  {...common}
                  type="text"
                  required={field.required}
                  minLength={field.minLength}
                  maxLength={field.maxLength}
                  placeholder={field.placeholder ? resolveText(field.placeholder) : undefined}
                />
              )}
              {error ? (
                <p id={errorId} className="atlcli-action-palette-field-error">
                  {messages[ERROR_MESSAGE_BY_CODE[error]]}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      <footer className="atlcli-action-palette-form-footer">
        <button type="button" className="atlcli-action-palette-secondary" onClick={onBack}>
          {messages["palette.back"]}
        </button>
        <button type="submit" className="atlcli-action-palette-primary">
          {resolveText(schema.submitLabel)} <kbd>⌘↵</kbd>
        </button>
      </footer>
    </form>
  );
}

function ResultView({
  actionTitle,
  result,
  messages,
  resolveText,
  resolveResultText,
  onBack,
  onRetry,
  onRunAffordance,
  actionItems,
}: {
  readonly actionTitle: string;
  readonly result: ActionResultV1;
  readonly messages: ActionPaletteMessagesV1;
  readonly resolveText: (text: ActionTextV1) => string;
  readonly resolveResultText: (messageKey: string, fallback: string) => string;
  readonly onBack: () => void;
  readonly onRetry: () => void;
  readonly onRunAffordance: (action: ActionAffordanceV1) => void;
  readonly actionItems: readonly ActionPanelItem[];
}): ReactNode {
  const resultRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    resultRef.current?.focus({ preventScroll: true });
  }, []);
  const heading =
    result.status === "queued"
      ? messages["palette.queued"]
      : result.status === "failed"
        ? messages["palette.failed"]
        : messages["palette.completed"];
  const description =
    result.status === "completed"
      ? resolveResultText(result.messageKey, messages["palette.completed"])
      : result.status === "failed"
        ? resolveResultText(result.messageKey, messages["palette.failed"])
        : result.status === "queued"
          ? result.receipt.jobKind
            ? `${result.receipt.jobKind.toLocaleUpperCase()} · ${result.receipt.status}`
            : result.receipt.status
          : result.status === "open-surface"
            ? actionTitle
            : "";
  return (
    <section
      ref={resultRef}
      className="atlcli-action-palette-detail atlcli-action-palette-result"
      data-testid={`palette-result-${result.status}`}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !isCompositionEvent(event)) {
          event.preventDefault();
          onBack();
        }
      }}
    >
      <div className="atlcli-action-palette-status-mark" aria-hidden="true">
        {result.status === "failed" ? "!" : result.status === "queued" ? "…" : "✓"}
      </div>
      <h2>{heading}</h2>
      {description ? <p>{description}</p> : null}
      {result.status === "completed" && result.presentation ? (
        <div
          className="atlcli-action-palette-answer"
          data-testid="palette-result-presentation"
          aria-label="AI answer"
        >
          {result.presentation.text}
        </div>
      ) : null}
      <div className="atlcli-action-palette-result-actions">
        {result.status === "failed" && result.retryable ? (
          <button type="button" className="atlcli-action-palette-primary" onClick={onRetry}>
            {messages["palette.retry"]}
          </button>
        ) : null}
        {actionItems.map((item, index) => (
          <button
            type="button"
            key={item.action.id}
            aria-disabled={!item.available}
            aria-describedby={item.reason ? `palette-result-reason-${index}` : undefined}
            onClick={() => {
              if (item.available) onRunAffordance(item.action);
            }}
          >
            <span>{resolveText(item.action.title)}</span>
            {item.reason ? (
              <small id={`palette-result-reason-${index}`}>{item.reason}</small>
            ) : null}
          </button>
        ))}
        <button type="button" className="atlcli-action-palette-secondary" onClick={onBack}>
          {messages["palette.back"]}
        </button>
      </div>
    </section>
  );
}

function ExecutingView({
  title,
  streamText,
  closeLabel,
  cancelLabel,
  onClose,
  onCancel,
}: {
  readonly title: string;
  readonly streamText: string;
  readonly closeLabel: string;
  readonly cancelLabel: string;
  readonly onClose: () => void;
  readonly onCancel?: () => void;
}): ReactNode {
  const sectionRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    sectionRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <section
      ref={sectionRef}
      className="atlcli-action-palette-detail atlcli-action-palette-executing"
      data-testid="palette-executing"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !isCompositionEvent(event)) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <span className="atlcli-action-palette-progress" aria-hidden="true" />
      <h2>{title}</h2>
      {streamText ? (
        <div
          className="atlcli-action-palette-answer atlcli-action-palette-answer-stream"
          data-testid="palette-stream-text"
          aria-live="off"
        >
          {streamText}
        </div>
      ) : null}
      {onCancel ? (
        <button type="button" className="atlcli-action-palette-primary" onClick={onCancel}>
          {cancelLabel}
        </button>
      ) : null}
      <button type="button" className="atlcli-action-palette-secondary" onClick={onClose}>
        {closeLabel}
      </button>
    </section>
  );
}

function ActionPaletteContentV1(props: ActionPalettePropsV1): ReactNode {
  const {
    open,
    catalog,
    executor,
    contextLabel,
    footerLeading,
    aliases,
    messages: messageOverrides,
    resolveText = defaultResolveText,
    resolveResultText = (_messageKey, fallback) => fallback,
    resolveIcon,
    lifecycle,
    className,
  } = props;
  const messages = useMemo(
    () => mergeActionPaletteMessagesV1(catalog.context.locale, messageOverrides),
    [catalog.context.locale, messageOverrides],
  );
  const [state, dispatch] = useReducer(
    reduceActionPaletteStateV1,
    INITIAL_ACTION_PALETTE_STATE_V1,
  );
  const [announcement, setAnnouncement] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const inFlightRef = useRef<AbortController | null>(null);
  const executionTitleRef = useRef("");
  const lastRequestRef = useRef<{
    readonly request: ActionPaletteExecuteRequestV1;
    readonly title: string;
  } | null>(null);
  const dialogTitleId = useId();
  const listboxId = useId();
  const results = useMemo(
    () =>
      searchActionCatalog(catalog, state.query, {
        aliases,
        locale: catalog.context.locale,
      }),
    [aliases, catalog, state.query],
  );
  const activeEntry = selectedEntry(results, state.selection.activeActionId);
  const activeOptionId = activeEntry
    ? `${listboxId}-option-${activeEntry.catalogIndex}`
    : undefined;
  const resultCountText = formatActionPaletteMessageV1(
    messages["palette.results.count"],
    { count: results.length },
  );
  const liveText = useThrottledTextV1(announcement || resultCountText);

  useRestoredFocusV1(open, rootRef, lifecycle?.onOpened);

  useLayoutEffect(() => {
    if (!open) return;
    const defaultResults = searchActionCatalog(catalog, "", {
      aliases,
      locale: catalog.context.locale,
    });
    dispatch({ type: "reset", results: defaultResults });
    searchRef.current?.focus({ preventScroll: true });
  }, [aliases, catalog, open]);

  useEffect(() => {
    if (!open) return;
    const publicState: ActionPalettePublicStateV1 = {
      phase: phaseOf(state),
      query: state.query,
      activeActionId: state.selection.activeActionId,
    };
    lifecycle?.onStateChanged?.(publicState);
  }, [lifecycle, open, state]);

  useEffect(() => {
    if (!activeOptionId) return;
    const option = [
      ...(rootRef.current?.querySelectorAll<HTMLElement>("[role='option']") ?? []),
    ].find((candidate) => candidate.id === activeOptionId);
    option?.scrollIntoView?.({ block: "nearest" });
  }, [activeOptionId]);

  useEffect(() => {
    if (!open) inFlightRef.current?.abort();
    return () => inFlightRef.current?.abort();
  }, [open]);

  const requestClose = useCallback((): void => {
    inFlightRef.current?.abort();
    lifecycle?.onCloseRequested?.();
  }, [lifecycle]);

  const runRequest = useCallback(
    async (request: ActionPaletteExecuteRequestV1, title: string): Promise<void> => {
      if (inFlightRef.current) return;
      const controller = new AbortController();
      inFlightRef.current = controller;
      executionTitleRef.current = title;
      lastRequestRef.current = { request, title };
      dispatch({ type: "executing", actionId: request.actionId });
      setAnnouncement(
        formatActionPaletteMessageV1(messages["palette.executing"], {
          action: title,
        }),
      );
      try {
        const result = await executor.execute(request, controller.signal, (event) => {
          if (!controller.signal.aborted) dispatch({ type: "stream", ...event });
        });
        if (controller.signal.aborted) return;
        lifecycle?.onResult?.(request.actionId, result);
        if (result.status === "input-required") {
          dispatch({
            type: "input",
            actionId: request.actionId,
            schema: result.input,
          });
          setAnnouncement("");
        } else {
          dispatch({ type: "result", actionId: request.actionId, result });
          setAnnouncement(
            result.status === "failed"
              ? messages["palette.failed"]
              : result.status === "queued"
                ? messages["palette.queued"]
                : messages["palette.completed"],
          );
        }
      } catch {
        if (controller.signal.aborted) return;
        const result: ActionResultV1 = {
          status: "failed",
          errorCode: "palette-executor-failed",
          messageKey: "atlcli.action.error.executor-failed",
          retryable: true,
        };
        lifecycle?.onResult?.(request.actionId, result);
        dispatch({ type: "result", actionId: request.actionId, result });
        setAnnouncement(messages["palette.failed"]);
      } finally {
        if (inFlightRef.current === controller) inFlightRef.current = null;
      }
    },
    [executor, lifecycle, messages],
  );

  const runActionId = useCallback(
    (actionId: string, input?: ActionInputValuesV1, title = actionId): void => {
      void runRequest(
        {
          schemaVersion: 1,
          actionId,
          locale: catalog.context.locale,
          ...(input ? { input } : {}),
        },
        title,
      );
    },
    [catalog.context.locale, runRequest],
  );

  const activateEntry = useCallback(
    (entry: ActionCatalogEntryV1): void => {
      if (!entry.availability.available) {
        setAnnouncement(
          entry.availability.reasons.map((reason) => resolveText(reason.message)).join(" "),
        );
        return;
      }
      if (entry.action.input) {
        dispatch({
          type: "input",
          actionId: entry.action.id,
          schema: entry.action.input,
        });
        return;
      }
      runActionId(entry.action.id, undefined, resolveText(entry.action.title));
    },
    [resolveText, runActionId],
  );

  const backToRoot = useCallback((): void => {
    dispatch({ type: "back", results });
    setAnnouncement(resultCountText);
    queueMicrotask(() => searchRef.current?.focus({ preventScroll: true }));
  }, [resultCountText, results]);

  if (!open) return null;

  const selectedCatalogEntry =
    catalog.actionsById[
      state.screen.kind === "root" ? state.selection.activeActionId ?? "" : state.screen.actionId
    ];
  const selectedTitle = selectedCatalogEntry
    ? resolveText(selectedCatalogEntry.action.title)
    : state.screen.kind === "root"
      ? ""
      : executionTitleRef.current;
  const panelItems: readonly ActionPanelItem[] =
    state.screen.kind === "action-panel" && selectedCatalogEntry
      ? (selectedCatalogEntry.action.secondaryActions ?? []).map((action) => {
          const availability =
            action.availability ??
            evaluateActionRequirementsV1(action.requirements, catalog.context);
          return {
            action,
            available: availability.available,
            ...(availability.available
              ? {}
              : {
                  reason: availability.reasons
                    .map((reason) => resolveText(reason.message))
                    .join(" "),
                }),
          };
        })
      : [];
  const resultActionItems: readonly ActionPanelItem[] =
    state.screen.kind === "result" && "actions" in state.screen.result
      ? (state.screen.result.actions ?? []).map((action) => {
          const availability =
            action.availability ??
            evaluateActionRequirementsV1(action.requirements, catalog.context);
          return {
            action,
            available: availability.available,
            ...(availability.available
              ? {}
              : {
                  reason: availability.reasons
                    .map((reason) => resolveText(reason.message))
                    .join(" "),
                }),
          };
        })
      : [];

  const content = (
    <div
      className={`atlcli-action-palette-layer${className ? ` ${className}` : ""}`}
      data-testid="action-palette"
    >
      <button
        type="button"
        className="atlcli-action-palette-backdrop"
        aria-label={messages["palette.close"]}
        onClick={requestClose}
      />
      <div
        ref={rootRef}
        className="atlcli-action-palette-frame"
        role="dialog"
        aria-modal="true"
        aria-labelledby={dialogTitleId}
        tabIndex={-1}
        onKeyDownCapture={trapTabKey}
      >
        <h1 id={dialogTitleId} className="atlcli-action-palette-sr-only">
          {messages["palette.dialog.label"]}
        </h1>
        {state.screen.kind === "root" ? (
          <>
            <header className="atlcli-action-palette-search-row">
              <label htmlFor={`${listboxId}-search`} className="atlcli-action-palette-sr-only">
                {messages["palette.search.label"]}
              </label>
              <span className="atlcli-action-palette-search-mark" aria-hidden="true">⌕</span>
              <input
                ref={searchRef}
                id={`${listboxId}-search`}
                data-testid="palette-search"
                role="combobox"
                type="search"
                autoComplete="off"
                spellCheck="false"
                aria-autocomplete="list"
                aria-expanded="true"
                aria-controls={listboxId}
                aria-activedescendant={activeOptionId}
                placeholder={messages["palette.search.placeholder"]}
                value={state.query}
                onChange={(event) => {
                  const query = event.currentTarget.value;
                  const nextResults = searchActionCatalog(catalog, query, {
                    aliases,
                    locale: catalog.context.locale,
                  });
                  dispatch({ type: "query", query, results: nextResults });
                  setAnnouncement(
                    formatActionPaletteMessageV1(messages["palette.results.count"], {
                      count: nextResults.length,
                    }),
                  );
                }}
                onKeyDown={(event) => {
                  if (isCompositionEvent(event)) return;
                  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                    event.preventDefault();
                    const move =
                      event.key === "ArrowDown"
                        ? "next"
                        : event.key === "ArrowUp"
                          ? "previous"
                          : event.key === "Home"
                            ? "first"
                            : "last";
                    dispatch({ type: "move", move, results });
                  } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    if (activeEntry) {
                      dispatch({ type: "action-panel", actionId: activeEntry.action.id });
                    }
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    if (activeEntry) activateEntry(activeEntry);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    if (state.query !== "") {
                      const defaultResults = searchActionCatalog(catalog, "", {
                        aliases,
                        locale: catalog.context.locale,
                      });
                      dispatch({ type: "query", query: "", results: defaultResults });
                    } else {
                      requestClose();
                    }
                  }
                }}
              />
              {contextLabel ? (
                <span className="atlcli-action-palette-context" title={contextLabel}>
                  {contextLabel}
                </span>
              ) : null}
              <button
                type="button"
                className="atlcli-action-palette-close"
                data-testid="palette-close"
                aria-label={messages["palette.close"]}
                onClick={requestClose}
              >
                <span aria-hidden="true">×</span>
              </button>
            </header>
            <main className="atlcli-action-palette-main" data-testid="palette-results-region" tabIndex={0}>
              {results.length === 0 ? (
                <div
                  id={listboxId}
                  className="atlcli-action-palette-empty"
                  data-testid="palette-empty"
                  role="listbox"
                  aria-label={messages["palette.search.label"]}
                >
                  <div role="option" aria-disabled="true" aria-selected="false">
                    <h2>{messages["palette.results.empty.title"]}</h2>
                    <p>{messages["palette.results.empty.hint"]}</p>
                  </div>
                </div>
              ) : (
                <RootList
                  results={results}
                  activeActionId={state.selection.activeActionId}
                  listboxId={listboxId}
                  listboxLabel={messages["palette.search.label"]}
                  resolveText={resolveText}
                  resolveIcon={resolveIcon}
                  messages={messages}
                  onSelect={(actionId) => dispatch({ type: "select", actionId, results })}
                  onActivate={activateEntry}
                />
              )}
            </main>
            <footer className="atlcli-action-palette-footer" aria-hidden="true">
              {footerLeading ? (
                <span className="atlcli-action-palette-footer-leading" data-testid="palette-footer-leading">
                  {footerLeading}
                </span>
              ) : null}
              <span><kbd>Esc</kbd> {messages["palette.close"]}</span>
              <span><kbd>↵</kbd> {messages["palette.run"]}</span>
              <span><kbd>⌘↵</kbd> {messages["palette.open-actions"]}</span>
            </footer>
          </>
        ) : state.screen.kind === "action-panel" ? (
          <ActionPanel
            title={selectedTitle}
            items={panelItems}
            messages={messages}
            resolveText={resolveText}
            onBack={backToRoot}
            onRun={(action) => runActionId(action.id, undefined, resolveText(action.title))}
          />
        ) : state.screen.kind === "input" ? (
          <InputForm
            title={selectedTitle}
            contextLabel={contextLabel}
            schema={state.screen.schema}
            values={state.screen.values}
            errors={state.screen.errors}
            messages={messages}
            resolveText={resolveText}
            onValues={(values) => dispatch({ type: "input-values", values })}
            onBack={backToRoot}
            onSubmit={(form) => {
              const errors = validateActionPaletteInputV1(
                state.screen.kind === "input" ? state.screen.schema : ({} as never),
                state.screen.kind === "input" ? state.screen.values : {},
              );
              if (Object.keys(errors).length > 0) {
                dispatch({ type: "input-errors", errors });
                const firstInvalid = form.querySelector<HTMLElement>("[aria-invalid='true']");
                queueMicrotask(() => firstInvalid?.focus());
                return;
              }
              if (state.screen.kind === "input") {
                runActionId(state.screen.actionId, state.screen.values, selectedTitle);
              }
            }}
          />
        ) : state.screen.kind === "executing" ? (
          <ExecutingView
            title={formatActionPaletteMessageV1(messages["palette.executing"], {
              action: selectedTitle,
            })}
            streamText={state.screen.streamText}
            closeLabel={messages["palette.close"]}
            cancelLabel={messages["palette.cancel"]}
            onClose={requestClose}
            onCancel={executor.cancel && lastRequestRef.current
              ? () => {
                  const active = lastRequestRef.current;
                  if (!active) return;
                  void executor.cancel?.(active.request).finally(() => requestClose());
                }
              : undefined}
          />
        ) : (
          <ResultView
            actionTitle={selectedTitle}
            result={state.screen.result}
            messages={messages}
            resolveText={resolveText}
            resolveResultText={resolveResultText}
            onBack={backToRoot}
            onRetry={() => {
              if (lastRequestRef.current) {
                void runRequest(
                  lastRequestRef.current.request,
                  lastRequestRef.current.title,
                );
              }
            }}
            onRunAffordance={(action) =>
              runActionId(action.id, undefined, resolveText(action.title))
            }
            actionItems={resultActionItems}
          />
        )}
        <div className="atlcli-action-palette-sr-only" role="status" aria-live="polite" aria-atomic="true">
          {liveText}
        </div>
      </div>
    </div>
  );

  return (
    <ActionPaletteErrorBoundaryV1 messages={messages} onClose={requestClose}>
      {content}
    </ActionPaletteErrorBoundaryV1>
  );
}

export function ActionPaletteV1(props: ActionPalettePropsV1): ReactNode {
  const content = <ActionPaletteContentV1 {...props} />;
  return props.portalTarget ? createPortal(content, props.portalTarget) : content;
}
