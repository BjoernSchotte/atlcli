import { escapeCqlValue } from "@atlcli/confluence";
import { VfsError } from "./types.js";

/** Keep ORDER BY outside the scoped predicate, respecting quoted CQL strings. */
export function scopeSearchCql(cql: string, spaces: readonly string[]): string {
  let quote = "";
  let depth = 0;
  let order = cql.length;
  for (let i = 0; i < cql.length; i++) {
    const char = cql[i]!;
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth++;
    else if (char === ")") {
      if (--depth < 0) throw new VfsError("EINVAL", "Unbalanced CQL parentheses");
    } else if (depth === 0 && /^order\s+by\b/i.test(cql.slice(i)) && (i === 0 || /\s/.test(cql[i - 1]!))) {
      order = i;
      break;
    }
  }
  if (quote || depth) throw new VfsError("EINVAL", "Unbalanced CQL expression");
  const predicate = cql.slice(0, order).trim();
  if (!predicate) throw new VfsError("EINVAL", "A CQL predicate is required");
  const scope = spaces.map((space) => `space = "${escapeCqlValue(space)}"`).join(" OR ");
  return `type = page AND (${scope}) AND (${predicate})${order < cql.length ? ` ${cql.slice(order)}` : ""}`;
}
