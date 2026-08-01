import type {
  ChartCategorySeriesV1,
  ChartModelV1,
  ChartPointSeriesV1,
} from "./charts.js";

/** Fixed intrinsic size used by document targets and by the SVG fallback. */
export const CHART_SVG_SIZE_V1 = Object.freeze({ width: 720, height: 360 });

const PLOT = Object.freeze({ left: 64, top: 42, right: 700, bottom: 286 });
const DEFAULT_COLORS = ["#0c66e4", "#36b37e", "#ffab00", "#de350b", "#6554c0", "#00a3bf"] as const;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
function finite(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? value! : fallback;
}

function color(value: string | undefined, fallback: string): string {
  return value && /^#[0-9a-f]{6}$/iu.test(value) ? value : fallback;
}

function palette(chart: ChartModelV1): string[] {
  const configured = chart.style?.colors?.filter((entry) => /^#[0-9a-f]{6}$/iu.test(entry));
  return (configured && configured.length > 0 ? configured : DEFAULT_COLORS).map((entry) => entry.toLowerCase());
}

function numberValue(value: number | string, index: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? timestamp : index;
}

function labelValue(value: number | string): string {
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return value;
}

function range(values: readonly number[], minimum?: number | string, maximum?: number | string): { min: number; max: number } {
  const finiteValues = values.filter((value) => Number.isFinite(value));
  const min = minimum === undefined ? Math.min(0, ...(finiteValues.length ? finiteValues : [0])) : numberValue(minimum, 0);
  const maxCandidate = maximum === undefined ? Math.max(1, ...(finiteValues.length ? finiteValues : [1])) : numberValue(maximum, 1);
  const max = maxCandidate <= min ? min + 1 : maxCandidate;
  return { min, max };
}

function y(value: number, bounds: { min: number; max: number }): number {
  return PLOT.bottom - ((value - bounds.min) / (bounds.max - bounds.min)) * (PLOT.bottom - PLOT.top);
}

function x(index: number, count: number): number {
  return count <= 1 ? (PLOT.left + PLOT.right) / 2 : PLOT.left + (index / (count - 1)) * (PLOT.right - PLOT.left);
}

function pointX(value: number, bounds: { min: number; max: number }): number {
  return PLOT.left + ((value - bounds.min) / (bounds.max - bounds.min)) * (PLOT.right - PLOT.left);
}

function titleBlock(chart: ChartModelV1, description: string): string {
  return `<title id="chart-title">${escapeXml(chart.title ?? "Chart")}</title><desc id="chart-description">${escapeXml(description)}</desc>`;
}

function axes(chart: ChartModelV1, labels: readonly string[], bounds: { min: number; max: number }): string {
  const horizontal = `<line x1="${PLOT.left}" y1="${PLOT.bottom}" x2="${PLOT.right}" y2="${PLOT.bottom}" stroke="#6b778c" stroke-width="1"/>`;
  const vertical = `<line x1="${PLOT.left}" y1="${PLOT.top}" x2="${PLOT.left}" y2="${PLOT.bottom}" stroke="#6b778c" stroke-width="1"/>`;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((step) => {
    const value = bounds.min + (bounds.max - bounds.min) * step;
    const yy = y(value, bounds);
    return `<line x1="${PLOT.left}" y1="${yy.toFixed(2)}" x2="${PLOT.right}" y2="${yy.toFixed(2)}" stroke="#dfe1e6" stroke-width="1"/><text x="${PLOT.left - 8}" y="${(yy + 4).toFixed(2)}" text-anchor="end" font-size="11" fill="#5e6c84">${escapeXml(value.toFixed(0))}</text>`;
  }).join("");
  const xLabels = labels.map((label, index) => `<text x="${x(index, labels.length).toFixed(2)}" y="${PLOT.bottom + 20}" text-anchor="middle" font-size="11" fill="#5e6c84">${escapeXml(label)}</text>`).join("");
  const xLabel = chart.xLabel ? `<text x="${(PLOT.left + PLOT.right) / 2}" y="${PLOT.bottom + 42}" text-anchor="middle" font-size="12" fill="#172b4d">${escapeXml(chart.xLabel)}</text>` : "";
  const yLabel = chart.yLabel ? `<text x="14" y="${(PLOT.top + PLOT.bottom) / 2}" text-anchor="middle" font-size="12" fill="#172b4d" transform="rotate(-90 14 ${(PLOT.top + PLOT.bottom) / 2})">${escapeXml(chart.yLabel)}</text>` : "";
  return `${grid}${horizontal}${vertical}${xLabels}${xLabel}${yLabel}`;
}

function legend(series: readonly { label: string }[], colors: readonly string[]): string {
  return series.map((entry, index) => {
    const lx = PLOT.left + index * 150;
    return `<rect x="${lx}" y="12" width="10" height="10" fill="${colors[index % colors.length]}"/><text x="${lx + 16}" y="21" font-size="11" fill="#172b4d">${escapeXml(entry.label)}</text>`;
  }).join("");
}

function categoryChart(chart: ChartModelV1, labels: readonly string[], series: readonly ChartCategorySeriesV1[], colors: readonly string[]): string {
  const values = series.flatMap((entry) => entry.values.map((value) => finite(value, 0)));
  const stackedValues = chart.stacked
    ? labels.map((_, index) => series.reduce((sum, entry) => sum + finite(entry.values[index], 0), 0))
    : values;
  const bounds = range(stackedValues, chart.axes?.y?.min, chart.axes?.y?.max);
  const body = axes(chart, labels, bounds);
  const count = labels.length;
  const groupWidth = Math.min(64, (PLOT.right - PLOT.left) / Math.max(1, count) * 0.72);
  const bars = chart.kind === "bar" || chart.kind === "xyBar";
  if (bars) {
    const grouped = series.map((entry, seriesIndex) => labels.map((_, index) => {
      const value = finite(entry.values[index], 0);
      const base = chart.stacked ? series.slice(0, seriesIndex).reduce((sum, previous) => sum + finite(previous.values[index], 0), 0) : 0;
      const width = chart.stacked ? groupWidth : groupWidth / Math.max(1, series.length);
      const left = x(index, count) - groupWidth / 2 + (chart.stacked ? 0 : seriesIndex * width);
      const top = y(base + value, bounds);
      const baseline = y(base, bounds);
      return `<rect x="${left.toFixed(2)}" y="${Math.min(top, baseline).toFixed(2)}" width="${Math.max(1, width - 2).toFixed(2)}" height="${Math.max(1, Math.abs(baseline - top)).toFixed(2)}" fill="${colors[seriesIndex % colors.length]}" opacity="${finite(chart.opacity, 1)}"><title>${escapeXml(`${entry.label}, ${labels[index]}: ${value}`)}</title></rect>`;
    }).join(""));
    return `${body}${grouped.join("")}${legend(series, colors)}`;
  }
  const paths = series.map((entry, seriesIndex) => {
    const points = labels.map((_, index) => `${x(index, count).toFixed(2)},${y(finite(entry.values[index], 0), bounds).toFixed(2)}`).join(" ");
    const line = `<polyline points="${points}" fill="none" stroke="${colors[seriesIndex % colors.length]}" stroke-width="3" opacity="${finite(chart.opacity, 1)}"/>`;
    const area = chart.kind === "area" ? `<polygon points="${x(0, count).toFixed(2)},${PLOT.bottom} ${points} ${x(count - 1, count).toFixed(2)},${PLOT.bottom}" fill="${colors[seriesIndex % colors.length]}" opacity="${(finite(chart.opacity, 0.7) * 0.35).toFixed(2)}"/>` : "";
    const marks = chart.showShapes === false ? "" : labels.map((_, index) => `<circle cx="${x(index, count).toFixed(2)}" cy="${y(finite(entry.values[index], 0), bounds).toFixed(2)}" r="3.5" fill="${colors[seriesIndex % colors.length]}"/>`).join("");
    return `${area}${line}${marks}`;
  }).join("");
  return `${body}${paths}${legend(series, colors)}`;
}

function pointChart(chart: ChartModelV1, series: readonly ChartPointSeriesV1[], colors: readonly string[]): string {
  const points = series.flatMap((entry) => entry.points.map((point, index) => ({ value: numberValue(point.x, index), label: labelValue(point.x) })));
  const xBounds = range(points.map((entry) => entry.value), chart.axes?.x?.min, chart.axes?.x?.max);
  const yValues = series.flatMap((entry) => entry.points.map((point) => finite(point.y, 0)));
  const yBounds = range(yValues, chart.axes?.y?.min, chart.axes?.y?.max);
  const labels = points.length <= 12 ? points.map((entry) => entry.label) : [];
  const body = axes(chart, labels, yBounds);
  return `${body}${series.map((entry, seriesIndex) => {
    const linePoints = entry.points.map((point, index) => `${pointX(numberValue(point.x, index), xBounds).toFixed(2)},${y(point.y, yBounds).toFixed(2)}`).join(" ");
    const colorValue = colors[seriesIndex % colors.length];
    if (chart.kind === "xyBar") {
      const width = Math.max(8, Math.min(36, (PLOT.right - PLOT.left) / Math.max(1, entry.points.length) * 0.55));
      return entry.points.map((point, index) => {
        const xx = pointX(numberValue(point.x, index), xBounds) - width / 2;
        const yy = y(point.y, yBounds);
        return `<rect x="${xx.toFixed(2)}" y="${Math.min(yy, PLOT.bottom).toFixed(2)}" width="${width.toFixed(2)}" height="${Math.max(1, PLOT.bottom - yy).toFixed(2)}" fill="${colorValue}" opacity="${finite(chart.opacity, 1)}"><title>${escapeXml(`${entry.label}, ${labelValue(point.x)}: ${point.y}`)}</title></rect>`;
      }).join("");
    }
    if (chart.kind === "scatter") {
      return entry.points.map((point, index) => `<circle cx="${pointX(numberValue(point.x, index), xBounds).toFixed(2)}" cy="${y(point.y, yBounds).toFixed(2)}" r="4" fill="${colorValue}" opacity="${finite(chart.opacity, 1)}"><title>${escapeXml(`${entry.label}, ${labelValue(point.x)}: ${point.y}`)}</title></circle>`).join("");
    }
    const line = `<polyline points="${linePoints}" fill="none" stroke="${colorValue}" stroke-width="3" opacity="${finite(chart.opacity, 1)}"/>`;
    const first = entry.points[0];
    const last = entry.points.at(-1);
    const area = (chart.kind === "xyArea" || chart.kind === "xyStepArea") && first && last
      ? `<polygon points="${pointX(numberValue(first.x, 0), xBounds).toFixed(2)},${PLOT.bottom} ${linePoints} ${pointX(numberValue(last.x, entry.points.length - 1), xBounds).toFixed(2)},${PLOT.bottom}" fill="${colorValue}" opacity="0.2"/>`
      : "";
    const marks = chart.showShapes === false ? "" : entry.points.map((point, index) => `<circle cx="${pointX(numberValue(point.x, index), xBounds).toFixed(2)}" cy="${y(point.y, yBounds).toFixed(2)}" r="3.5" fill="${colorValue}"/>`).join("");
    return `${area}${line}${marks}`;
  }).join("")}${legend(series, colors)}`;
}

function pieChart(chart: ChartModelV1, labels: readonly string[], series: readonly ChartCategorySeriesV1[], colors: readonly string[]): string {
  const values = labels.map((_, index) => Math.max(0, finite(series[0]?.values[index], 0)));
  const total = values.reduce((sum, value) => sum + value, 0) || 1;
  let angle = -Math.PI / 2;
  const cx = 250;
  const cy = 170;
  const radius = 110;
  const paths = values.map((value, index) => {
    const next = angle + (value / total) * Math.PI * 2;
    const x1 = cx + radius * Math.cos(angle);
    const y1 = cy + radius * Math.sin(angle);
    const x2 = cx + radius * Math.cos(next);
    const y2 = cy + radius * Math.sin(next);
    const large = next - angle > Math.PI ? 1 : 0;
    const mid = (angle + next) / 2;
    const explode = finite(chart.pie?.explode?.[index], 0);
    const offsetX = Math.cos(mid) * Math.min(20, Math.max(0, explode));
    const offsetY = Math.sin(mid) * Math.min(20, Math.max(0, explode));
    angle = next;
    return `<path d="M ${cx + offsetX} ${cy + offsetY} L ${x1 + offsetX} ${y1 + offsetY} A ${radius} ${radius} 0 ${large} 1 ${x2 + offsetX} ${y2 + offsetY} Z" fill="${colors[index % colors.length]}" opacity="${finite(chart.opacity, 1)}"><title>${escapeXml(`${labels[index]}: ${value}`)}</title></path>`;
  }).join("");
  const itemLegend = labels.map((label, index) => `<rect x="430" y="${60 + index * 24}" width="10" height="10" fill="${colors[index % colors.length]}"/><text x="446" y="${69 + index * 24}" font-size="11" fill="#172b4d">${escapeXml(label)}</text>`).join("");
  return `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="#dfe1e6"/>${paths}${itemLegend}`;
}

function ganttChart(chart: ChartModelV1): string {
  if (chart.data.mode !== "gantt") return "";
  const tasks = chart.data.tasks;
  const starts = tasks.map((task) => Date.parse(task.start)).filter(Number.isFinite);
  const ends = tasks.map((task) => Date.parse(task.end)).filter(Number.isFinite);
  const start = Math.min(...(starts.length ? starts : [0]));
  const end = Math.max(...(ends.length ? ends : [start + 86_400_000]));
  const span = Math.max(1, end - start);
  return tasks.map((task, index) => {
    const left = PLOT.left + ((Date.parse(task.start) - start) / span) * (PLOT.right - PLOT.left);
    const right = PLOT.left + ((Date.parse(task.end) - start) / span) * (PLOT.right - PLOT.left);
    const top = PLOT.top + index * 34;
    return `<text x="${PLOT.left - 8}" y="${top + 16}" text-anchor="end" font-size="11" fill="#172b4d">${escapeXml(task.label)}</text><rect x="${left.toFixed(2)}" y="${top}" width="${Math.max(4, right - left).toFixed(2)}" height="20" rx="3" fill="#0c66e4"><title>${escapeXml(`${task.label}: ${task.start} - ${task.end}`)}</title></rect>`;
  }).join("");
}

/**
 * Render the target-neutral chart model to a safe, dependency-free SVG.
 * Document targets embed this as a vector visual and retain their own
 * accessible data table alongside it.
 */
export function renderChartSvgV1(chart: ChartModelV1): string {
  const width = Math.max(320, Math.min(1200, Math.round(chart.display?.width ?? CHART_SVG_SIZE_V1.width)));
  const height = Math.max(220, Math.min(800, Math.round(chart.display?.height ?? CHART_SVG_SIZE_V1.height)));
  const colors = palette(chart);
  const background = color(chart.style?.backgroundColor, "#ffffff");
  const border = color(chart.style?.borderColor, "#dfe1e6");
  let description = chart.title ?? "Chart";
  let body = "";
  if (chart.data.mode === "gantt" || chart.kind === "gantt") {
    description = `${chart.title ?? "Gantt"}: ${chart.data.mode === "gantt" ? chart.data.tasks.length : 0} tasks`;
    body = ganttChart(chart);
  } else if (chart.kind === "pie" && chart.data.mode === "categories") {
    description = `${chart.title ?? "Pie chart"}: ${chart.data.labels.length} categories`;
    body = pieChart(chart, chart.data.labels, chart.data.series, colors);
  } else if (chart.data.mode === "categories") {
    description = `${chart.title ?? "Chart"}: ${chart.data.labels.length} categories`;
    body = categoryChart(chart, chart.data.labels, chart.data.series, colors);
  } else {
    description = `${chart.title ?? "Chart"}: ${chart.data.series.reduce((sum, entry) => sum + entry.points.length, 0)} points`;
    body = pointChart(chart, chart.data.series, colors);
  }
  const title = chart.title ? `<text x="${PLOT.left}" y="30" font-size="16" font-weight="700" fill="#172b4d">${escapeXml(chart.title)}</text>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${CHART_SVG_SIZE_V1.width} ${CHART_SVG_SIZE_V1.height}" role="img" aria-labelledby="chart-title chart-description"><rect x="0" y="0" width="720" height="360" fill="${background}" stroke="${border}"/>${title}${titleBlock(chart, description)}<g font-family="Arial, Helvetica, sans-serif">${body}</g></svg>`;
}
