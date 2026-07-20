// Install the DOCX browser runtime BEFORE anything pulls in PizZip /
// docxtemplater, whose rewritten byte-helper calls resolve to it (spec 009).
import "@atlcli/docx/browser-runtime";
// Tailwind v4 + the CSS-variable theme (spec 010 Phase 0). Imported by the host
// entrypoint, never by a component, so the portable app layer stays importable
// in a plain module runner that cannot parse CSS.
import "../../assets/globals.css";
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
