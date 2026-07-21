/**
 * The template library screen (spec 010 T5.2).
 *
 * A screen rather than a block inside Export, for the reason the registry
 * exists: managing a library is a *different task* from running an export, it
 * needs vertical room a 400 px export column does not have, and a host that
 * cannot store templates (`template-library` unmet) must be able to drop it
 * without the Export screen noticing. The Export screen keeps showing the
 * **active** template and the Export button — which is what the 90 % case
 * needs — and links here for everything else.
 *
 * The library and the export path share one IndexedDB: setting a template
 * active here is what `DocxTemplateStore.get()` resolves on the Export screen.
 */
import React from "react";
import { LayoutTemplate } from "lucide-react";
import type { ScreenDefinition, ScreenProps } from "../../utils/screens/registry.js";
import type { HostCapability } from "../../utils/ports/index.js";
import { useT } from "../../utils/i18n/context.js";
import { Alert } from "../ui/alert.js";
import { TemplateLibraryPanel } from "../export/TemplateLibraryPanel.js";

/** The capability a host must advertise to own a template library. */
export const TEMPLATE_LIBRARY_CAPABILITY: HostCapability = "template-library";

export const TEMPLATES_SCREEN_ID = "templates";

export function TemplatesScreen({ ports, page }: ScreenProps): React.JSX.Element {
  const t = useT();
  const spaceKey = page.status === "loaded" ? (page.page.details.spaceKey ?? null) : null;

  // The registry gates this screen on `template-library`, so reaching it
  // without the port means a host advertised a capability it does not have.
  // Say so rather than crashing.
  if (!ports.templates) {
    return (
      <Alert tone="muted" role="alert" data-testid="templates-unavailable">
        {t("screen.unmet.capability.templateLibrary")}
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="templates-screen">
      <TemplateLibraryPanel
        library={ports.templates}
        scanner={ports.docx}
        spaceKey={spaceKey}
      />
    </div>
  );
}

export const templatesScreenDefinition: ScreenDefinition = {
  id: TEMPLATES_SCREEN_ID,
  labelKey: "screen.templates.label",
  descriptionKey: "screen.templates.description",
  icon: LayoutTemplate,
  component: TemplatesScreen,
  requirements: [{ kind: "capability", capability: TEMPLATE_LIBRARY_CAPABILITY }],
  order: 20,
  navigation: "primary",
};
