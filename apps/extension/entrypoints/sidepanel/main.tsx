// Install the browser-safe byte helpers BEFORE anything pulls in PizZip /
// docxtemplater, whose rewritten `Buffer.*` calls resolve to them (spec 004).
import "../../utils/byte-helpers-shim.js";
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

const container = document.getElementById("root");
if (!container) throw new Error("side panel root element missing");
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
