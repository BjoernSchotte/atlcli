/**
 * The large-preview shell (spec 010 T5.3).
 *
 * A second *host shell*, not a second screen: it mounts the very same
 * `PreviewScreen` component the side panel does, with a one-element `screens`
 * array (already supported by `<ExportApp>`) and a `PreviewShellContext` that
 * says "full size, and no 'open large preview' action — you are it". No second
 * viewer, no second compile path.
 *
 * The `pdf-preview` capability is added to the ports here rather than being
 * assumed: this page *is* the surface that provides a large PDF preview, so it
 * advertises it. The side panel advertises it from `CHROME_CAPABILITIES` once
 * the screen is registered in `components/screens/index.ts`; until then the
 * panel's entry correctly renders as disabled-with-a-reason.
 */
import React, { useMemo, useState } from "react";
import { ExportApp } from "../../components/app/ExportApp.js";
import {
  PREVIEW_CAPABILITY,
  PREVIEW_SCREEN_ID,
  PreviewShellContext,
  previewScreenDefinition,
  type PreviewShellConfig,
} from "../../components/screens/PreviewScreen.js";
import type { AppPorts } from "../../utils/ports/index.js";
import { createChromePorts } from "../sidepanel/ports/index.js";

const FULL_SHELL: PreviewShellConfig = { layout: "full", openLargePreview: null };

function withPreviewCapability(ports: AppPorts): AppPorts {
  if (ports.host.capabilities.includes(PREVIEW_CAPABILITY)) return ports;
  return {
    ...ports,
    host: {
      ...ports.host,
      capabilities: [...ports.host.capabilities, PREVIEW_CAPABILITY],
    },
  };
}

export function App(): React.JSX.Element {
  const [base] = useState(createChromePorts);
  const ports = useMemo(() => withPreviewCapability(base), [base]);
  return (
    <PreviewShellContext.Provider value={FULL_SHELL}>
      <ExportApp
        ports={ports}
        screens={[previewScreenDefinition]}
        initialScreenId={PREVIEW_SCREEN_ID}
      />
    </PreviewShellContext.Provider>
  );
}
