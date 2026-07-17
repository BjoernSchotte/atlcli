import "./style.css";
import { runDocxCase } from "./docx-case.js";
import { runPdfAbortCase, runPdfCase } from "./pdf-case.js";

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Harness element is missing: ${selector}`);
  return element;
}

function message(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function bindCase(
  buttonTestId: string,
  stateTestId: string,
  resultTestId: string | undefined,
  run: () => Promise<unknown>,
): void {
  const button = required<HTMLButtonElement>(`[data-testid="${buttonTestId}"]`);
  const state = required<HTMLOutputElement>(`[data-testid="${stateTestId}"]`);
  const result = resultTestId
    ? required<HTMLElement>(`[data-testid="${resultTestId}"]`)
    : undefined;
  button.addEventListener("click", () => {
    button.disabled = true;
    state.textContent = "running";
    if (result) result.textContent = "";
    void run()
      .then((value) => {
        state.textContent = "passed";
        if (result) result.textContent = JSON.stringify(value, null, 2);
      })
      .catch((error) => {
        state.textContent = "failed";
        if (result) result.textContent = message(error);
      })
      .finally(() => {
        button.disabled = false;
      });
  });
}

required<HTMLOutputElement>("[data-testid=\"buffer-state\"]").textContent =
  (globalThis as { Buffer?: unknown }).Buffer === undefined ? "absent" : "present";

bindCase("run-docx", "docx-state", "docx-result", runDocxCase);
bindCase("run-pdf-abort", "pdf-abort-state", undefined, runPdfAbortCase);
bindCase("run-pdf", "pdf-state", "pdf-result", runPdfCase);
