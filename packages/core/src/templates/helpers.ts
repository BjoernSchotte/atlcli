import Handlebars from "handlebars";
import { formatDate } from "./builtins.js";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** `date` plus `n` units (d, w, m, y). Months clamp to the month end. Invalid input comes back unchanged. */
export function dateAdd(date: unknown, n: unknown, unit: unknown): unknown {
  if (typeof date !== "string") return date;
  const d = new Date(DATE_ONLY.test(date) ? `${date}T00:00:00.000Z` : date);
  const amount = Number(n);
  if (Number.isNaN(d.getTime()) || !Number.isFinite(amount)) return date;
  if (unit === "d" || unit === "w") {
    d.setUTCDate(d.getUTCDate() + amount * (unit === "w" ? 7 : 1));
  } else if (unit === "m" || unit === "y") {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + amount * (unit === "y" ? 12 : 1));
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  } else {
    return date;
  }
  return DATE_ONLY.test(date) ? d.toISOString().slice(0, 10) : d.toISOString();
}

/** Drops the options object Handlebars passes last. */
const args = (a: unknown[]) => a.slice(0, -1);

const HELPERS: Record<string, Handlebars.HelperDelegate> = {
  // {{formatDate @date "DD.MM.YYYY"}}
  formatDate: (dateStr: unknown, format: unknown) => {
    if (typeof dateStr !== "string") return "";
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return dateStr;
    return formatDate(date, typeof format === "string" ? format : "YYYY-MM-DD");
  },
  lowercase: (s: unknown) => (typeof s === "string" ? s.toLowerCase() : ""),
  uppercase: (s: unknown) => (typeof s === "string" ? s.toUpperCase() : ""),
  dateAdd: (date: unknown, n: unknown, unit: unknown) => dateAdd(date, n, unit),
  default: (value: unknown, fallback: unknown) => (value === undefined || value === null || value === "" ? fallback : value),
  replace: (s: unknown, from: unknown, to: unknown) =>
    typeof s === "string" && typeof from === "string" && from !== "" ? s.split(from).join(String(to ?? "")) : s,
  eq: (a: unknown, b: unknown) => a === b,
  ne: (a: unknown, b: unknown) => a !== b,
  and: (...a: unknown[]) => args(a).every(Boolean),
  or: (...a: unknown[]) => args(a).some(Boolean),
  not: (a: unknown) => !a,
};

export const TEMPLATE_HELPER_NAMES: readonly string[] = Object.freeze(Object.keys(HELPERS));

/** A fresh Handlebars instance with every atlcli helper; nothing from content is ever registered. */
export function createTemplateHandlebars(): typeof Handlebars {
  const hbs = Handlebars.create();
  for (const [name, helper] of Object.entries(HELPERS)) hbs.registerHelper(name, helper);
  return hbs;
}
