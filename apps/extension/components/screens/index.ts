/**
 * The screen registry (spec 010 Phase 0).
 *
 * **This list is the extension point.** Adding a screen is one entry here plus
 * its component — the shell (`AppShell.tsx`) never learns a screen id, and no
 * navigation code changes. Wave-2 additions land as:
 *
 *   - `ScopeSection`  → part of the Export screen (T5.1), not a new entry;
 *   - `PdfPreview`    → `{ id: "preview", requirements: [{ kind: "capability",
 *                        capability: "pdf-preview" }, { kind: "loaded-page" }] }`
 *                        (T5.3) — the same component is what the large-preview
 *                        tab page mounts, with a different shell;
 *   - `JobsSection`   → replaces the Activity placeholder's `component` (T5.6);
 *                        its `durable-jobs` requirement is already declared, so
 *                        the entry becomes available the moment a host
 *                        advertises the capability.
 *
 * Chat is deliberately out of scope; nothing here makes it awkward to add.
 */
import { ClipboardList, FileDown, Info, LayoutTemplate, Settings } from "lucide-react";
import type { ScreenDefinition } from "../../utils/screens/registry.js";
import { ExportScreen } from "./ExportScreen.js";
import { SettingsScreen } from "./SettingsScreen.js";
import { AboutScreen } from "./AboutScreen.js";
import { createPlaceholderScreen } from "./PlaceholderScreen.js";

export const SCREEN_IDS = {
  export: "export",
  templates: "templates",
  activity: "activity",
  settings: "settings",
  about: "about",
} as const;

export const defaultScreens: readonly ScreenDefinition[] = [
  {
    id: SCREEN_IDS.export,
    labelKey: "screen.export.label",
    descriptionKey: "screen.export.description",
    icon: FileDown,
    component: ExportScreen,
    order: 10,
    // No `loaded-page` requirement on purpose: the Export screen renders the
    // detection state itself, so the user always has somewhere to land and a
    // sentence explaining what to do next.
  },
  {
    id: SCREEN_IDS.templates,
    labelKey: "screen.templates.label",
    descriptionKey: "screen.templates.description",
    icon: LayoutTemplate,
    component: createPlaceholderScreen(
      "screen.templates.label",
      "placeholder.templates",
      "templates-screen"
    ),
    order: 20,
  },
  {
    id: SCREEN_IDS.activity,
    labelKey: "screen.activity.label",
    descriptionKey: "screen.activity.description",
    icon: ClipboardList,
    component: createPlaceholderScreen(
      "screen.activity.label",
      "placeholder.activity",
      "activity-screen"
    ),
    // No host advertises `durable-jobs` yet (T5.6), so this entry stays visible
    // and disabled **with a reason** — which is exactly the behaviour the
    // registry exists to guarantee.
    requirements: [{ kind: "capability", capability: "durable-jobs" }],
    order: 30,
  },
  {
    id: SCREEN_IDS.settings,
    labelKey: "screen.settings.label",
    descriptionKey: "screen.settings.description",
    icon: Settings,
    component: SettingsScreen,
    order: 40,
  },
  {
    id: SCREEN_IDS.about,
    labelKey: "screen.about.label",
    descriptionKey: "screen.about.description",
    icon: Info,
    component: AboutScreen,
    order: 50,
  },
];
