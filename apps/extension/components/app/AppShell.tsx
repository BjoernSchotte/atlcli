/**
 * The side panel shell — **host code** (spec 010 Phase 0).
 *
 * It arranges screens; it does not know any of them. Every branch below reads
 * only `ResolvedScreen`, so a Forge host that mounts a single screen inside a
 * content-action modal replaces this file and nothing else
 * (`PRODUCT-SHAPE.md`: no sidebar in Forge). That is the whole point of the
 * registry — "no sidebar over there" is a different shell, not a rewrite.
 *
 * An unavailable screen is never silently broken: its nav entry is disabled and
 * carries the reason, and if it is somehow the active screen the body renders
 * the same reason instead of a component that would throw.
 */
import React, { useState } from "react";
import { ChevronDown, Layers3, Menu, X } from "lucide-react";
import { useT } from "../../utils/i18n/context.js";
import type { ResolvedScreen, ScreenProps } from "../../utils/screens/registry.js";
import { Alert, AlertTitle } from "../ui/alert.js";
import { cn } from "../ui/utils.js";

/**
 * How much room the host gives this shell.
 *
 * `compact` is the 400 px side panel. `full` is a shell that owns a whole tab
 * and must use it: the large-preview page mounted the *same* `AppShell` and so
 * inherited the panel's `max-w-[400px]`, which made a full tab render as a
 * narrow column with the page shrunk to panel size — the opposite of why the
 * large view exists.
 *
 * The width belongs to the shell, not to a screen: screens are portable units
 * and the shell that arranges them is host code.
 */
export type ShellLayout = "compact" | "full";

export function AppShell({
  title,
  version,
  screens,
  active,
  onNavigate,
  screenProps,
  layout = "compact",
}: {
  title: string;
  version: string;
  screens: readonly ResolvedScreen[];
  active: ResolvedScreen | null;
  onNavigate: (id: string) => void;
  screenProps: ScreenProps;
  layout?: ShellLayout;
}): React.JSX.Element {
  const t = useT();
  const visible = screens.filter((screen) => screen.visible);
  const primary = visible.filter(
    (screen) => (screen.definition.navigation ?? "primary") === "primary"
  );
  const utility = visible.filter((screen) => screen.definition.navigation === "utility");
  const [menuOpen, setMenuOpen] = useState(false);
  const site = siteLabel(screenProps.page);

  const navButton = (screen: ResolvedScreen, compact = false): React.JSX.Element => {
    const label = t(screen.definition.labelKey);
    const Icon = screen.definition.icon;
    const isActive = active?.definition.id === screen.definition.id;
    return (
      <button
        type="button"
        data-testid={`nav-${screen.definition.id}`}
        data-active={isActive ? "true" : undefined}
        aria-current={isActive ? "page" : undefined}
        disabled={!screen.available}
        title={
          screen.available
            ? t("nav.openSection", { label })
            : t(screen.reasonKey ?? "screen.unavailable.title")
        }
        onClick={() => {
          onNavigate(screen.definition.id);
          setMenuOpen(false);
        }}
        className={cn(
          "flex min-h-8 items-center gap-1.5 rounded-md px-2 text-xs font-semibold transition-colors",
          "disabled:cursor-not-allowed disabled:opacity-50",
          compact ? "w-full justify-start" : "flex-1 justify-center",
          isActive
            ? "bg-primary text-primary-foreground shadow-sm"
            : "text-foreground hover:bg-accent hover:text-accent-foreground"
        )}
      >
        <Icon size={17} aria-hidden="true" />
        <span className="publishing-nav-label">{label}</span>
      </button>
    );
  };

  return (
    <main
      data-testid="app-shell"
      data-layout={layout}
      className={cn(
        "mx-auto box-border flex flex-col",
        layout === "compact"
          ? "min-h-full max-w-[400px] bg-background"
          : "h-dvh max-w-none overflow-hidden"
      )}
    >
      {layout === "compact" && (
        <>
          <header className="relative flex min-h-12 items-center gap-2 border-b bg-accent/70 px-2">
            <span className="sr-only" data-testid="app-version">
              {t("app.version", { version })}
            </span>
            <button
              type="button"
              className="flex size-8 items-center justify-center rounded-md text-primary hover:bg-background/70 [&>svg]:size-5"
              aria-label={t("nav.openProductAreas")}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
              data-testid="area-menu-toggle"
            >
              {menuOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
            </button>
            <div className="flex size-8 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
              ak
            </div>
            <button
              type="button"
              className="flex min-h-8 min-w-0 items-center gap-1 rounded-md px-1 text-left text-sm font-semibold text-foreground"
              onClick={() => setMenuOpen((open) => !open)}
            >
              <span className="truncate">{t("area.publishing")}</span>
              <ChevronDown size={16} aria-hidden="true" />
            </button>

            <div
                hidden={!menuOpen}
                style={!menuOpen ? { display: "none" } : undefined}
                className="absolute inset-x-2 top-[calc(100%+4px)] z-30 rounded-lg border bg-popover p-1.5 shadow-lg"
                data-testid="area-menu"
              >
                <div className="mb-1 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
                  {t("nav.productAreas")}
                </div>
                <div className="flex min-h-9 items-center gap-2 rounded-md bg-accent px-2 text-xs font-semibold text-primary">
                  <Layers3 size={16} aria-hidden="true" />
                  {t("area.publishing")}
                  <span className="ml-auto text-[10px] font-bold uppercase">{t("nav.active")}</span>
                </div>
                {utility.length > 0 && <div className="my-2 border-t" />}
                {utility.map((screen) => (
                  <React.Fragment key={screen.definition.id}>{navButton(screen, true)}</React.Fragment>
                ))}
                <div className="mt-2 flex items-center justify-between border-t px-2 pt-2 text-[11px] text-muted-foreground">
                  <span>{title}</span>
                  <span>{t("app.version", { version })}</span>
                </div>
            </div>
          </header>

          <nav aria-label={t("nav.sections")} data-testid="app-nav" className="border-b px-2 py-1.5">
            <div className="publishing-primary-nav flex gap-0.5 rounded-lg bg-muted/70 p-0.5">
              {primary.map((screen) => (
                <React.Fragment key={screen.definition.id}>{navButton(screen)}</React.Fragment>
              ))}
            </div>
          </nav>
        </>
      )}

      <section
        data-testid={active ? `screen-${active.definition.id}` : "screen-none"}
        className={
          layout === "full"
            ? "min-h-0 flex-1 overflow-hidden"
            : "flex-1 px-3 py-3"
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
        <footer className="mt-auto border-t px-3 py-1.5 text-[10px] text-muted-foreground">
          {site ?? title} · {t("area.publishing")}
        </footer>
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
