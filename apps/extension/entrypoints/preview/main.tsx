// The theme stylesheet is imported by the host entrypoint, never by a
// component, so the portable app layer stays importable in a module runner that
// cannot parse CSS.
import "../../assets/globals.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

const container = document.getElementById("root");
if (!container) throw new Error("preview page root element missing");
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
