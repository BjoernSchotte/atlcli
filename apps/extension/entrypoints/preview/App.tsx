/**
 * The large-preview shell (spec 010 T5.3).
 *
 * A second *host shell*, not a second screen: it mounts the very same
 * `PreviewScreen` component the side panel does, with a one-element `screens`
 * array (already supported by `<ExportApp>`) and a `PreviewShellContext` that
 * says "full size, and no 'open large preview' action — you are it". No second
 * viewer, no second compile path.
 *
 * The `pdf-preview` capability comes with the Chrome ports
 * (`CHROME_CAPABILITIES` in `../sidepanel/ports/index.ts`), exactly as in the
 * side panel.
 */
import React, { useState } from "react";
import { ExportApp } from "../../components/app/ExportApp.js";
import {
  PREVIEW_SCREEN_ID,
  PreviewShellContext,
  previewScreenDefinition,
  type PreviewShellConfig,
} from "../../components/screens/PreviewScreen.js";
import { createChromePorts } from "../sidepanel/ports/index.js";

const FULL_SHELL: PreviewShellConfig = {
  layout: "full",
  openLargePreview: null,
  closePreview: () => window.close(),
};

export function App(): React.JSX.Element {
  const [ports] = useState(createChromePorts);
  return (
    <PreviewShellContext.Provider value={FULL_SHELL}>
      <ExportApp
        ports={ports}
        screens={[previewScreenDefinition]}
        initialScreenId={PREVIEW_SCREEN_ID}
        // This page owns a whole tab. Without it the shell keeps the side
        // panel's 400 px cap and the "large" preview renders panel-sized.
        layout="full"
      />
    </PreviewShellContext.Provider>
  );
}
