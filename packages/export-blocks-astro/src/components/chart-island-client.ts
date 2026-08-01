import { barY, defineChart, group, mountChart } from "@tanstack/charts";
import { tooltip } from "@tanstack/charts/tooltip";
import { scaleBand, scaleLinear } from "d3-scale";

interface ChartRowV1 {
  label: string;
  series: string;
  value: number;
}

const TANSTACK_EXPORT_BLOCK_BAR_V1 = "tanstack-v0.3/bar";

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
    tooltip,
  });
  try {
    mountChart(mount, {
      definition,
      height: 320,
      initialWidth: 720,
      ariaLabel: title,
      ariaDescription: `Interactive chart: ${title}`,
      idPrefix: "atlcli-chart",
      tabIndex: 0,
    });
    const staticSvg = fallback.querySelector<SVGSVGElement>("svg");
    if (staticSvg) staticSvg.style.display = "none";
    fallback.dataset.atlcliChartFallback = "static-hidden";
    root.dataset.atlcliChartIsland = "hydrated";
    root.dataset.atlcliChartA11y = "keyboard-table-fallback";
  } catch {
    mount.remove();
  }
}

/** Closed client runtime dispatch. Source content cannot introduce an adapter. */
export function activateChartIslandV1(root: HTMLElement): void {
  switch (root.dataset.atlcliChartCapability ?? root.dataset.atlcliChartRenderer) {
    case "tanstack-v0.3":
    case TANSTACK_EXPORT_BLOCK_BAR_V1:
      mountTanStackChartV1(root); break;
  }
}
