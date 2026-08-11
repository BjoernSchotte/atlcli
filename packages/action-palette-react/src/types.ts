import type { ReactNode } from "react";
import type {
  ActionCatalogEntryV1,
  ActionCatalogV1,
  ActionIconTokenV1,
  ActionInputValuesV1,
  ActionResultV1,
  ActionTextV1,
} from "@atlcli/action-registry";
import type { ActionPaletteMessagesV1 } from "./messages.js";

export interface ActionPaletteExecuteRequestV1 {
  readonly schemaVersion: 1;
  readonly actionId: string;
  readonly locale: string;
  readonly input?: ActionInputValuesV1;
}

export interface ActionPaletteExecutorV1 {
  execute(
    request: ActionPaletteExecuteRequestV1,
    signal: AbortSignal,
    onStream?: (event: ActionPaletteExecutionStreamV1) => void,
  ): Promise<ActionResultV1>;
  cancel?(request: ActionPaletteExecuteRequestV1): Promise<void>;
}

export interface ActionPaletteExecutionStreamV1 {
  readonly sequence: number;
  readonly status: "started" | "delta" | "reset" | "completed";
  readonly delta?: string;
}

export interface ActionPaletteLifecycleV1 {
  readonly onOpened?: () => void;
  readonly onCloseRequested?: () => void;
  readonly onResult?: (
    actionId: string,
    result: ActionResultV1,
  ) => void;
  readonly onStateChanged?: (state: ActionPalettePublicStateV1) => void;
}

export type ActionPalettePublicPhaseV1 =
  | "closed"
  | "root"
  | "action-panel"
  | "input"
  | "executing"
  | "queued"
  | "completed"
  | "failed";

export interface ActionPalettePublicStateV1 {
  readonly phase: ActionPalettePublicPhaseV1;
  readonly query: string;
  readonly activeActionId: string | null;
}

export type ActionPaletteTextResolverV1 = (text: ActionTextV1) => string;
export type ActionPaletteResultTextResolverV1 = (
  messageKey: string,
  fallback: string,
) => string;
export type ActionPaletteIconResolverV1 = (
  token: ActionIconTokenV1,
  action: ActionCatalogEntryV1,
) => ReactNode;

export interface ActionPalettePropsV1 {
  readonly open: boolean;
  readonly catalog: ActionCatalogV1;
  readonly executor: ActionPaletteExecutorV1;
  readonly portalTarget?: Element | DocumentFragment;
  readonly contextLabel?: string;
  /** Optional host-owned status placed at the leading edge of the footer. */
  readonly footerLeading?: ReactNode;
  readonly aliases?: Readonly<Record<string, readonly string[]>>;
  readonly messages?: Partial<ActionPaletteMessagesV1>;
  readonly resolveText?: ActionPaletteTextResolverV1;
  readonly resolveResultText?: ActionPaletteResultTextResolverV1;
  readonly resolveIcon?: ActionPaletteIconResolverV1;
  readonly lifecycle?: ActionPaletteLifecycleV1;
  readonly className?: string;
}
