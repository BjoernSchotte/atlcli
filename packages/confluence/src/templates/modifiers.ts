/**
 * Template modifiers for value transformation.
 */

import type { ModifierFn, ModifierRegistry } from "./types.js";

// Date formatting tokens
const DATE_TOKENS: Record<string, (d: Date) => string> = {
  YYYY: (d) => String(d.getFullYear()),
  YY: (d) => String(d.getFullYear()).slice(-2),
  MMMM: (d) =>
    [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ][d.getMonth()],
  MMM: (d) =>
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
      d.getMonth()
    ],
  MM: (d) => String(d.getMonth() + 1).padStart(2, "0"),
  M: (d) => String(d.getMonth() + 1),
  DD: (d) => String(d.getDate()).padStart(2, "0"),
  D: (d) => String(d.getDate()),
  dddd: (d) =>
    ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getDay()],
  ddd: (d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()],
  HH: (d) => String(d.getHours()).padStart(2, "0"),
  H: (d) => String(d.getHours()),
  hh: (d) => String(d.getHours() % 12 || 12).padStart(2, "0"),
  h: (d) => String(d.getHours() % 12 || 12),
  mm: (d) => String(d.getMinutes()).padStart(2, "0"),
  m: (d) => String(d.getMinutes()),
  ss: (d) => String(d.getSeconds()).padStart(2, "0"),
  s: (d) => String(d.getSeconds()),
  A: (d) => (d.getHours() < 12 ? "AM" : "PM"),
  a: (d) => (d.getHours() < 12 ? "am" : "pm"),
  Q: (d) => String(Math.floor(d.getMonth() / 3) + 1),
};

function parseDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function formatDate(date: Date, format: string): string {
  // Use placeholders to avoid re-replacing already substituted values
  const placeholders: string[] = [];
  let result = format;

  // Sort tokens by length (longest first) to avoid partial matches
  const sortedTokens = Object.keys(DATE_TOKENS).sort((a, b) => b.length - a.length);

  // First pass: replace tokens with placeholders
  for (const token of sortedTokens) {
    result = result.replace(new RegExp(token, "g"), () => {
      const value = DATE_TOKENS[token](date);
      const placeholder = `\x00${placeholders.length}\x00`;
      placeholders.push(value);
      return placeholder;
    });
  }

  // Second pass: replace placeholders with actual values
  for (let i = 0; i < placeholders.length; i++) {
    result = result.replace(`\x00${i}\x00`, placeholders[i]);
  }

  return result;
}

// Date/Time modifiers
const date: ModifierFn = (value, format = "YYYY-MM-DD") => {
  const d = parseDate(value);
  if (!d) return String(value);
  return formatDate(d, format);
};

const relative: ModifierFn = (value) => {
  const d = parseDate(value);
  if (!d) return String(value);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  if (seconds < 60) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  if (weeks < 4) return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  return `${years} year${years === 1 ? "" : "s"} ago`;
};

const add: ModifierFn = (value, amount, unit = "days") => {
  const d = parseDate(value);
  if (!d) return String(value);
  const n = parseInt(amount, 10);
  if (isNaN(n)) return String(value);

  const result = new Date(d);
  switch (unit) {
    case "days":
    case "day":
      result.setDate(result.getDate() + n);
      break;
    case "weeks":
    case "week":
      result.setDate(result.getDate() + n * 7);
      break;
    case "months":
    case "month":
      result.setMonth(result.getMonth() + n);
      break;
    case "years":
    case "year":
      result.setFullYear(result.getFullYear() + n);
      break;
    case "hours":
    case "hour":
      result.setHours(result.getHours() + n);
      break;
    case "minutes":
    case "minute":
      result.setMinutes(result.getMinutes() + n);
      break;
  }
  return result.toISOString();
};

const subtract: ModifierFn = (value, amount, unit = "days") => {
  const n = parseInt(amount, 10);
  return add(value, String(-n), unit);
};

