/**
 * The side panel shell — **host code** (spec 010 Phase 0).
 *
 * It arranges screens; it does not know any of them. Every branch below reads
 * only `ResolvedScreen`, so a Forge host that mounts a single screen inside a
 * content-action modal replaces this file and nothing else
 * (`PRODUCT-SHAPE.md`: no sidebar in Forge).
 *
 * The product-area switcher is deliberately wider than today's Publishing
 * feature. Future areas are announced honestly as planned, while every screen
 * inside the active area still comes from the registry.
 */
import React, { useEffect, useId, useRef, useState } from "react";
import {
  ChevronDown,
  LockKeyhole,
  PanelsTopLeft,
  ShieldCheck,
  Sparkles,
  Workflow,
} from "lucide-react";
import { useT } from "../../utils/i18n/context.js";
import type { AppWorkspace } from "../../utils/ports/settings.js";
import type { ResolvedScreen, ScreenProps } from "../../utils/screens/registry.js";
import { Alert, AlertTitle } from "../ui/alert.js";
import { cn } from "../ui/utils.js";

/**
 * How much room the host gives this shell.
 *
 * `compact` is the 400 px side panel. `full` is a shell that owns a whole tab
 * and must use it. The width belongs to the shell, not to a portable screen.
 */
export type ShellLayout = "compact" | "full";

interface PlannedArea {
  id: "safe-ops" | "automations";
  labelKey: "area.safeOps" | "area.automations";
  descriptionKey: "area.safeOps.description" | "area.automations.description";
  icon: typeof ShieldCheck;
}

interface ActiveWorkspace {
  id: AppWorkspace;
  labelKey: "area.ai" | "area.publishing";
  descriptionKey: "area.ai.description" | "area.publishing.description";
  icon: typeof Sparkles;
}

const ACTIVE_WORKSPACES: readonly ActiveWorkspace[] = [
  {
    id: "ai",
    labelKey: "area.ai",
    descriptionKey: "area.ai.description",
    icon: Sparkles,
  },
  {
    id: "publishing",
    labelKey: "area.publishing",
    descriptionKey: "area.publishing.description",
    icon: PanelsTopLeft,
  },
];

const PLANNED_AREAS: readonly PlannedArea[] = [
  {
    id: "safe-ops",
    labelKey: "area.safeOps",
    descriptionKey: "area.safeOps.description",
    icon: ShieldCheck,
  },
  {
    id: "automations",
    labelKey: "area.automations",
    descriptionKey: "area.automations.description",
    icon: Workflow,
  },
];

