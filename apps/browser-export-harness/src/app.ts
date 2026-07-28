import { runExport } from "@atlcli/docx/browser-entry";
import "./style.css";
import "./highlight-benchmark.js";
import { CONFORMANCE_CASES } from "./conformance-registry.js";

if (typeof runExport !== "function") {
  throw new Error("The canonical DOCX browser entry did not expose runExport.");
}
(globalThis as typeof globalThis & {
  __ATLCLI_DOCX_BROWSER_ENTRY_READY_AT?: number;
}).__ATLCLI_DOCX_BROWSER_ENTRY_READY_AT = performance.now();

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Harness element is missing: ${selector}`);
  return element;
}

function message(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function bindCase(
  container: HTMLElement,
  meta: { id: string; title: string; folderTaskIds: string[] },
  run: () => Promise<unknown>,
): void {
  // One section/button/state/result element per registered case — generated,
  // never hand-authored, so parallel feature lanes don't collide in index.html.
  const section = document.createElement("section");
  section.setAttribute("aria-labelledby", `${meta.id}-heading`);

  const heading = document.createElement("h2");
  heading.id = `${meta.id}-heading`;
  heading.textContent = `${meta.title} (${meta.folderTaskIds.join(", ")})`;

  const button = document.createElement("button");
  button.type = "button";
  button.dataset.testid = `run-${meta.id}`;
  button.textContent = `Run ${meta.id} case`;

  const state = document.createElement("output");
  state.dataset.testid = `${meta.id}-state`;
  state.textContent = "idle";

  const result = document.createElement("pre");
  result.dataset.testid = `${meta.id}-result`;

  section.append(heading, button, state, result);
  container.append(section);

  button.addEventListener("click", () => {
    button.disabled = true;
    state.textContent = "running";
    result.textContent = "";
    void run()
      .then((value) => {
        state.textContent = "passed";
        result.textContent = JSON.stringify(value, null, 2);
      })
      .catch((error) => {
        state.textContent = "failed";
        result.textContent = message(error);
      })
      .finally(() => {
        button.disabled = false;
      });
  });
}

required<HTMLOutputElement>('[data-testid="buffer-state"]').textContent =
  (globalThis as { Buffer?: unknown }).Buffer === undefined ? "absent" : "present";

const cases = required<HTMLElement>('[data-testid="cases"]');
for (const conformanceCase of CONFORMANCE_CASES) {
  bindCase(cases, conformanceCase, conformanceCase.run);
}
