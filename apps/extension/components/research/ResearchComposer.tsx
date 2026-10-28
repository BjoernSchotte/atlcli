/**
 * The Kiteweave AI composer (sidebar redesign, 2026-10).
 *
 * Presentation only: every submit/stop/steer decision is a callback owned by
 * `ResearchScreen`, which also owns the question state so suggestion buttons
 * and queued follow-ups keep working unchanged. What changed versus the old
 * inline JSX:
 *
 *  - the current-page context renders as a compact chip *inside* the shell,
 *    where the prototype puts it;
 *  - the bottom bar wraps (`flex-wrap`) and the thinking select sizes itself,
 *    so the mode toggle and the model picker can never overlap at 400 px;
 *  - the LLM disclosure is confirmed once: after a persisted confirmation the
 *    two-line checkbox becomes a one-line status with a "Change" action
 *    (`research-disclosure-status` / `research-disclosure-change`).
 */
import React, { useState } from "react";
import {
  ArrowUp,
  FileText,
  MessageCircle,
  Plus,
  ShieldCheck,
  Square,
  Telescope,
  X,
} from "lucide-react";
import type { ChatThinkingModeV1 } from "../../utils/research/contracts.js";
import { useT } from "../../utils/i18n/context.js";
import { Button } from "../ui/button.js";
import { Select } from "../ui/field.js";
import { cn } from "../ui/utils.js";
import type { ResearchInteractionMode } from "./model.js";

export interface ResearchComposerProps {
  question: string;
  onQuestionChange: (value: string) => void;
  /** Send the message (Enter, send button). The screen clears nothing itself. */
  onSubmit: (value: string) => void;
  /** Immediate steering while a run is live (Cmd+Shift+Enter). */
  onSteer: (value: string) => void;
  /** Stop the active run (send button while running). */
  onStop: () => void;
  running: boolean;
  interactionMode: ResearchInteractionMode;
  onInteractionModeChange: (mode: ResearchInteractionMode) => void;
  chatThinkingMode: ChatThinkingModeV1;
  onChatThinkingModeChange: (mode: ChatThinkingModeV1) => void;
  /** The attached current-page context, or `null` when removed/absent. */
  contextLabel: string | null;
  onRemoveContext: () => void;
  disclosed: boolean;
  /** A persisted one-time confirmation exists: show the status line. */
  disclosureConfirmed: boolean;
  disclosureLocked: boolean;
  onDisclosedChange: (next: boolean) => void;
  /** "Change" on the confirmed status line: withdraw the stored confirmation. */
  onDisclosureReset: () => void;
}