export function AppShell({
  title,
  version,
  screens,
  active,
  activeWorkspace,
  onNavigate,
  onWorkspaceNavigate,
  screenProps,
  layout = "compact",
}: {
  title: string;
  version: string;
  screens: readonly ResolvedScreen[];
  active: ResolvedScreen | null;
  activeWorkspace: AppWorkspace;
  onNavigate: (id: string) => void;
  onWorkspaceNavigate: (workspace: AppWorkspace) => void;
  screenProps: ScreenProps;
  layout?: ShellLayout;
}): React.JSX.Element {
  const t = useT();
  const visible = screens.filter((screen) => screen.visible);
  const primary = visible.filter((screen) =>
    (screen.definition.navigation ?? "primary") === "primary"
    && (screen.definition.workspace ?? "publishing") === activeWorkspace
  );
  const utility = visible.filter((screen) => screen.definition.navigation === "utility");
  const activeWorkspaceDefinition = ACTIVE_WORKSPACES.find(
    (workspace) => workspace.id === activeWorkspace,
  )!;
  const [menuOpen, setMenuOpen] = useState(false);
  const [plannedMessage, setPlannedMessage] = useState<string | null>(null);
  const switcherRef = useRef<HTMLButtonElement | null>(null);
  const menuItemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const menuId = useId();
  const site = siteLabel(screenProps.page);
  const activePrimary = primary.findIndex(
    (screen) => screen.definition.id === active?.definition.id
  );
  const firstAvailablePrimary = primary.findIndex((screen) => screen.available);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const menu = document.getElementById(menuId);
      if (!menu?.contains(target) && !switcherRef.current?.contains(target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menuId, menuOpen]);

  function closeMenu(restoreFocus = false): void {
    setMenuOpen(false);
    if (restoreFocus) switcherRef.current?.focus();
  }

  function openMenu(focus: "first" | "last" = "first"): void {
    setMenuOpen(true);
    queueMicrotask(() => {
      const items = menuItemRefs.current.filter(
        (item): item is HTMLButtonElement => item !== null
      );
      (focus === "last" ? items.at(-1) : items[0])?.focus();
    });
  }

  function onSwitcherKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openMenu("first");
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openMenu("last");
    } else if (event.key === "Escape" && menuOpen) {
      event.preventDefault();
      closeMenu(true);
    }
  }

  function onMenuKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
    const items = menuItemRefs.current.filter(
      (item): item is HTMLButtonElement => item !== null
    );
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (event.key === "ArrowDown") next = current < items.length - 1 ? current + 1 : 0;
    else if (event.key === "ArrowUp") next = current > 0 ? current - 1 : items.length - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
      return;
    } else if (event.key === "Tab") {
      setMenuOpen(false);
      return;
    }
    if (next !== null) {
      event.preventDefault();
      items[next]?.focus();
    }
  }

  function onTabKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
    currentIndex: number
  ): void {
    const available = primary
      .map((screen, index) => ({ screen, index }))
      .filter(({ screen }) => screen.available);
    const position = available.findIndex(({ index }) => index === currentIndex);
    if (position < 0 || available.length === 0) return;
    let nextPosition: number | null = null;
    if (event.key === "ArrowRight") {
      nextPosition = (position + 1) % available.length;
    } else if (event.key === "ArrowLeft") {
      nextPosition = (position - 1 + available.length) % available.length;
    } else if (event.key === "Home") {
      nextPosition = 0;
    } else if (event.key === "End") {
      nextPosition = available.length - 1;
    }
    if (nextPosition === null) return;
    event.preventDefault();
    const next = available[nextPosition]!.screen;
    onNavigate(next.definition.id);
    tabRefs.current[next.definition.id]?.focus();
  }

  function primaryTab(screen: ResolvedScreen, index: number): React.JSX.Element {
    const label = t(screen.definition.labelKey);
    const Icon = screen.definition.icon;
    const isActive = active?.definition.id === screen.definition.id;
    const inRovingOrder =
      isActive || (activePrimary < 0 && index === firstAvailablePrimary);
    return (
      <button
        ref={(node) => {
          tabRefs.current[screen.definition.id] = node;
        }}
        type="button"
        role="tab"
        id={`screen-tab-${screen.definition.id}`}
        aria-controls={`screen-panel-${screen.definition.id}`}
        aria-selected={isActive}
        aria-disabled={!screen.available}
        tabIndex={screen.available && inRovingOrder ? 0 : -1}
        data-testid={`nav-${screen.definition.id}`}
        data-active={isActive ? "true" : undefined}
        disabled={!screen.available}
        title={
          screen.available
            ? t("nav.openSection", { label })
            : t(screen.reasonKey ?? "screen.unavailable.title")
        }
        onClick={() => {
          setPlannedMessage(null);
          onNavigate(screen.definition.id);
        }}
        onKeyDown={(event) => onTabKeyDown(event, index)}
        className={cn(
          "screen-tab relative grid min-h-14 min-w-0 flex-1 place-items-center content-center gap-1",
          "border-0 bg-transparent px-1.5 py-1.5 text-xs font-semibold text-muted-foreground",
          "transition-colors after:absolute after:inset-x-3 after:-bottom-px after:h-0.5 after:rounded-t",
          "after:bg-transparent hover:bg-muted hover:text-foreground",
          "disabled:cursor-not-allowed disabled:opacity-45",
          isActive && "text-primary after:bg-primary"
        )}
      >
        <Icon size={18} aria-hidden="true" />
        <span className="publishing-nav-label max-w-full truncate">{label}</span>
      </button>
    );
  }

  function utilityMenuItem(screen: ResolvedScreen, index: number): React.JSX.Element {
    const label = t(screen.definition.labelKey);
    const Icon = screen.definition.icon;
    const isActive = active?.definition.id === screen.definition.id;
    return (
      <button
        ref={(node) => {
          menuItemRefs.current[index] = node;
        }}
        type="button"
        role="menuitem"
        data-testid={`nav-${screen.definition.id}`}
        aria-current={isActive ? "page" : undefined}
        disabled={!screen.available}
        title={
          screen.available
            ? t("nav.openSection", { label })
            : t(screen.reasonKey ?? "screen.unavailable.title")
        }
        onClick={() => {
          setPlannedMessage(null);
          onNavigate(screen.definition.id);
          closeMenu();
        }}
        className={cn(
          "flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs font-semibold",
          "text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50",
          isActive && "bg-accent text-primary"
        )}
      >
        <Icon size={17} aria-hidden="true" />
        <span>{label}</span>
      </button>
    );
  }

  const activeIsPrimary = activePrimary >= 0;
  const showsPrimaryNav = activeWorkspace === "publishing" || primary.length > 1;

  return (
    <main
      data-testid="app-shell"
      data-layout={layout}
      className={cn(
        "mx-auto box-border flex flex-col bg-background text-foreground",
        layout === "compact"
          ? "min-h-dvh max-w-[400px]"
          : "h-dvh max-w-none overflow-hidden"
      )}
    >
      {layout === "compact" && (
        <>
          <header className="relative z-20 flex min-h-[62px] items-center gap-2 border-b bg-background px-3 py-2">
            <span className="sr-only" data-testid="app-version">
              {t("app.version", { version })}
            </span>
            <img
              className="size-10 shrink-0 object-contain"
              src="/kiteweave-icon.svg"
              alt={t("brand.kiteweave")}
              data-testid="kiteweave-brand"
            />
            <button
              ref={switcherRef}
              type="button"
              className="grid min-h-11 min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg border-0 bg-transparent px-2 text-left hover:bg-muted"
              aria-label={t("nav.openProductAreas")}
              aria-haspopup="menu"
              aria-controls={menuId}
              aria-expanded={menuOpen}
              onClick={() => (menuOpen ? closeMenu() : openMenu())}
              onKeyDown={onSwitcherKeyDown}
              data-testid="area-menu-toggle"
            >
              <span className="grid min-w-0 gap-px">
                <strong className="truncate text-sm font-bold tracking-[-0.015em]">
                  {t(activeWorkspaceDefinition.labelKey)}
                </strong>
                <span className="truncate text-xs font-medium text-muted-foreground">
                  {t("brand.browser")}
                </span>
              </span>
              <ChevronDown
                size={17}
                className={cn("text-muted-foreground transition-transform", menuOpen && "rotate-180")}
                aria-hidden="true"
              />
            </button>

            <section
              id={menuId}
              hidden={!menuOpen}
              style={!menuOpen ? { display: "none" } : undefined}
              role="menu"
              aria-label={t("nav.productAreas")}
              onKeyDown={onMenuKeyDown}
              className="absolute inset-x-2.5 top-[calc(100%+6px)] z-30 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-xl"
              data-testid="area-menu"
            >
              <div className="flex items-center justify-between gap-3 px-3.5 pb-2 pt-3">
                <strong className="font-serif text-base font-semibold tracking-[-0.025em]">
                  {t("area.choose")}
                </strong>
                <span className="text-xs font-bold uppercase tracking-[0.09em] text-muted-foreground">
                  {t("brand.browser")}
                </span>
              </div>
              <div className="grid gap-0.5 px-1.5 pb-2">
                {ACTIVE_WORKSPACES.map((workspace, index) => {
                  const Icon = workspace.icon;
                  const isActive = workspace.id === activeWorkspace;
                  return (
                    <button
                      key={workspace.id}
                      ref={(node) => {
                        menuItemRefs.current[index] = node;
                      }}
                      type="button"
                      role="menuitem"
                      aria-current={isActive ? "page" : undefined}
                      data-testid={`area-${workspace.id}`}
                      onClick={() => {
                        setPlannedMessage(null);
                        // A utility screen such as Settings does not belong to
                        // either workspace. Re-selecting the visually active
                        // workspace must therefore return to its first screen,
                        // even though the workspace id itself did not change.
                        onWorkspaceNavigate(workspace.id);
                        closeMenu(true);
                      }}
                      className={cn(
                        "grid min-h-[58px] w-full grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg border-0 px-2 text-left",
                        isActive ? "bg-accent" : "bg-transparent hover:bg-muted",
                      )}
                    >
                      <span className={cn(
                        "grid size-[34px] place-items-center rounded-lg border bg-background",
                        isActive ? "border-primary/25 text-primary" : "text-muted-foreground",
                      )}>
                        <Icon size={17} aria-hidden="true" />
                      </span>
                      <span className="grid min-w-0 gap-0.5">
                        <strong className="text-[13px] font-bold">{t(workspace.labelKey)}</strong>
                        <span className="truncate text-xs text-muted-foreground">
                          {t(workspace.descriptionKey)}
                        </span>
                      </span>
                      {isActive && (
                        <span className="rounded-full border border-primary/25 bg-background px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-primary">
                          {t("nav.active")}
                        </span>
                      )}
                    </button>
                  );
                })}

                {PLANNED_AREAS.map((area, index) => {
                  const Icon = area.icon;
                  const label = t(area.labelKey);
                  return (
                    <button
                      key={area.labelKey}
                      ref={(node) => {
                        menuItemRefs.current[index + ACTIVE_WORKSPACES.length] = node;
                      }}
                      type="button"
                      role="menuitem"
                      aria-disabled="true"
                      data-testid={`area-${area.id}`}
                      onClick={() => {
                        setPlannedMessage(t("area.planned", { area: label }));
                        closeMenu(true);
                      }}
                      className="grid min-h-[58px] w-full grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg border-0 bg-transparent px-2 text-left hover:bg-muted"
                    >
                      <span className="grid size-[34px] place-items-center rounded-lg border bg-background text-muted-foreground">
                        <Icon size={17} aria-hidden="true" />
                      </span>
                      <span className="grid min-w-0 gap-0.5">
                        <strong className="text-[13px] font-bold">{label}</strong>
                        <span className="truncate text-xs text-muted-foreground">
                          {t(area.descriptionKey)}
                        </span>
                      </span>
                      <span className="rounded-full border bg-background px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">
                        {t("area.soon")}
                      </span>
                    </button>
                  );
                })}

                {utility.length > 0 && (
                  <div className="mt-1 grid gap-0.5 border-t pt-1">
                    {utility.map((screen, index) => (
                      <React.Fragment key={screen.definition.id}>
                        {utilityMenuItem(
                          screen,
                          index + PLANNED_AREAS.length + ACTIVE_WORKSPACES.length,
                        )}
                      </React.Fragment>
                    ))}
                  </div>
                )}
              </div>
              <footer className="flex items-center justify-between gap-3 border-t bg-muted px-3.5 py-2 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <Sparkles size={14} aria-hidden="true" />
                  {t("area.moreComing")}
                </span>
                <span>{t("app.version", { version })}</span>
              </footer>
            </section>
          </header>

          {showsPrimaryNav && (
            <nav aria-label={t("nav.sections")} data-testid="app-nav" className="border-b bg-background">
              <div
                className="publishing-primary-nav flex"
                role="tablist"
                aria-label={t("nav.sections")}
              >
                {primary.map((screen, index) => (
                  <React.Fragment key={screen.definition.id}>
                    {primaryTab(screen, index)}
                  </React.Fragment>
                ))}
              </div>
            </nav>
          )}
        </>
      )}

      <section
        id={active ? `screen-panel-${active.definition.id}` : undefined}
        role={layout === "compact" && showsPrimaryNav && activeIsPrimary ? "tabpanel" : undefined}
        aria-labelledby={
          layout === "compact" && showsPrimaryNav && activeIsPrimary
            ? `screen-tab-${active?.definition.id}`
            : undefined
        }
        tabIndex={layout === "compact" && showsPrimaryNav && activeIsPrimary ? 0 : undefined}
        data-testid={active ? `screen-${active.definition.id}` : "screen-none"}
        className={
          layout === "full"
            ? "min-h-0 flex-1 overflow-hidden"
            : "min-h-0 flex-1 overflow-y-auto px-4 py-[18px]"
        }
      >
        {active === null ? null : active.available ? (
          <active.definition.component {...screenProps} />
        ) : (
          <Alert tone="muted" data-testid="screen-unavailable">
            <AlertTitle>{t("screen.unavailable.title")}</AlertTitle>
            <p className="m-0 mt-1">{t(active.reasonKey ?? "screen.unavailable.title")}</p>
          </Alert>
        )}
      </section>

      {layout === "compact" && (
        <>
          {plannedMessage && (
            <div
              className="mx-3 mb-2 flex min-h-11 items-center gap-2 rounded-lg border bg-popover px-3 text-xs font-semibold shadow-lg"
              role="status"
              aria-live="polite"
              data-testid="planned-area-status"
            >
              <Sparkles className="shrink-0 text-primary" size={16} aria-hidden="true" />
              <span>{plannedMessage}</span>
            </div>
          )}
          <footer className="mt-auto flex min-h-9 items-center justify-between gap-3 border-t bg-muted px-3 py-1.5 text-xs text-muted-foreground">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <LockKeyhole className="shrink-0 text-success" size={14} aria-hidden="true" />
              <span className="truncate">{site ?? title}</span>
            </span>
            <span className="shrink-0">{t(activeWorkspaceDefinition.labelKey)}</span>
          </footer>
        </>
      )}
    </main>
  );
}

function siteLabel(page: ScreenProps["page"] | undefined): string | null {
  if (!page) return null;
  const url =
    page.status === "loaded" || page.status === "loading" || page.status === "error"
      ? page.ref.url
      : page.status === "unsupported"
        ? page.url
        : null;
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
