import { FileDiff, parsePatchFiles, setLanguageOverride } from "@pierre/diffs";

interface LiveReviewPayload {
  title: string;
  comparison: string;
  patch: string;
  summary: {
    added: number;
    removed: number;
    modified: number;
    moved: number;
    review: number;
    coverage: string;
  };
}

declare global {
  interface Window {
    __ATLCLI_PIERRE_READY__?: boolean;
  }
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing #${id}.`);
  return element as T;
}

function addMetric(container: HTMLElement, label: string, value: string | number): void {
  const metric = document.createElement("span");
  metric.className = "metric";
  metric.textContent = `${label}: ${value}`;
  container.append(metric);
}

async function render(): Promise<void> {
  const response = await fetch("/api/review");
  if (!response.ok) throw new Error(`Review request failed with HTTP ${response.status}.`);
  const payload = await response.json() as LiveReviewPayload;

  requiredElement("title").textContent = payload.title;
  requiredElement("comparison").textContent = payload.comparison;
  const summary = requiredElement("summary");
  addMetric(summary, "Added", payload.summary.added);
  addMetric(summary, "Removed", payload.summary.removed);
  addMetric(summary, "Changed", payload.summary.modified);
  addMetric(summary, "Moved", payload.summary.moved);
  addMetric(summary, "Review", payload.summary.review);
  addMetric(summary, "Coverage", payload.summary.coverage);

  const patches = parsePatchFiles(payload.patch, "atlcli-live");
  const files = patches.flatMap((patch) => patch.files);
  if (files.length === 0) throw new Error("Pierre could not parse the atlcli unified patch.");

  const root = requiredElement("diff-root");
  root.replaceChildren();
  for (const fileDiff of files) {
    setLanguageOverride(fileDiff, "markdown");
    const instance = new FileDiff({
      theme: "pierre-light",
      themeType: "light",
      diffStyle: "unified",
      diffIndicators: "classic",
      lineDiffType: "word-alt",
      hunkSeparators: "metadata",
      overflow: "wrap",
      disableErrorHandling: true,
    });
    instance.render({ fileDiff, containerWrapper: root });
  }
  window.__ATLCLI_PIERRE_READY__ = true;
}

render().catch((error: unknown) => {
  const status = requiredElement("status");
  status.className = "error";
  status.textContent = error instanceof Error ? error.message : "Pierre rendering failed.";
  window.__ATLCLI_PIERRE_READY__ = false;
});