export function ResearchComposer({
  question,
  onQuestionChange,
  onSubmit,
  onSteer,
  onStop,
  running,
  interactionMode,
  onInteractionModeChange,
  chatThinkingMode,
  onChatThinkingModeChange,
  contextLabel,
  onRemoveContext,
  disclosed,
  disclosureConfirmed,
  disclosureLocked,
  onDisclosedChange,
  onDisclosureReset,
}: ResearchComposerProps): React.JSX.Element {
  const t = useT();
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  function send(value: string): void {
    onQuestionChange("");
    onSubmit(value);
  }

  function modeButton(mode: ResearchInteractionMode, icon: React.ReactNode, label: string): React.JSX.Element {
    return (
      <button
        type="button"
        className={cn(
          "inline-flex min-h-6 items-center gap-1 rounded px-1.5 text-xs font-medium transition-colors",
          interactionMode === mode
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
        aria-pressed={interactionMode === mode}
        onClick={() => onInteractionModeChange(mode)}
        data-testid={`research-mode-${mode}`}
      >
        {icon}
        {label}
      </button>
    );
  }

  return (
    <div data-copilotkit="true" className="w-full shrink-0" data-testid="research-chat-composer">
      <div
        className="overflow-visible rounded-lg border border-input bg-card transition-colors focus-within:border-ring"
        data-testid="research-chat-composer-shell"
      >
        {contextLabel !== null && (
          <div className="flex flex-wrap gap-1 px-2.5 pt-2" data-testid="research-context-chips">
            <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded border border-border/70 bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              <FileText className="size-3 shrink-0" aria-hidden="true" />
              <span className="shrink-0 font-medium">{t("research.chat.context")}</span>
              <span className="min-w-0 truncate font-medium text-foreground" title={contextLabel}>
                {contextLabel}
              </span>
              <button
                type="button"
                className="grid size-4 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground"
                aria-label={t("research.chat.context.remove")}
                onClick={onRemoveContext}
                data-testid="research-current-context-remove"
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </span>
          </div>
        )}

        <textarea
          data-testid="copilot-chat-textarea"
          value={question}
          onChange={(event) => onQuestionChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            const value = event.currentTarget.value;
            if (event.metaKey && event.shiftKey) {
              event.preventDefault();
              onQuestionChange("");
              onSteer(value);
              return;
            }
            if (!event.shiftKey) {
              event.preventDefault();
              send(value);
            }
          }}
          placeholder={t("research.chat.placeholder")}
          className="min-h-16 w-full resize-none border-0 bg-transparent px-3 pb-1.5 pt-2.5 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground focus-visible:outline-none"
          aria-label={t("research.chat.placeholder")}
        />

        {/* Wrapping bar: the thinking select sizes itself and may drop to the
            next line, so nothing can overlap in the 400 px panel. */}
        <div className="flex flex-wrap items-center gap-1 border-t border-border/70 px-2 py-1.5">
          <div className="relative">
            {addMenuOpen && (
              <div
                role="region"
                aria-label={t("research.chat.addMenu.label")}
                className="absolute bottom-full left-0 z-30 mb-2 w-64 rounded-md border bg-popover p-3 text-sm text-muted-foreground shadow-lg"
                data-testid="research-composer-add-menu"
              >
                <p className="m-0">{t("research.chat.addMenu.empty")}</p>
              </div>
            )}
            <Button
              size="icon"
              variant={addMenuOpen ? "outline" : "ghost"}
              className="size-7 rounded-md"
              aria-label={t(addMenuOpen ? "research.chat.addMenu.close" : "research.chat.addMenu.open")}
              aria-expanded={addMenuOpen}
              data-testid="research-composer-add-menu-toggle"
              onClick={() => setAddMenuOpen((open) => !open)}
            >
              {addMenuOpen
                ? <X className="size-3.5" aria-hidden="true" />
                : <Plus className="size-3.5" aria-hidden="true" />}
            </Button>
          </div>

          <div
            className="flex min-w-0 shrink-0 items-center rounded-md bg-muted p-0.5"
            role="group"
            aria-label={t("research.chat.mode.label")}
          >
            {modeButton("chat", <MessageCircle className="size-3" aria-hidden="true" />, t("research.chat.mode.chat"))}
            {modeButton("deep", <Telescope className="size-3" aria-hidden="true" />, t("research.chat.mode.deepShort"))}
          </div>

          {interactionMode === "chat" && (
            <Select
              value={chatThinkingMode}
              onChange={(event) => onChatThinkingModeChange(event.target.value as ChatThinkingModeV1)}
              disabled={running}
              aria-label={t("research.chat.thinking.label")}
              title={t("research.chat.thinking.label")}
              className="h-7 w-auto min-w-0 max-w-[8.5rem] rounded-md border-0 bg-transparent px-1 text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="research-chat-thinking"
            >
              <option value="auto">{t("research.chat.thinking.auto")}</option>
              <option value="quick">{t("research.chat.thinking.quick")}</option>
              <option value="deep">{t("research.chat.thinking.deep")}</option>
            </Select>
          )}

          <div className="ml-auto">
            <Button
              size="icon"
              className={cn(
                "size-7 shrink-0 rounded-md text-primary-foreground disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100",
                running
                  ? "bg-destructive hover:bg-destructive/90"
                  : "bg-primary hover:bg-primary/90",
              )}
              aria-label={running ? t("research.stop") : interactionMode === "chat" ? t("research.chat.send") : t("research.run")}
              title={running ? t("research.stop") : interactionMode === "chat" ? t("research.chat.send") : t("research.run")}
              data-testid="research-run"
              disabled={running ? false : question.trim().length === 0}
              onClick={() => {
                if (running) {
                  onStop();
                  return;
                }
                send(question);
              }}
            >
              {running
                ? <Square className="size-3 fill-current" aria-hidden="true" />
                : <ArrowUp className="size-3.5" aria-hidden="true" />}
            </Button>
          </div>
        </div>

        {disclosureConfirmed && disclosed ? (
          <div
            className="flex items-center gap-2 border-t border-border/60 px-3 py-1.5 text-[11px] leading-4 text-muted-foreground"
            data-testid="research-disclosure-status"
          >
            <ShieldCheck className="size-3.5 shrink-0 text-success" aria-hidden="true" />
            <span className="min-w-0 flex-1">{t("research.disclosure.confirmed")}</span>
            <button
              type="button"
              className="shrink-0 font-medium text-primary hover:underline disabled:opacity-50"
              onClick={onDisclosureReset}
              disabled={disclosureLocked}
              data-testid="research-disclosure-change"
            >
              {t("research.disclosure.change")}
            </button>
          </div>
        ) : (
          <label className="flex cursor-pointer items-start gap-2 border-t border-border/60 px-3 py-2 text-[11px] leading-4 text-muted-foreground">
            <input
              type="checkbox"
              className="mt-px size-3.5 shrink-0 rounded border-input accent-primary"
              checked={disclosed}
              onChange={(event) => onDisclosedChange(event.target.checked)}
              disabled={disclosureLocked}
              data-testid="research-disclosure"
            />
            <span>{t("research.disclosure")}</span>
          </label>
        )}
      </div>
    </div>
  );
}
