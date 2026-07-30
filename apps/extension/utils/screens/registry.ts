/**
 * Screen registry (spec 010 Phase 0 — the actual deliverable).
 *
 * The rule this enforces: **adding a screen is a registry entry, never an edit
 * to the shell.** A screen declares its `id`, its i18n label key, its icon, its
 * component and its *requirements*; the navigation is computed from the list.
 * A screen whose requirements are unmet is hidden or disabled **with a reason**
 * — never silently broken, and never a button that throws when clicked.
 *
 * It is also the portability seam that matters most: *screens are portable
 * units, the shell that arranges them is host code.* The extension arranges
 * them as a sidebar with a "Sections" nav; per `PRODUCT-SHAPE.md` a Forge host
 * has no sidebar at all and mounts a subset — likely only Export — inside a
 * content-action modal. Same screens, different shell. T5.3's preview is the
 * first real test of that: the inline preview and the large-preview tab page
 * are the *same* screen mounted by two shells, not two implementations.
 *
 * Everything in this module is pure: no React, no DOM, no ports at runtime.
 */
import type { ComponentType } from "react";
import type { MessageKey } from "../i18n/messages.js";
import type { AppPorts, HostCapability } from "../ports/index.js";
import type { PanelState } from "../panel-state.js";

/** Props every screen component receives. */
export interface ScreenProps {
  ports: AppPorts;
  /**
   * The page-context state machine's current value. Screens that can work
   * without a page (Settings, About) ignore it; screens that need one render
   * their own empty/loading/error state from it rather than being unmounted.
   */
  page: PanelState;
  /** Re-run the current page load (Retry / Reload). */
  retry: () => void;
  /** Move to another registered screen. */
  navigate: (id: string) => void;
}

/**
 * Minimal icon contract — structurally satisfied by every `lucide-react` icon
 * and by a plain test stub, so the registry does not drag the icon library into
 * modules that only reason about screens.
 */
export type ScreenIcon = ComponentType<{
  className?: string;
  size?: number | string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

/** What a screen needs in order to be usable. */
export type ScreenRequirement =
  /** A Confluence page must be loaded. */
  | { kind: "loaded-page" }
  /** The host must advertise a capability. */
  | { kind: "capability"; capability: HostCapability };

/** What to do when a requirement is unmet. Default: `"disable"`. */
export type UnmetBehavior = "disable" | "hide";

export interface ScreenDefinition {
  id: string;
  labelKey: MessageKey;
  descriptionKey?: MessageKey;
  icon: ScreenIcon;
  component: ComponentType<ScreenProps>;
  requirements?: readonly ScreenRequirement[];
  /**
   * `"disable"` keeps the entry visible and explains why it cannot be opened —
   * the honest default, because a silently missing nav item reads as a bug.
   * `"hide"` is for screens that would be nonsense in a host (a Forge shell
   * hiding anything extension-specific).
   */
  whenUnmet?: UnmetBehavior;
  /** Ascending sort key; ties keep registration order. */
  order?: number;
  /** Placement in a scalable product shell. Defaults to the area's primary nav. */
  navigation?: "primary" | "utility" | "hidden";
}

/** What the shell knows about the world when it resolves the registry. */
export interface ScreenEnvironment {
  hasLoadedPage: boolean;
  capabilities: readonly HostCapability[];
}

export interface ResolvedScreen {
  definition: ScreenDefinition;
  /** Can be opened. */
  available: boolean;
  /** Appears in the navigation (an unavailable screen may still be visible). */
  visible: boolean;
  /** Why it is unavailable — an i18n key, so the shell renders it translated. */
  reasonKey: MessageKey | null;
  /** Every requirement that failed, in declaration order. */
  unmet: readonly ScreenRequirement[];
}

/** Per-capability explanations, so "not available" is never unexplained. */
const CAPABILITY_REASON_KEYS: Record<HostCapability, MessageKey> = {
  "pdf-export": "screen.unmet.capability.pdfExport",
  "docx-export": "screen.unmet.capability.docxExport",
  "docx-template-store": "screen.unmet.capability.docxTemplateStore",
  "template-library": "screen.unmet.capability.templateLibrary",
  "durable-jobs": "screen.unmet.capability.durableJobs",
  "pdf-preview": "screen.unmet.capability.pdfPreview",
  research: "screen.unmet.capability.research",
  "settings-persistence": "screen.unmet.capability.settingsPersistence",
  "confluence-page-customization":
    "screen.unmet.capability.confluencePageCustomization",
};

/** The i18n key explaining a single unmet requirement. */
export function requirementReasonKey(requirement: ScreenRequirement): MessageKey {
  return requirement.kind === "loaded-page"
    ? "screen.unmet.page"
    : CAPABILITY_REASON_KEYS[requirement.capability];
}

function isMet(requirement: ScreenRequirement, env: ScreenEnvironment): boolean {
  return requirement.kind === "loaded-page"
    ? env.hasLoadedPage
    : env.capabilities.includes(requirement.capability);
}

/**
 * Resolve every screen against the environment.
 *
 * Pure and total: the result has one entry per definition, in nav order, so the
 * shell renders a list and never filters or branches on screen ids.
 */
export function resolveScreens(
  definitions: readonly ScreenDefinition[],
  env: ScreenEnvironment
): ResolvedScreen[] {
  return definitions
    .map((definition, index) => ({ definition, index }))
    .sort((a, b) => (a.definition.order ?? 0) - (b.definition.order ?? 0) || a.index - b.index)
    .map(({ definition }) => {
      const unmet = (definition.requirements ?? []).filter((r) => !isMet(r, env));
      const available = unmet.length === 0;
      const firstUnmet = unmet[0];
      return {
        definition,
        available,
        visible: available || (definition.whenUnmet ?? "disable") === "disable",
        reasonKey: firstUnmet ? requirementReasonKey(firstUnmet) : null,
        unmet,
      };
    });
}

/**
 * Choose which screen the shell should render.
 *
 * A requested screen that is visible wins even when it is unavailable — the
 * user asked for it, so they get the explanation rather than a silent redirect.
 * Otherwise: the first available screen, then the first visible one, then
 * nothing (an empty or fully hidden registry is a legal, if useless, host).
 */
export function pickActiveScreen(
  resolved: readonly ResolvedScreen[],
  requestedId: string | null
): ResolvedScreen | null {
  const requested = resolved.find((s) => s.definition.id === requestedId);
  if (requested?.visible) return requested;
  return resolved.find((s) => s.visible && s.available) ?? resolved.find((s) => s.visible) ?? null;
}
