/**
 * The screen registry (spec 010 Phase 0).
 *
 * **This list is the extension point.** Adding a screen is one entry here plus
 * its component — the shell (`AppShell.tsx`) never learns a screen id, and no
 * navigation code changes. What landed since Phase 0:
 *
 *   - `ScopeSection`  → part of the Export screen (T5.1), correctly *not* a
 *                       registry entry: it is one form above both engines;
 *   - `PreviewScreen` → registered (T5.3). Its `pdf-preview` requirement means
 *                       it stays disabled-with-a-reason until a host advertises
 *                       the capability — the registry behaving correctly, not a
 *                       bug. The large-preview tab page mounts the *same*
 *                       component with its own shell.
 *   - `TemplatesScreen` → the T5.2 library, replacing the Phase 0 placeholder.
 *                       Requires `template-library`, so a host that cannot
 *                       store templates drops it without the Export screen
 *                       noticing.
 *   - `JobsSection`   → still the Activity placeholder (T5.6); its
 *                       `durable-jobs` requirement is already declared, so the
 *                       entry becomes available the moment a host advertises
 *                       the capability.
 *
 * Chat is deliberately out of scope; nothing here makes it awkward to add.
 */
import { FileDown, Info, Settings } from "lucide-react";
import type { ScreenDefinition } from "../../utils/screens/registry.js";
import { ExportScreen } from "./ExportScreen.js";
import { previewScreenDefinition } from "./PreviewScreen.js";
import { templatesScreenDefinition } from "./TemplatesScreen.js";
import { SETTINGS_SCREEN_ID, SettingsScreen } from "./SettingsScreen.js";
import { AboutScreen } from "./AboutScreen.js";
import { jobsScreenDefinition } from "./JobsScreen.js";
import {
  researchScreenDefinition,
  RESEARCH_SCREEN_ID,
} from "./ResearchScreen.js";

export const SCREEN_IDS = {
  export: "export",
  preview: "preview",
  templates: "templates",
  activity: "activity",
  research: RESEARCH_SCREEN_ID,
  settings: SETTINGS_SCREEN_ID,
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
    navigation: "primary",
    // No `loaded-page` requirement on purpose: the Export screen renders the
    // detection state itself, so the user always has somewhere to land and a
    // sentence explaining what to do next.
  },
  previewScreenDefinition,
  templatesScreenDefinition,
  {
    ...jobsScreenDefinition,
  },
  researchScreenDefinition,
  {
    id: SCREEN_IDS.settings,
    labelKey: "screen.settings.label",
    descriptionKey: "screen.settings.description",
    icon: Settings,
    component: SettingsScreen,
    order: 40,
    navigation: "utility",
  },
  {
    id: SCREEN_IDS.about,
    labelKey: "screen.about.label",
    descriptionKey: "screen.about.description",
    icon: Info,
    component: AboutScreen,
    order: 50,
    navigation: "utility",
  },
];
