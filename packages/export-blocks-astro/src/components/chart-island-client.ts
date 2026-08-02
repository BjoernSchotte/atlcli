import { barY, colorLegend, defineChart, group, mountChart } from "@tanstack/charts";
import { tooltip } from "@tanstack/charts/tooltip";
import { portal } from "@tanstack/charts/tooltip/portal";
import { scaleBand, scaleLinear } from "d3-scale";

interface ChartRowV1 {
  label: string;
  series: string;
  value: number;
}

const TANSTACK_EXPORT_BLOCK_BAR_V1 = "tanstack-v0.3/bar";
const DEFAULT_ISLAND_MOUNT_MS_V1 = 250;
const MAX_ISLAND_MOUNT_MS_V1 = 1_000;
const activeChartIslandsV1 = new WeakMap<HTMLElement, () => void>();

function mountBudgetMillisecondsV1(root: HTMLElement): number {
  const configured = Number(root.dataset.atlcliChartMaxMountMs);
  if (!Number.isFinite(configured)) return DEFAULT_ISLAND_MOUNT_MS_V1;
  return Math.max(1, Math.min(MAX_ISLAND_MOUNT_MS_V1, Math.floor(configured)));
}

function exposeStaticFallbackV1(root: HTMLElement, reason: "mount-error" | "runtime-budget"): void {
  const mount = root.querySelector<HTMLElement>("[data-atlcli-chart-runtime]");
  mount?.remove();
  const staticSvg = root.querySelector<SVGSVGElement>("figure[data-atlcli-block=chart] svg");
  if (staticSvg) staticSvg.style.removeProperty("display");
  const fallback = root.querySelector<HTMLElement>("figure[data-atlcli-block=chart]");
  fallback?.removeAttribute("data-atlcli-chart-fallback");
  root.dataset.atlcliChartIsland = "static";
  root.dataset.atlcliChartFallback = reason;
  root.dataset.atlcliChartA11y = "static-table-fallback";
  let status = root.querySelector<HTMLElement>("[data-atlcli-chart-runtime-status]");
  if (!status) {
    status = document.createElement("p");
    status.dataset.atlcliChartRuntimeStatus = reason;
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    root.prepend(status);
  }
  status.textContent = reason === "runtime-budget"
    ? "Interactive chart enhancement exceeded its runtime budget. The complete static chart and data table remain available."
    : "Interactive chart enhancement could not start. The complete static chart and data table remain available.";
}

function rowsFromStaticFallbackV1(root: HTMLElement): ChartRowV1[] | undefined {
  const rows: ChartRowV1[] = [];
  for (const bar of root.querySelectorAll<SVGRectElement>("figure[data-atlcli-block=chart] rect[data-atlcli-chart-value]")) {
    const label = bar.dataset.atlcliChartLabel;
    const series = bar.dataset.atlcliChartSeries;
    const value = Number(bar.dataset.atlcliChartValue);
    if (!label || !series || !Number.isFinite(value) || value < 0) return undefined;
    rows.push({ label, series, value });
  }
  return rows.length > 0 ? rows : undefined;
}

function rowsFromExportBlockTableV1(root: HTMLElement): ChartRowV1[] | undefined {
  const table = root.querySelector<HTMLTableElement>("table[data-atlcli-chart-data]");
  const headerCells = table?.querySelectorAll<HTMLTableCellElement>("thead th");
  if (!table || !headerCells || headerCells.length < 2) return undefined;
  const seriesNames = [...headerCells].slice(1).map((cell) => cell.textContent?.trim() ?? "");
  if (seriesNames.some((name) => name.length === 0)) return undefined;
  const rows: ChartRowV1[] = [];
  for (const row of table.querySelectorAll<HTMLTableRowElement>("tbody tr")) {
    const cells = [...row.children];
    const label = cells[0]?.textContent?.trim() ?? "";
    if (!label || cells.length !== seriesNames.length + 1) return undefined;
    for (const [index, cell] of cells.slice(1).entries()) {
      const value = Number(cell.textContent?.trim());
      if (!Number.isFinite(value) || value < 0) return undefined;
      rows.push({ label, series: seriesNames[index]!, value });
    }
  }
  return rows.length > 0 ? rows : undefined;
}

