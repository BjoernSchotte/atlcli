/**
 * `<ExportApp ports={…} />` — the portable application (spec 010 Phase 0).
 *
 * This is the layer a Forge app can host without Chrome APIs. It reads nothing
 * from the ambient environment: no `chrome.*`, no `indexedDB`, no `fetch`, and
 * no `chrome.runtime.getManifest()` at module scope (the defect that made the
 * old `App.tsx` unimportable outside an extension, and the reason no test ever
 * imported it). Everything arrives through {@link AppPorts}.
 *
 * The standing proof is `tests/app-portability.test.tsx`: this component
 * renders and completes an export under happy-dom with `globalThis.chrome`
 * deleted (SPIKE.md hypothesis H4). If that test ever needs a `chrome` shim to
 * pass, something re-coupled.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppPorts } from "../../utils/ports/index.js";
import { I18nProvider } from "../../utils/i18n/context.js";
import { resolveLocale } from "../../utils/i18n/messages.js";
import {
  pickActiveScreen,
  resolveScreens,
  type ScreenDefinition,
  type ScreenProps,
} from "../../utils/screens/registry.js";
import { defaultScreens, SCREEN_IDS } from "../screens/index.js";
import type { AppWorkspace } from "../../utils/ports/settings.js";
import { AppShell, type ShellLayout } from "./AppShell.js";
import { ExportRunsProvider } from "./export-runs.js";
import { PublishingDraftProvider } from "./publishing-draft.js";
import { SettingsProvider, useAppSettings } from "./settings-context.js";
import { usePageContext } from "./use-page-context.js";

export interface ExportAppProps {
  ports: AppPorts;
  /**
   * Screens to arrange. Defaults to {@link defaultScreens}; a host that mounts
   * a subset (a Forge content-action modal showing only Export) passes its own
   * list rather than the shell learning about hosts.
   */
  screens?: readonly ScreenDefinition[];
  /**
   * BCP-47 candidates for the UI language, best first, consulted after the
   * stored preference. Defaults to the browser's languages when there is a
   * `navigator` — resolved lazily so importing this module never touches a
   * global.
   */
  localeCandidates?: readonly (string | null | undefined)[];
  /** Screen to open first. When omitted, the last workspace or Kiteweave AI opens. */
  initialScreenId?: string;
  /**
   * How much room the host gives the shell. Defaults to the 400 px side panel;
   * a host that owns a whole tab passes `"full"`. See {@link ShellLayout}.
   */
  layout?: ShellLayout;
}

function browserLocales(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return [navigator.language, ...(navigator.languages ?? [])].filter(Boolean);
}

export function ExportApp({
  ports,
  screens = defaultScreens,
  localeCandidates,
  initialScreenId,
  layout = "compact",
}: ExportAppProps): React.JSX.Element {
  return (
    <SettingsProvider store={ports.settings}>
      <LocalizedApp
        ports={ports}
        screens={screens}
        localeCandidates={localeCandidates}
        initialScreenId={initialScreenId}
        layout={layout}
      />
    </SettingsProvider>
  );
}

function LocalizedApp({
  ports,
  screens,
  localeCandidates,
  initialScreenId,
  layout,
}: Required<Pick<ExportAppProps, "ports" | "screens" | "layout">> &
  Pick<ExportAppProps, "localeCandidates" | "initialScreenId">): React.JSX.Element {
  const { settings } = useAppSettings();
  const locale = useMemo(
    () => resolveLocale([settings.locale, ...(localeCandidates ?? browserLocales())]),
    [settings.locale, localeCandidates]
  );

  return (
    <I18nProvider locale={locale}>
      <AppBody
        ports={ports}
        screens={screens}
        initialScreenId={initialScreenId}
        layout={layout}
      />
    </I18nProvider>
  );
}

