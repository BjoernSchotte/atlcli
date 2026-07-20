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
import React from "react";
import { useT } from "../../utils/i18n/context.js";
import type { ResolvedScreen, ScreenProps } from "../../utils/screens/registry.js";
import { Alert, AlertTitle } from "../ui/alert.js";
import { cn } from "../ui/utils.js";

export function AppShell({
  title,
  version,
  screens,
  active,
  onNavigate,
  screenProps,
}: {
  title: string;
  version: string;
  screens: readonly ResolvedScreen[];
  active: ResolvedScreen | null;
  onNavigate: (id: string) => void;
  screenProps: ScreenProps;
}): React.JSX.Element {
  const t = useT();
  const visible = screens.filter((screen) => screen.visible);

  return (
    <main className="mx-auto box-border flex min-h-full max-w-[400px] flex-col gap-3 p-3">
      <header className="flex items-baseline justify-between gap-2">
        <h1 className="m-0 text-sm font-semibold">{title}</h1>
        <span className="text-xs text-muted-foreground" data-testid="app-version">
          {t("app.version", { version })}
        </span>
      </header>

      <nav aria-label={t("nav.sections")} data-testid="app-nav">
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t("nav.sections")}
        </div>
        <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
          {visible.map((screen) => {
            const label = t(screen.definition.labelKey);
            const Icon = screen.definition.icon;
            const isActive = active?.definition.id === screen.definition.id;
            return (
              <li key={screen.definition.id}>
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
                  onClick={() => onNavigate(screen.definition.id)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                    isActive
                      ? "bg-primary text-primary-foreground"
                      : "text-foreground hover:bg-accent hover:text-accent-foreground"
                  )}
                >
                  <Icon size={14} aria-hidden="true" />
                  {label}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <section data-testid={active ? `screen-${active.definition.id}` : "screen-none"}>
        {active === null ? null : active.available ? (
          <active.definition.component {...screenProps} />
        ) : (
          <Alert tone="muted" data-testid="screen-unavailable">
            <AlertTitle>{t("screen.unavailable.title")}</AlertTitle>
            <p className="m-0 mt-1">{t(active.reasonKey ?? "screen.unavailable.title")}</p>
          </Alert>
        )}
      </section>
    </main>
  );
}
