import { barY, defineChart, group, mountChart } from "@tanstack/charts";
import { tooltip } from "@tanstack/charts/tooltip";
import { scaleBand, scaleLinear } from "d3-scale";

interface ChartRowV1 {
  label: string;
  series: string;
  value: number;
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

function mountTanStackChartV1(root: HTMLElement): void {
  const fallback = root.querySelector<HTMLElement>("figure[data-atlcli-block=chart]");
  const rows = rowsFromStaticFallbackV1(root);
  const title = fallback?.querySelector("figcaption")?.textContent?.trim();
  if (!fallback || !rows || !title) return;

  const mount = document.createElement("div");
  mount.setAttribute("data-atlcli-chart-runtime", "tanstack-v0.3");
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
    });
    fallback.hidden = true;
    root.dataset.atlcliChartIsland = "hydrated";
  } catch {
    mount.remove();
  }
}

/** Closed client runtime dispatch. Source content cannot introduce an adapter. */
export function activateChartIslandV1(root: HTMLElement): void {
  switch (root.dataset.atlcliChartRenderer) {
    case "tanstack-v0.3": mountTanStackChartV1(root); break;
  }
}