function mountTanStackChartV1(root: HTMLElement): void {
  const fallback = root.querySelector<HTMLElement>("figure[data-atlcli-block=chart]");
  const rows = root.dataset.atlcliChartCapability === TANSTACK_EXPORT_BLOCK_BAR_V1
    ? rowsFromExportBlockTableV1(root)
    : rowsFromStaticFallbackV1(root);
  const title = fallback?.querySelector("figcaption")?.textContent?.trim()
    ?? fallback?.querySelector("[data-atlcli-chart-heading] h3")?.textContent?.trim();
  if (!fallback || !rows || !title) return;

  const mount = document.createElement("div");
  mount.setAttribute("data-atlcli-chart-runtime", root.dataset.atlcliChartCapability ?? "tanstack-v0.3");
  mount.setAttribute("role", "group");
  mount.setAttribute("aria-label", title);
  mount.setAttribute("aria-description", `Interactive chart: ${title}. Use arrow keys to inspect data points.`);
  mount.dataset.atlcliChartA11y = "keyboard-table";
  fallback.after(mount);
  const definition = defineChart({
    marks: [barY(rows, { x: "label", y: "value", color: "series", layout: group({ padding: 0.2 }) })],
    x: { scale: () => scaleBand().padding(0.1) },
    y: { scale: scaleLinear, nice: true, grid: true },
    color: { legend: colorLegend({ label: "Series" }) },
    focus: "group-x",
    animate: { duration: 220, easing: "ease-out", respectReducedMotion: true, resize: false },
    tooltip: { use: tooltip, portal, placement: ["top", "bottom", "right", "left"], sticky: true },
  });
  const maxMountMs = mountBudgetMillisecondsV1(root);
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  root.dataset.atlcliChartMotion = reducedMotion ? "reduced" : "animated";
  const idPrefix = `${fallback.id || "atlcli-chart"}-interactive`;
  let lastWidth = 0;
  const options = {
    definition,
    height: 320,
    initialWidth: 720,
    ariaLabel: title,
    ariaDescription: `Interactive chart: ${title}. Arrow keys inspect category groups; Enter or Space pins the exact-value tooltip; Escape dismisses it.`,
    idPrefix,
    tabIndex: 0,
    onRender: ({ scene }: { scene: { width: number } }) => {
      lastWidth = scene.width;
      root.dataset.atlcliChartWidth = String(Math.round(scene.width));
    },
  };
  const started = performance.now();
  try {
    const host = mountChart(mount, options);
    const elapsed = Math.max(0, performance.now() - started);
    root.dataset.atlcliChartMountMs = String(Math.ceil(elapsed));
    if (elapsed > maxMountMs) {
      host.destroy();
      exposeStaticFallbackV1(root, "runtime-budget");
      return;
    }
    const staticSvg = fallback.querySelector<SVGSVGElement>("svg");
    if (staticSvg) staticSvg.style.display = "none";
    fallback.dataset.atlcliChartFallback = "static-hidden";
    root.dataset.atlcliChartIsland = "hydrated";
    root.dataset.atlcliChartA11y = "keyboard-table-fallback";
    let resizeFrame = 0;
    const updateForResize = () => {
      if (resizeFrame !== 0) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        host.update(options);
        const nextWidth = host.getScene().width;
        if (nextWidth !== lastWidth) root.dataset.atlcliChartWidth = String(Math.round(nextWidth));
      });
    };
    if (typeof ResizeObserver === "undefined") window.addEventListener("resize", updateForResize, { passive: true });
    const cleanup = () => {
      if (resizeFrame !== 0) cancelAnimationFrame(resizeFrame);
      window.removeEventListener("resize", updateForResize);
      window.removeEventListener("pagehide", cleanup);
      document.removeEventListener("astro:before-swap", cleanup);
      host.destroy();
      activeChartIslandsV1.delete(root);
    };
    activeChartIslandsV1.set(root, cleanup);
    window.addEventListener("pagehide", cleanup, { once: true });
    document.addEventListener("astro:before-swap", cleanup, { once: true });
  } catch {
    exposeStaticFallbackV1(root, "mount-error");
  }
}

/** Closed client runtime dispatch. Source content cannot introduce an adapter. */
export function activateChartIslandV1(root: HTMLElement): void {
  if (root.dataset.atlcliChartIsland !== "enabled" || activeChartIslandsV1.has(root)) return;
  switch (root.dataset.atlcliChartCapability ?? root.dataset.atlcliChartRenderer) {
    case "tanstack-v0.3":
    case TANSTACK_EXPORT_BLOCK_BAR_V1:
      mountTanStackChartV1(root); break;
  }
}
