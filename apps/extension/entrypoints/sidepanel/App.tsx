/**
 * The Chrome side panel shell (spec 010 Phase 0).
 *
 * Everything this file used to be — detection wiring, the read path, the two
 * engine sections, the debug round-trips — now lives either in the portable
 * `<ExportApp>` or in a `./ports/*` adapter. What remains is the one thing that
 * genuinely belongs to this host: constructing the Chrome ports.
 *
 * The ports are built once, in lazy state, so `chrome.runtime.getManifest()`
 * runs inside a component body rather than at module scope. That single move is
 * what makes the app layer importable — and therefore testable — outside an
 * extension (`tests/app-portability.test.tsx`).
 */
import React, { useState } from "react";
import { ExportApp } from "../../components/app/ExportApp.js";
import { createChromePorts } from "./ports/index.js";

export function App(): React.JSX.Element {
  const [ports] = useState(createChromePorts);
  return <ExportApp ports={ports} />;
}