function AppBody({
  ports,
  screens,
  initialScreenId,
  layout,
}: {
  ports: AppPorts;
  screens: readonly ScreenDefinition[];
  initialScreenId?: string;
  layout: ShellLayout;
}): React.JSX.Element {
  const { settings, loaded: settingsLoaded, update: updateSettings } = useAppSettings();
  // Bound wrappers, not raw method references: `ports` may be an object literal
  // whose methods use `this`, and a stable identity keeps the subscription
  // effect from re-running on every render.
  const watchPageContext = useCallback<AppPorts["watchPageContext"]>(
    (onChange) => ports.watchPageContext(onChange),
    [ports]
  );
  const loadPage = useCallback<AppPorts["loadPage"]>(
    (contentId) => ports.loadPage(contentId),
    [ports]
  );
  const { state, retry, identity } = usePageContext(watchPageContext, loadPage);
  const initialScreen = initialScreenId ?? SCREEN_IDS.research;
  const workspaceForScreen = useCallback((screenId: string): AppWorkspace | null => {
    const definition = screens.find((screen) => screen.id === screenId);
    if (!definition || definition.navigation === "utility") return null;
    return definition.workspace ?? "publishing";
  }, [screens]);
  const [requestedScreenId, setRequestedScreenId] = useState(initialScreen);
  const [activeWorkspace, setActiveWorkspace] = useState<AppWorkspace>(
    () => workspaceForScreen(initialScreen) ?? "ai",
  );
  const restoredWorkspace = useRef(false);

  const resolved = useMemo(
    () =>
      resolveScreens(screens, {
        hasLoadedPage: state.status === "loaded",
        capabilities: ports.host.capabilities,
      }),
    [screens, state.status, ports.host.capabilities]
  );
  const active = useMemo(
    () => pickActiveScreen(resolved, requestedScreenId),
    [resolved, requestedScreenId]
  );

  const firstScreenInWorkspace = useCallback((workspace: AppWorkspace): string => {
    const candidate = resolved.find((screen) =>
      screen.visible
      && (screen.definition.navigation ?? "primary") === "primary"
      && (screen.definition.workspace ?? "publishing") === workspace
      && screen.available
    ) ?? resolved.find((screen) =>
      screen.visible
      && (screen.definition.navigation ?? "primary") === "primary"
      && (screen.definition.workspace ?? "publishing") === workspace
    );
    return candidate?.definition.id ?? (workspace === "ai" ? SCREEN_IDS.research : SCREEN_IDS.export);
  }, [resolved]);

  const navigateWorkspace = useCallback((workspace: AppWorkspace): void => {
    setActiveWorkspace(workspace);
    setRequestedScreenId(firstScreenInWorkspace(workspace));
    void updateSettings({ lastWorkspace: workspace });
  }, [firstScreenInWorkspace, updateSettings]);

  const navigateScreen = useCallback((screenId: string): void => {
    const workspace = workspaceForScreen(screenId);
    if (workspace) {
      setActiveWorkspace(workspace);
      void updateSettings({ lastWorkspace: workspace });
    }
    setRequestedScreenId(screenId);
  }, [updateSettings, workspaceForScreen]);

  useEffect(() => {
    if (!settingsLoaded || restoredWorkspace.current || initialScreenId !== undefined) return;
    restoredWorkspace.current = true;
    const workspace = settings.lastWorkspace ?? "ai";
    setActiveWorkspace(workspace);
    setRequestedScreenId(firstScreenInWorkspace(workspace));
  }, [firstScreenInWorkspace, initialScreenId, settings.lastWorkspace, settingsLoaded]);

  const screenProps: ScreenProps = {
    ports,
    page: state,
    retry,
    navigate: navigateScreen,
  };

  return (
    <ExportRunsProvider identity={identity}>
      <PublishingDraftProvider ports={ports} page={state}>
        <AppShell
          title={ports.host.name}
          version={ports.host.version}
          screens={resolved}
          active={active}
          activeWorkspace={activeWorkspace}
          onNavigate={navigateScreen}
          onWorkspaceNavigate={navigateWorkspace}
          screenProps={screenProps}
          layout={layout}
        />
      </PublishingDraftProvider>
    </ExportRunsProvider>
  );
}