const startOf: ModifierFn = (value, unit = "month") => {
  const d = parseDate(value);
  if (!d) return String(value);
  const result = new Date(d);

  switch (unit) {
    case "day":
      result.setHours(0, 0, 0, 0);
      break;
    case "week":
      result.setDate(result.getDate() - result.getDay());
      result.setHours(0, 0, 0, 0);
      break;
    case "month":
      result.setDate(1);
      result.setHours(0, 0, 0, 0);
      break;
    case "year":
      result.setMonth(0, 1);
      result.setHours(0, 0, 0, 0);
      break;
  }
  return result.toISOString();
};

const endOf: ModifierFn = (value, unit = "month") => {
  const d = parseDate(value);
  if (!d) return String(value);
  const result = new Date(d);

  switch (unit) {
    case "day":
      result.setHours(23, 59, 59, 999);
      break;
    case "week":
      result.setDate(result.getDate() + (6 - result.getDay()));
      result.setHours(23, 59, 59, 999);
      break;
    case "month":
      result.setMonth(result.getMonth() + 1, 0);
      result.setHours(23, 59, 59, 999);
      break;
    case "year":
      result.setMonth(11, 31);
      result.setHours(23, 59, 59, 999);
      break;
  }
  return result.toISOString();
};

// String modifiers
const upper: ModifierFn = (value) => String(value).toUpperCase();
const lower: ModifierFn = (value) => String(value).toLowerCase();
const capitalize: ModifierFn = (value) => {
  const s = String(value);
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
};
const titleCase: ModifierFn = (value) =>
  String(value)
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");

const slug: ModifierFn = (value) =>
  String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const camelCase: ModifierFn = (value) => {
  const words = String(value).split(/[\s_-]+/);
  return words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join("");
};

const pascalCase: ModifierFn = (value) => {
  const words = String(value).split(/[\s_-]+/);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join("");
};

const kebabCase: ModifierFn = (value) =>
  String(value)
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();

const snakeCase: ModifierFn = (value) =>
  String(value)
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();

const truncate: ModifierFn = (value, length = "50", suffix = "...") => {
  const s = String(value);
  const n = parseInt(length, 10);
  if (isNaN(n) || s.length <= n) return s;
  return s.slice(0, n - suffix.length) + suffix;
};

const trim: ModifierFn = (value) => String(value).trim();

const pad: ModifierFn = (value, length = "20", char = " ") => {
  const n = parseInt(length, 10);
  return String(value).padEnd(n, char);
};

const padStart: ModifierFn = (value, length = "20", char = " ") => {
  const n = parseInt(length, 10);
  return String(value).padStart(n, char);
};

const replace: ModifierFn = (value, search = "", replacement = "") =>
  String(value).split(search).join(replacement);

const defaultVal: ModifierFn = (value, fallback = "") =>
  value === undefined || value === null || value === "" ? fallback : value;

const prefix: ModifierFn = (value, pre = "") => pre + String(value);
const suffix: ModifierFn = (value, suf = "") => String(value) + suf;

const wrap: ModifierFn = (value, left = '"', right) => {
  const r = right ?? left;
  return left + String(value) + r;
};

const repeat: ModifierFn = (value, times = "1") => {
  const n = parseInt(times, 10);
  return String(value).repeat(isNaN(n) ? 1 : n);
};

const reverse: ModifierFn = (value) => {
  if (Array.isArray(value)) return [...value].reverse();
  return String(value).split("").reverse().join("");
};

const length: ModifierFn = (value) => {
  if (Array.isArray(value)) return value.length;
  return String(value).length;
};

const substr: ModifierFn = (value, start = "0", len) => {
  const s = String(value);
  const startIdx = parseInt(start, 10);
  const length = len ? parseInt(len, 10) : undefined;
  return s.substring(startIdx, length !== undefined ? startIdx + length : undefined);
};

const split: ModifierFn = (value, separator = ",") => String(value).split(separator);

const escape: ModifierFn = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

const unescape: ModifierFn = (value) =>
  String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");

const urlEncode: ModifierFn = (value) => encodeURIComponent(String(value));
const urlDecode: ModifierFn = (value) => decodeURIComponent(String(value));

