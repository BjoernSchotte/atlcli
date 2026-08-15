import { pdfBytesFromUint8Array } from "@atlcli/pdf/browser";
import "../../../assets/globals.css";
import { openPdfViewer } from "../../../utils/pdf/viewer.js";
import { PDF_BYTES_BASE64 } from "virtual:preview-link-pdf";

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing browser-harness element: ${selector}`);
  return element;
}

function decodedFixture(): Uint8Array {
  const binary = atob(PDF_BYTES_BASE64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

const canvas = required<HTMLCanvasElement>('[data-testid="viewer-canvas"]');
const annotations = required<HTMLDivElement>('[data-testid="viewer-annotations"]');
const navigation = required<HTMLOutputElement>('[data-testid="viewer-navigation"]');
const state = required<HTMLOutputElement>('[data-testid="viewer-state"]');

try {
  const viewer = await openPdfViewer(pdfBytesFromUint8Array(decodedFixture()));
  await viewer.renderPage(1, canvas, {
    containerWidth: 600,
    containerHeight: 840,
    annotationLayer: annotations,
    onNavigate(pageNumber) {
      navigation.textContent = String(pageNumber);
    },
    devicePixelRatio: 1,
  });
  document.body.dataset.pageCount = String(viewer.pageCount);
  state.textContent = "ready";
} catch (error) {
  state.textContent = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  throw error;
}