// Number modifiers
const number: ModifierFn = (value, decimals) => {
  const n = parseFloat(String(value));
  if (isNaN(n)) return String(value);
  const d = decimals ? parseInt(decimals, 10) : 0;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
};

const currency: ModifierFn = (value, currencyCode = "USD") => {
  const n = parseFloat(String(value));
  if (isNaN(n)) return String(value);
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: currencyCode,
  });
};

const percent: ModifierFn = (value, decimals = "0") => {
  const n = parseFloat(String(value));
  if (isNaN(n)) return String(value);
  const d = parseInt(decimals, 10);
  const pct = n * 100;
  return d > 0 ? `${pct.toFixed(d)}%` : `${Math.round(pct)}%`;
};

const round: ModifierFn = (value, decimals = "0") => {
  const n = parseFloat(String(value));
  if (isNaN(n)) return String(value);
  const d = parseInt(decimals, 10);
  const factor = Math.pow(10, d);
  return Math.round(n * factor) / factor;
};

const floor: ModifierFn = (value) => {
  const n = parseFloat(String(value));
  if (isNaN(n)) return String(value);
  return Math.floor(n);
};

const ceil: ModifierFn = (value) => {
  const n = parseFloat(String(value));
  if (isNaN(n)) return String(value);
  return Math.ceil(n);
};

const abs: ModifierFn = (value) => {
  const n = parseFloat(String(value));
  if (isNaN(n)) return String(value);
  return Math.abs(n);
};

const ordinal: ModifierFn = (value) => {
  const n = parseInt(String(value), 10);
  if (isNaN(n)) return String(value);
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

const bytes: ModifierFn = (value) => {
  const n = parseFloat(String(value));
  if (isNaN(n)) return String(value);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let idx = 0;
  let size = n;
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024;
    idx++;
  }
  // Format with one decimal but remove trailing .0
  const formatted = idx === 0 ? String(size) : size.toFixed(1).replace(/\.0$/, "");
  return `${formatted} ${units[idx]}`;
};

// List/Array modifiers
const join: ModifierFn = (value, separator = ", ") => {
  if (!Array.isArray(value)) return String(value);
  return value.join(separator);
};

const first: ModifierFn = (value) => {
  if (Array.isArray(value)) return value[0];
  return String(value).charAt(0);
};

const last: ModifierFn = (value) => {
  if (Array.isArray(value)) return value[value.length - 1];
  const s = String(value);
  return s.charAt(s.length - 1);
};

const nth: ModifierFn = (value, index = "0") => {
  const n = parseInt(index, 10);
  if (Array.isArray(value)) return value[n];
  return String(value).charAt(n);
};

const sort: ModifierFn = (value) => {
  if (!Array.isArray(value)) return value;
  return [...value].sort((a, b) => String(a).localeCompare(String(b)));
};

const sortBy: ModifierFn = (value, key) => {
  if (!Array.isArray(value) || !key) return value;
  return [...value].sort((a, b) => {
    const aVal = typeof a === "object" && a !== null ? (a as Record<string, unknown>)[key] : a;
    const bVal = typeof b === "object" && b !== null ? (b as Record<string, unknown>)[key] : b;
    return String(aVal).localeCompare(String(bVal));
  });
};

const unique: ModifierFn = (value) => {
  if (!Array.isArray(value)) return value;
  return [...new Set(value)];
};

const compact: ModifierFn = (value) => {
  if (!Array.isArray(value)) return value;
  return value.filter((v) => v !== null && v !== undefined && v !== "");
};

const slice: ModifierFn = (value, start = "0", end) => {
  if (!Array.isArray(value)) return value;
  const s = parseInt(start, 10);
  const e = end ? parseInt(end, 10) : undefined;
  return value.slice(s, e);
};

const shuffle: ModifierFn = (value) => {
  if (!Array.isArray(value)) return value;
  const arr = [...value];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

const sample: ModifierFn = (value) => {
  if (!Array.isArray(value)) return value;
  return value[Math.floor(Math.random() * value.length)];
};

const pluck: ModifierFn = (value, key) => {
  if (!Array.isArray(value) || !key) return value;
  return value.map((item) =>
    typeof item === "object" && item !== null ? (item as Record<string, unknown>)[key] : undefined
  );
};

const where: ModifierFn = (value, key, match) => {
  if (!Array.isArray(value) || !key) return value;
  return value.filter((item) => {
    if (typeof item !== "object" || item === null) return false;
    const val = (item as Record<string, unknown>)[key];
    if (match === undefined) return !!val;
    if (match === "true") return val === true;
    if (match === "false") return val === false;
    return String(val) === match;
  });
};

// Conditional modifiers
const or: ModifierFn = (value, fallback = "") =>
  value === undefined || value === null || value === "" || value === false ? fallback : value;

const and: ModifierFn = (value, result = "") =>
  value !== undefined && value !== null && value !== "" && value !== false ? result : value;

const not: ModifierFn = (value) => !value;

const eq: ModifierFn = (value, compare) => String(value) === compare;
const neq: ModifierFn = (value, compare) => String(value) !== compare;

const gt: ModifierFn = (value, compare) => {
  const n = parseFloat(String(value));
  const c = parseFloat(compare);
  return !isNaN(n) && !isNaN(c) && n > c;
};

const gte: ModifierFn = (value, compare) => {
  const n = parseFloat(String(value));
  const c = parseFloat(compare);
  return !isNaN(n) && !isNaN(c) && n >= c;
};

const lt: ModifierFn = (value, compare) => {
  const n = parseFloat(String(value));
  const c = parseFloat(compare);
  return !isNaN(n) && !isNaN(c) && n < c;
};

const lte: ModifierFn = (value, compare) => {
  const n = parseFloat(String(value));
  const c = parseFloat(compare);
  return !isNaN(n) && !isNaN(c) && n <= c;
};

const between: ModifierFn = (value, min, max) => {
  const n = parseFloat(String(value));
  const lo = parseFloat(min);
  const hi = parseFloat(max);
  return !isNaN(n) && !isNaN(lo) && !isNaN(hi) && n >= lo && n <= hi;
};

const inList: ModifierFn = (value, ...items) => items.includes(String(value));

const empty: ModifierFn = (value) =>
  value === undefined ||
  value === null ||
  value === "" ||
  (Array.isArray(value) && value.length === 0);

const present: ModifierFn = (value) => !empty(value);

/** Default modifier registry */
export const defaultModifiers: ModifierRegistry = {
  // Date/Time
  date,
  relative,
  add,
  subtract,
  startOf,
  endOf,

  // String
  upper,
  lower,
  capitalize,
  titleCase,
  slug,
  camelCase,
  pascalCase,
  kebabCase,
  snakeCase,
  truncate,
  trim,
  pad,
  padStart,
  replace,
  default: defaultVal,
  prefix,
  suffix,
  wrap,
  repeat,
  reverse,
  length,
  substr,
  split,
  escape,
  unescape,
  urlEncode,
  urlDecode,

  // Number
  number,
  currency,
  percent,
  round,
  floor,
  ceil,
  abs,
  ordinal,
  bytes,

  // List/Array
  join,
  first,
  last,
  nth,
  sort,
  sortBy,
  unique,
  compact,
  slice,
  shuffle,
  sample,
  pluck,
  where,

  // Conditional
  or,
  and,
  not,
  eq,
  neq,
  gt,
  gte,
  lt,
  lte,
  between,
  in: inList,
  empty,
  present,
};

/**
 * Apply a modifier to a value.
 */
export function applyModifier(
  value: unknown,
  modifierName: string,
  args: string[],
  registry: ModifierRegistry = defaultModifiers
): unknown {
  const modifier = registry[modifierName];
  if (!modifier) {
    // Unknown modifier, return value unchanged
    return value;
  }
  return modifier(value, ...args);
}

/**
 * Apply a chain of modifiers to a value.
 */
export function applyModifierChain(
  value: unknown,
  modifiers: Array<{ name: string; args: string[] }>,
  registry: ModifierRegistry = defaultModifiers
): unknown {
  let result = value;
  for (const { name, args } of modifiers) {
    result = applyModifier(result, name, args, registry);
  }
  return result;
}
