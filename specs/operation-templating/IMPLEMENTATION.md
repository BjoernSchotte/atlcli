# Operation Templating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Handlebars-based render engine, shared by copy-issues/clone,
`jira template`, `wiki page copy` (including `--tree`) and `atlcli.render()`
in scripts. It renders plain text, Jira ADF, Confluence storage XHTML and
Jira wiki markup without losing structure.

**Architecture:** The pure core lives in `packages/core/src/templates/`:
- `helpers.ts`: one Handlebars instance factory with every helper
- `builtins.ts`: `@`-data variables
- `render.ts`: tolerant rendering through an AST pre-pass that escapes
  unresolvable mustaches
- `adapters/`: text, ADF, storage and wiki markup; each splits its input into
  text units and reassembles the result without touching structure

The CLI gets one flag parser (`--var`, `--vars-file`, `--now`, `--strict`). The
script runtime gets a host-supplied `render` port operation, so the engine
never enters QuickJS. Operations render at plan time, and apply writes the
planned values.

**Tech Stack:** Bun workspaces + Turbo, TypeScript 7 (`tsc` native),
`handlebars` ^4.7.8 and `yaml` ^2.7.0 (already in `@atlcli/core`), `zod`
(script runtime), `bun:test`.

**Spec:** `specs/operation-templating/PLAN.md`. Read it first; this plan argues
from it.

## Global Constraints

- Tests: always `bun run test <file>`, never bare `bun test`. Typecheck:
  `bun run typecheck`.
- Never `bun add typescript`; no new dependencies at all (handlebars and yaml
  are already in `@atlcli/core`).
- `@atlcli/core` render code must be browser-safe: no `node:`/`bun:` imports in
  `render.ts`, `helpers.ts`, `builtins.ts` or `adapters/*`. Export them from
  `src/index.browser.ts`; the CI browser-build gate enforces this.
- Output limit: **1 MB per unit, 16 MB per run** (fixed defaults).
- `--replace` stays as legacy indefinitely, applied **before** rendering, with
  no deprecation warning.
- The variable listing command is **`atlcli template vars`**, a new top-level
  namespace.
- Unresolved `{{…}}` is **tolerant**: it stays literal and produces a warning.
  `--strict` turns every warning into a failure.
- Never rendered: ADF `codeBlock` and `code` marks; storage `<code>`, `<pre>`,
  `ac:plain-text-body`, `code`/`noformat` macros; wiki markup `{code}` and
  `{noformat}`.
- `wiki template` behaviour must not change: its existing tests pass
  unchanged, and Markdown keeps rendering code fences.
- Render happens at plan time. `@now` is frozen in the plan; apply never
  renders.
- No prompts with `--json`, without a TTY, or with `--yes`; fail with the list
  of missing variables instead.
- Commits: Conventional Commits, each ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Git in this worktree: `/usr/bin/git` with plain commands (no `git -C`,
  no compound shell constructs).
- Docs and `skills/atlcli/` change in the same PR as the behaviour.
- E2E sites:
  - Jira copy E2E: profile `kiteweave` with temporary projects, deleted
    afterwards; never touch `KAN`.
  - Confluence: profile `mayflower`, space `DOCSY` only.
  - Jira single issues: profile `mayflower`, project `ATLCLI` only.
  - Clean up everything.
- One PR for all of it, with the logical commits below.

## Review Focus

1. **Non-template content passing through a copy**: an issue or page with
   Jinja/Helm/Ansible snippets (`{{ item.name }}`, `{{ .Values.x }}`,
   `{{ x | default('a') }}`) must come out byte-identical, plus warnings.
   Test: Task 2 (`keeps Jinja and Helm snippets literal`) and Task 4
   (`round-trips a Jinja description unchanged apart from warnings`).
2. **Input without any `{{`** must return the identical object or string, even
   with entities, CDATA and odd whitespace in storage. Test: Task 4
   (`returns the same object`) and Task 6 (`keeps bytes of a page without
   placeholders`).
3. **Values containing markup** (`<`, `&`, `"`, `]]>`) inserted into storage
   must be escaped, and in ADF must not create nodes. Test: Task 6
   (`escapes a value with markup`) and Task 4 (`inserts markup as plain
   text`).
4. **Empty text after rendering** (a variable rendering to `""` that empties a
   text node or a whole summary). ADF forbids empty text nodes, and Jira
   rejects an empty summary. Test: Task 4 (`drops text nodes that render
   empty`) and Task 3 (`rejects an empty summary`).
5. **Re-plan determinism**: two plans with the same `--now` and vars must
   produce identical operations, including `@uuid`. Test: Task 9
   (`same --now gives the same plan`). `@uuid` is derived from `now` plus the
   unit, see Task 1.

---

## File Structure

**Create:**
- `packages/core/src/templates/helpers.ts`: `createTemplateHandlebars()`, all helpers
- `packages/core/src/templates/render.ts`: `renderText`, `renderSegments`, `evaluateExpression`, scope, budget, warnings, errors
- `packages/core/src/templates/adapters/text.ts`: `renderTextField`, `checkFieldValue`
- `packages/core/src/templates/adapters/runs.ts`: shared distribution of rendered segments over inline pieces
- `packages/core/src/templates/adapters/adf.ts`: `renderAdf`
- `packages/core/src/templates/adapters/storage.ts`: `renderStorage` (offset tokenizer)
- `packages/core/src/templates/adapters/wikimarkup.ts`: `renderWikiMarkup`
- `packages/core/src/templates/adapters/index.ts`: `renderBody` (format dispatch), `collectVariables`
- `packages/core/src/templates/vars-file.ts`: `parseVarsFile`, `resolveTemplateValues`
- tests next to each: `*.test.ts`
- `apps/cli/src/commands/template-flags.ts` (+ test): CLI flag parsing and prompting
- `apps/cli/src/commands/template-vars.ts` (+ test): `atlcli template vars`
- `apps/cli/src/builtin-scripts/copy-pages.script` (+ `copy-pages.test.ts`)
- `src/content/docs/templating.md`

**Modify:**
- `packages/core/src/templates/builtins.ts`, `engine.ts`, `index.ts`, `packages/core/src/index.browser.ts`
- `packages/script-runtime/src/port.ts`, `verbs.ts`, `sandbox.ts`, `plan.ts`, `script-types.ts`
- `apps/cli/src/commands/script.ts`, `script-port.ts`, `jira.ts`, `page.ts`, `template.ts`, `docs.ts`
- `apps/cli/src/builtin-scripts/copy-issues.script`, `copy-issues.test.ts`
- `apps/cli/src/index.ts`, `root-commands.ts`, `completions.ts`, `assets.d.ts` (already declares `*.script`; no change expected)
- `packages/jira/src/templates.ts`
- `packages/confluence/src/client.ts` (attachment copy and content properties, if missing)
- Docs: `jira/copy-issues.md`, `jira/templates.md`, `jira/issues.md`, `confluence/pages.md`, `confluence/templates.md`, `reference/scripts.md`, `reference/cli-commands.md`, `astro.config.mjs`
- Skill: `skills/atlcli/references/{jira-issues,confluence-pages,confluence-templates,scripts}.md`
- `packages/core/etc/*.api.md`, `packages/script-runtime/etc/*.api.md` (via `bun scripts/api-report.ts --update`)
- Spec `specs/operation-templating/PLAN.md` "Implementation notes" (Task 16)

---

### Task 1: Shared helpers and built-ins

**Files:**
- Create: `packages/core/src/templates/helpers.ts`, `packages/core/src/templates/helpers.test.ts`
- Modify: `packages/core/src/templates/builtins.ts`, `packages/core/src/templates/engine.ts:21-51,132-136`

**Interfaces:**
- Produces:
  - `createTemplateHandlebars(): typeof Handlebars`, a fresh instance with `formatDate`, `lowercase`, `uppercase`, `dateAdd`, `default`, `replace`, `eq`, `ne`, `and`, `or`, `not` registered
  - `TEMPLATE_HELPER_NAMES: readonly string[]`
  - `getBuiltinVariables(ctx: BuiltinContext): Record<string, unknown>`, now honouring `ctx.now?: Date` and `ctx.project?: string`, and adding `today`, `now`, `quarter`, `week`, `project`
  - `uuid` deterministic when `ctx.now` is given (see Review Focus 5)

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/src/templates/helpers.test.ts
import { describe, expect, test } from "bun:test";
import { createTemplateHandlebars, TEMPLATE_HELPER_NAMES } from "./helpers.js";
import { getBuiltinVariables } from "./builtins.js";

const run = (src: string, ctx: unknown = {}, data: Record<string, unknown> = {}) =>
  createTemplateHandlebars().compile(src, { noEscape: true })(ctx, { data });

describe("template helpers", () => {
  test("registers exactly the documented helpers", () => {
    expect([...TEMPLATE_HELPER_NAMES].sort()).toEqual(
      ["and", "dateAdd", "default", "eq", "formatDate", "lowercase", "ne", "not", "or", "replace", "uppercase"],
    );
  });
  test("dateAdd days, weeks, years", () => {
    expect(run('{{dateAdd "2026-12-30" 3 "d"}}')).toBe("2027-01-02");
    expect(run('{{dateAdd "2026-10-25" 2 "w"}}')).toBe("2026-11-08");
    expect(run('{{dateAdd "2028-02-29" 1 "y"}}')).toBe("2029-02-28");
  });
  test("dateAdd months clamps to the month end", () => {
    expect(run('{{dateAdd "2026-01-31" 1 "m"}}')).toBe("2026-02-28");
    expect(run('{{dateAdd "2026-11-30" 3 "m"}}')).toBe("2027-02-28");
  });
  test("dateAdd keeps an ISO datetime a datetime", () => {
    expect(run('{{dateAdd "2026-10-25T10:00:00.000Z" -1 "d"}}')).toBe("2026-10-24T10:00:00.000Z");
  });
  test("dateAdd on an invalid date returns the input unchanged", () => {
    expect(run('{{dateAdd "soon" 1 "d"}}')).toBe("soon");
  });
  test("default, replace", () => {
    expect(run('{{default x "fallback"}}', { x: "" })).toBe("fallback");
    expect(run('{{default x "fallback"}}', { x: "set" })).toBe("set");
    expect(run('{{replace s "2025" "2026"}}', { s: "Audit 2025 / 2025" })).toBe("Audit 2026 / 2026");
  });
  test("comparison helpers in if", () => {
    expect(run('{{#if (eq a "x")}}y{{else}}n{{/if}}', { a: "x" })).toBe("y");
    expect(run('{{#if (ne a "x")}}y{{else}}n{{/if}}', { a: "x" })).toBe("n");
    expect(run("{{#if (and a b c)}}y{{else}}n{{/if}}", { a: 1, b: 1, c: 0 })).toBe("n");
    expect(run("{{#if (or a b)}}y{{else}}n{{/if}}", { a: 0, b: "1" })).toBe("y");
    expect(run("{{#if (not a)}}y{{else}}n{{/if}}", { a: false })).toBe("y");
  });
});

describe("built-ins", () => {
  const now = new Date("2026-10-25T08:30:00.000Z");
  test("new built-ins with a fixed now", () => {
    const b = getBuiltinVariables({ now, project: "AUD" });
    expect(b.today).toBe(b.date);
    expect(b.now).toBe("2026-10-25T08:30:00.000Z");
    expect(b.datetime).toBe(b.now);
    expect(b.quarter).toBe("4");
    expect(b.week).toBe("43");
    expect(b.project).toBe("AUD");
  });
  test("ISO week at the year boundary", () => {
    expect(getBuiltinVariables({ now: new Date("2027-01-01T12:00:00Z") }).week).toBe("53");
  });
  test("uuid is stable for the same now and differs for another", () => {
    const a = getBuiltinVariables({ now }).uuid;
    expect(getBuiltinVariables({ now }).uuid).toBe(a);
    expect(getBuiltinVariables({ now: new Date("2026-10-26T00:00:00Z") }).uuid).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun run test packages/core/src/templates/helpers.test.ts`
Expected: FAIL, `Cannot find module './helpers.js'`

- [ ] **Step 3: Implement `helpers.ts`**

```ts
// packages/core/src/templates/helpers.ts
import Handlebars from "handlebars";
import { formatDate } from "./builtins.js";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** `date` plus `n` units (d, w, m, y). Months clamp to the month end. Invalid input comes back unchanged. */
export function dateAdd(date: unknown, n: unknown, unit: unknown): unknown {
  if (typeof date !== "string") return date;
  const d = new Date(DATE_ONLY.test(date) ? `${date}T00:00:00.000Z` : date);
  const amount = Number(n);
  if (Number.isNaN(d.getTime()) || !Number.isFinite(amount)) return date;
  if (unit === "d" || unit === "w") d.setUTCDate(d.getUTCDate() + amount * (unit === "w" ? 7 : 1));
  else if (unit === "m" || unit === "y") {
    const months = amount * (unit === "y" ? 12 : 1);
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + months);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  } else return date;
  return DATE_ONLY.test(date) ? d.toISOString().slice(0, 10) : d.toISOString();
}

const args = (a: unknown[]) => a.slice(0, -1); // drop Handlebars' options object

const HELPERS: Record<string, Handlebars.HelperDelegate> = {
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
```

- [ ] **Step 4: Extend `builtins.ts`**

Remove `import { randomUUID } from "node:crypto"`. Add to `BuiltinContext`:
`now?: Date; project?: string;`. Replace the body of `getBuiltinVariables`
and append the new names to `BUILTIN_VARIABLE_NAMES`:

```ts
/** ISO 8601 week number of `d` (local calendar). */
function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

/** RFC 4122 v4 layout. Derived from `seed` (FNV-1a) when one is given, so a re-plan with the same --now repeats it. */
function uuid(seed?: string): string {
  if (seed === undefined) return globalThis.crypto.randomUUID();
  const hex: string[] = [];
  let h = 0x811c9dc5;
  for (let round = 0; hex.join("").length < 32; round++) {
    for (const ch of `${seed}#${round}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    hex.push(h.toString(16).padStart(8, "0"));
  }
  const s = hex.join("").slice(0, 32).split("");
  s[12] = "4";
  s[16] = "89ab"[parseInt(s[16]!, 16) & 3]!;
  const j = s.join("");
  return `${j.slice(0, 8)}-${j.slice(8, 12)}-${j.slice(12, 16)}-${j.slice(16, 20)}-${j.slice(20)}`;
}

export function getBuiltinVariables(ctx: BuiltinContext): Record<string, unknown> {
  const now = ctx.now ?? new Date();
  const dateFormat = ctx.dateFormat ?? "YYYY-MM-DD";
  const iso = now.toISOString();
  return {
    date: formatDate(now, dateFormat),
    today: formatDate(now, "YYYY-MM-DD"),
    datetime: iso,
    now: iso,
    time: formatDate(now, "HH:mm"),
    year: now.getFullYear().toString(),
    month: (now.getMonth() + 1).toString().padStart(2, "0"),
    day: now.getDate().toString().padStart(2, "0"),
    weekday: WEEKDAYS[now.getDay()],
    quarter: String(Math.floor(now.getMonth() / 3) + 1),
    week: String(isoWeek(now)).padStart(2, "0"),
    user: ctx.user ?? "",
    space: ctx.space ?? "",
    profile: ctx.profile ?? "",
    project: ctx.project ?? "",
    title: ctx.title ?? "",
    parent: { id: ctx.parentId ?? "", title: ctx.parentTitle ?? "" },
    uuid: uuid(ctx.now ? iso : undefined),
  };
}
```

Note: `@today` deliberately ignores `dateFormat`, so `dateAdd @today 14 "d"`
always gets ISO input.

- [ ] **Step 5: Make `engine.ts` use the shared helpers**

In `TemplateEngine`, delete `registerHelpers()` and the three
`hbs.registerHelper("formatDate"|"lowercase"|"uppercase", …)` lines. Replace
`const hbs = Handlebars.create();` with `const hbs = createTemplateHandlebars();`.
The constructor no longer needs `this.handlebars`, but keep it if
`checkHandlebarsSyntax` or `validate` use it; in that case set
`this.handlebars = createTemplateHandlebars()`. The per-variable inline-default
helpers (`{{var "default"}}`) stay in `engine.ts`; they are wiki-template
behaviour.

- [ ] **Step 6: Run the new and the existing template tests**

Run: `bun run test packages/core/src/templates/`
Expected: PASS, including the untouched `templates.test.ts` and `storage.test.ts`.

- [ ] **Step 7: Commit**

```bash
/usr/bin/git add packages/core/src/templates/helpers.ts packages/core/src/templates/helpers.test.ts packages/core/src/templates/builtins.ts packages/core/src/templates/engine.ts
/usr/bin/git commit -m "feat(core): shared template helpers and built-ins (@today, @now, @quarter, @week, @project)"
```

---

### Task 2: Tolerant render core

**Files:**
- Create: `packages/core/src/templates/render.ts`, `packages/core/src/templates/render.test.ts`

**Interfaces:**
- Consumes: `createTemplateHandlebars()`, `TEMPLATE_HELPER_NAMES`, `getBuiltinVariables()` (Task 1)
- Produces:

```ts
export interface TemplateScope { context: unknown; data: Record<string, unknown> }
export type RenderWarningCode =
  | "unresolved" | "parse-error" | "unknown-helper" | "unsupported"
  | "unbalanced-block" | "crosses-inline-node" | "invalid-url" | "unused-variable" | "not-rendered-field";
export interface RenderWarning { code: RenderWarningCode; message: string; unit?: string; line?: number; column?: number }
export class RenderError extends Error { readonly warnings: RenderWarning[] }
export class RenderBudget { constructor(perUnit?: number, perRun?: number); charge(chars: number, unit?: string): void }
export interface RenderOptions { unit?: string; strict?: boolean; budget?: RenderBudget }
export interface Segment { start: number; end: number; output: string }
export function createTemplateScope(input: {
  vars?: Record<string, unknown>; now?: Date; user?: string; profile?: string; space?: string; project?: string;
  source?: unknown; parent?: unknown;
}): TemplateScope
export function childScope(scope: TemplateScope, context: unknown, data?: Record<string, unknown>): TemplateScope
export function renderSegments(source: string, scope: TemplateScope, opts?: RenderOptions): { segments: Segment[]; warnings: RenderWarning[] }
export function renderText(source: string, scope: TemplateScope, opts?: RenderOptions): { text: string; warnings: RenderWarning[] }
export function evaluateExpression(expr: string, scope: TemplateScope, opts?: RenderOptions): { value: unknown; warnings: RenderWarning[] }
export function finish<T>(value: T, warnings: RenderWarning[], opts?: RenderOptions): { value: T; warnings: RenderWarning[] } // throws RenderError when strict and warnings exist
```

`budget` default: `new RenderBudget(1_000_000, 16_000_000)` per call when none
is passed. Operations pass one shared budget per run.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/src/templates/render.test.ts
import { describe, expect, test } from "bun:test";
import { childScope, createTemplateScope, evaluateExpression, RenderBudget, RenderError, renderSegments, renderText } from "./render.js";

const now = new Date("2026-10-25T08:30:00.000Z");
const scope = createTemplateScope({ vars: { year: 2026, customer: "ACME", systems: ["IAM", "Backup"] }, now, source: { key: "TPL-1", summary: "Check" } });
const r = (src: string, opts = {}) => renderText(src, scope, opts);

describe("renderText", () => {
  test("variables, operation context and built-ins", () => {
    expect(r("Audit {{year}} for {{customer}}: {{source.key}} on {{@today}}").text).toBe("Audit 2026 for ACME: TPL-1 on 2026-10-25");
    expect(r("{{#each systems}}{{@index}}={{this}} {{/each}}").text).toBe("0=IAM 1=Backup ");
    expect(r("{{dateAdd @today 7 \"d\"}}").text).toBe("2026-11-01");
  });
  test("text without {{ is returned unchanged with no warnings", () => {
    expect(r("plain & <text>")).toEqual({ text: "plain & <text>", warnings: [] });
  });
  test("an unknown path stays literal with a positioned warning", () => {
    const out = r("Hi {{custmer}}!\nBye {{a.b}}", { unit: "summary" });
    expect(out.text).toBe("Hi {{custmer}}!\nBye {{a.b}}");
    expect(out.warnings.map((w) => [w.code, w.unit, w.line, w.column])).toEqual([
      ["unresolved", "summary", 1, 3],
      ["unresolved", "summary", 2, 4],
    ]);
  });
  test("an unknown helper call stays literal", () => {
    expect(r('{{shout customer "!"}}').text).toBe('{{shout customer "!"}}');
    expect(r('{{shout customer "!"}}').warnings[0]!.code).toBe("unknown-helper");
  });
  test("an unknown block helper stays literal in full, including else", () => {
    const src = "{{#loop systems}}x{{else}}y{{/loop}}";
    expect(r(src).text).toBe(src);
  });
  test("if on an unknown path is falsy and warns", () => {
    const out = r("{{#if nope}}a{{else}}b{{/if}}");
    expect(out.text).toBe("b");
    expect(out.warnings[0]!.code).toBe("unresolved");
  });
  test("a parse error keeps the whole unit literal", () => {
    const src = "{{ x | default('a') }} and {{year}}";
    const out = r(src);
    expect(out.text).toBe(src);
    expect(out.warnings.map((w) => w.code)).toEqual(["parse-error"]);
  });
  test("keeps Jinja and Helm snippets literal", () => {
    for (const src of ["{{ item.name }}", "{{ .Values.image.tag }}", "{% if x %}{{ y }}{% endif %}"]) {
      expect(r(src).text).toBe(src);
    }
  });
  test("an escaped mustache stays literal without a backslash", () => {
    expect(r("\\{{year}} is {{year}}").text).toBe("{{year}} is 2026");
  });
  test("triple stash renders unescaped like double", () => {
    expect(renderText("{{{v}}}", createTemplateScope({ vars: { v: "<b>" } })).text).toBe("<b>");
  });
  test("partials and decorators are not supported", () => {
    const out = r("{{> header}}");
    expect(out.text).toBe("{{> header}}");
    expect(out.warnings[0]!.code).toBe("unsupported");
  });
  test("prototype access is blocked", () => {
    expect(r("{{constructor.constructor}}").text).toBe("{{constructor.constructor}}");
    expect(r("{{__proto__}}").text).toBe("{{__proto__}}");
    expect(r("{{year.constructor}}").text).toBe("{{year.constructor}}");
  });
  test("strict turns warnings into a RenderError", () => {
    expect(() => r("{{nope}}", { strict: true })).toThrow(RenderError);
  });
  test("output limit per unit and per run", () => {
    const big = createTemplateScope({ vars: { xs: Array.from({ length: 2000 }, () => "x".repeat(1000)) } });
    expect(() => renderText("{{#each xs}}{{this}}{{/each}}", big)).toThrow(/output limit/);
    const budget = new RenderBudget(1_000_000, 1500);
    renderText("{{year}}".repeat(100), scope, { budget });
    expect(() => renderText("x".repeat(1000) + "{{year}}", scope, { budget })).toThrow(/output limit/);
  });
  test("paths inside each and with resolve against the item", () => {
    const s = createTemplateScope({ vars: { rows: [{ name: "a" }, { name: "b" }], year: 1 } });
    expect(renderText("{{#each rows}}{{name}}{{@root.year}}{{/each}}", s).text).toBe("a1b1");
  });
});

describe("renderSegments", () => {
  test("one segment per top-level statement with source offsets", () => {
    const { segments } = renderSegments("a {{year}} b", scope);
    expect(segments).toEqual([
      { start: 0, end: 2, output: "a " },
      { start: 2, end: 10, output: "2026" },
      { start: 10, end: 12, output: " b" },
    ]);
  });
});

describe("evaluateExpression", () => {
  test("returns typed values", () => {
    expect(evaluateExpression("systems", scope).value).toEqual(["IAM", "Backup"]);
    expect(evaluateExpression('(eq customer "ACME")', scope).value).toBe(true);
  });
  test("unknown path is undefined with a warning", () => {
    const out = evaluateExpression("nope", scope);
    expect(out.value).toBeUndefined();
    expect(out.warnings[0]!.code).toBe("unresolved");
  });
  test("childScope exposes @root and loop data", () => {
    const c = childScope(scope, "IAM", { index: 0, first: true, last: false });
    expect(renderText("{{this}}/{{@index}}/{{@root.customer}}", c).text).toBe("IAM/0/ACME");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun run test packages/core/src/templates/render.test.ts`
Expected: FAIL, `Cannot find module './render.js'`

- [ ] **Step 3: Implement `render.ts`**

```ts
// packages/core/src/templates/render.ts
import type Handlebars from "handlebars";
import { getBuiltinVariables } from "./builtins.js";
import { createTemplateHandlebars, TEMPLATE_HELPER_NAMES } from "./helpers.js";

type AST = typeof Handlebars.AST;
type Node = hbs.AST.Node;
type Stmt = hbs.AST.Statement;

// (interfaces and types exactly as listed under "Produces")

export class RenderError extends Error {
  constructor(message: string, readonly warnings: RenderWarning[] = []) {
    super(message);
    this.name = "RenderError";
  }
}

export class RenderBudget {
  private used = 0;
  constructor(readonly perUnit = 1_000_000, readonly perRun = 16_000_000) {}
  charge(chars: number, unit?: string): void {
    if (chars > this.perUnit) throw new RenderError(`Template output limit exceeded in ${unit ?? "a value"} (${chars} > ${this.perUnit} characters)`);
    this.used += chars;
    if (this.used > this.perRun) throw new RenderError(`Template output limit exceeded for this run (${this.used} > ${this.perRun} characters)`);
  }
}

const BLOCK_SCOPING = new Set(["each", "with"]);
const BLOCK_BUILTINS = new Set(["if", "unless", "each", "with"]);
const HELPERS = new Set(TEMPLATE_HELPER_NAMES);

export function createTemplateScope(input: { vars?: Record<string, unknown>; now?: Date; user?: string; profile?: string; space?: string; project?: string; source?: unknown; parent?: unknown } = {}): TemplateScope {
  const context: Record<string, unknown> = { ...(input.vars ?? {}) };
  if (input.source !== undefined) context.source = input.source;
  if (input.parent !== undefined) context.parent = input.parent;
  const data = getBuiltinVariables({ now: input.now, user: input.user, profile: input.profile, space: input.space, project: input.project });
  return { context, data: { ...data, root: context } };
}

export function childScope(scope: TemplateScope, context: unknown, data: Record<string, unknown> = {}): TemplateScope {
  return { context, data: { ...scope.data, ...data } };
}

/** Own-property walk; never reaches the prototype chain. */
function lookup(base: unknown, parts: string[]): { found: boolean; value: unknown } {
  let value = base;
  for (const part of parts) {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return { found: false, value: undefined };
    if (!Object.prototype.hasOwnProperty.call(value, part)) return { found: false, value: undefined };
    value = (value as Record<string, unknown>)[part];
  }
  return { found: true, value };
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
  return starts;
}

interface Analysis { escapes: Array<[number, number]>; warnings: RenderWarning[] }

/**
 * Finds statements that cannot resolve and the source ranges to escape so
 * Handlebars prints them literally. `scoped` is true inside each/with bodies,
 * where plain paths refer to the item and are not checked statically.
 */
function analyze(program: hbs.AST.Program, source: string, scope: TemplateScope, unit: string | undefined): Analysis {
  const starts = lineStarts(source);
  const offset = (p: hbs.AST.Position) => starts[p.line - 1]! + p.column;
  const out: Analysis = { escapes: [], warnings: [] };
  const warn = (code: RenderWarningCode, node: Node, message: string) =>
    out.warnings.push({ code, message, unit, line: node.loc.start.line, column: node.loc.start.column });
  const escape = (node: Node) => out.escapes.push([offset(node.loc.start), offset(node.loc.end)]);

  const resolves = (expr: hbs.AST.Expression, scoped: boolean): boolean => {
    if (expr.type === "SubExpression") {
      const sub = expr as hbs.AST.SubExpression;
      const name = (sub.path as hbs.AST.PathExpression).original;
      return HELPERS.has(name) && sub.params.every((p) => resolves(p, scoped));
    }
    if (expr.type !== "PathExpression") return true; // literals
    const path = expr as hbs.AST.PathExpression;
    if (path.data) {
      const [head, ...rest] = path.parts;
      if (head === "root") return lookup(scope.data.root, rest).found;
      if (scoped && ["index", "key", "first", "last"].includes(head!)) return true;
      return lookup(scope.data, path.parts).found;
    }
    if (scoped || path.depth > 0) return true;
    if (path.parts.length === 0) return true; // this
    return lookup(scope.context, path.parts).found;
  };

  const walk = (body: Stmt[], scoped: boolean) => {
    for (const stmt of body) {
      switch (stmt.type) {
        case "MustacheStatement": {
          const m = stmt as hbs.AST.MustacheStatement;
          const isCall = m.params.length > 0 || (m.hash?.pairs.length ?? 0) > 0;
          const name = m.path.type === "PathExpression" ? (m.path as hbs.AST.PathExpression).original : "";
          if (isCall) {
            if (!HELPERS.has(name)) { warn("unknown-helper", m, `Unknown helper "${name}"`); escape(m); }
            else if (!m.params.every((p) => resolves(p, scoped))) { warn("unresolved", m, `Unresolved value in {{${name} …}}`); escape(m); }
          } else if (!HELPERS.has(name) && !resolves(m.path, scoped)) {
            warn("unresolved", m, `Unresolved {{${name}}}`);
            escape(m);
          }
          break;
        }
        case "BlockStatement": {
          const b = stmt as hbs.AST.BlockStatement;
          const name = (b.path as hbs.AST.PathExpression).original;
          if (!BLOCK_BUILTINS.has(name)) { warn("unknown-helper", b, `Unknown block helper "#${name}"`); escape(b); break; }
          const subject = b.params[0];
          if (subject && !resolves(subject, scoped)) warn("unresolved", b, `Unresolved {{#${name}}} subject; treated as empty`);
          walk(b.program.body, scoped || BLOCK_SCOPING.has(name));
          if (b.inverse) walk(b.inverse.body, scoped);
          break;
        }
        case "PartialStatement":
        case "PartialBlockStatement":
        case "DecoratorBlock":
        case "Decorator":
          warn("unsupported", stmt, "Partials and decorators are not supported");
          escape(stmt);
          break;
        default:
          break; // ContentStatement, CommentStatement
      }
    }
  };
  walk(program.body, false);
  return out;
}

/** Puts a backslash before every unescaped `{{` inside the ranges, so Handlebars prints them. */
function applyEscapes(source: string, ranges: Array<[number, number]>): string {
  const points = new Set<number>();
  for (const [start, end] of ranges) {
    for (let i = source.indexOf("{{", start); i !== -1 && i < end; i = source.indexOf("{{", i + 2)) {
      if (source[i - 1] !== "\\") points.add(i);
    }
  }
  let out = "";
  let last = 0;
  for (const p of [...points].sort((a, b) => a - b)) {
    out += source.slice(last, p) + "\\";
    last = p;
  }
  return out + source.slice(last);
}

function parse(hbs: typeof Handlebars, source: string): hbs.AST.Program | Error {
  try {
    return hbs.parse(source);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function renderOne(hbs: typeof Handlebars, source: string, scope: TemplateScope, unit: string | undefined): { text: string; warnings: RenderWarning[] } {
  const program = parse(hbs, source);
  if (program instanceof Error) {
    return { text: source, warnings: [{ code: "parse-error", message: program.message.split("\n")[0]!, unit }] };
  }
  const { escapes, warnings } = analyze(program, source, scope, unit);
  const template = hbs.compile(applyEscapes(source, escapes), { noEscape: true, strict: false });
  return { text: template(scope.context, { data: scope.data }), warnings };
}

export function finish<T>(value: T, warnings: RenderWarning[], opts: RenderOptions = {}): { value: T; warnings: RenderWarning[] } {
  if (opts.strict && warnings.length > 0) {
    throw new RenderError(`Template warnings with --strict: ${warnings.map((w) => w.message).join("; ")}`, warnings);
  }
  return { value, warnings };
}

export function renderSegments(source: string, scope: TemplateScope, opts: RenderOptions = {}): { segments: Segment[]; warnings: RenderWarning[] } {
  const budget = opts.budget ?? new RenderBudget();
  const whole = (warnings: RenderWarning[]) => {
    budget.charge(source.length, opts.unit);
    finish(null, warnings, opts); // throws when strict
    return { segments: [{ start: 0, end: source.length, output: source }], warnings };
  };
  if (!source.includes("{{")) return whole([]);
  const hbs = createTemplateHandlebars();
  const program = parse(hbs, source);
  if (program instanceof Error) return whole([{ code: "parse-error", message: program.message.split("\n")[0]!, unit: opts.unit }]);
  const starts = lineStarts(source);
  const offset = (p: hbs.AST.Position) => starts[p.line - 1]! + p.column;
  const segments: Segment[] = [];
  const warnings: RenderWarning[] = [];
  let cursor = 0;
  let total = 0;
  for (const stmt of program.body) {
    const start = cursor;
    const end = stmt.type === "ContentStatement" ? nextStart(program.body, stmt, source, offset) : offset(stmt.loc.end);
    const slice = source.slice(start, end);
    const one = renderOne(hbs, slice, scope, opts.unit);
    // Re-base positions onto the whole unit.
    const base = lineStarts(source.slice(0, start));
    for (const w of one.warnings) {
      if (w.line !== undefined) {
        if (w.line === 1) w.column = (w.column ?? 0) + (start - base[base.length - 1]!);
        w.line += base.length - 1;
      }
    }
    warnings.push(...one.warnings);
    segments.push({ start, end, output: one.text });
    total += one.text.length;
    if (total > budget.perUnit) budget.charge(total, opts.unit);
    cursor = end;
  }
  if (cursor < source.length) segments.push({ start: cursor, end: source.length, output: source.slice(cursor) });
  budget.charge(total, opts.unit);
  finish(null, warnings, opts); // throws when strict
  return { segments, warnings };
}
```

`nextStart` returns the start offset of the statement after `stmt`, or
`source.length`. Handlebars' ContentStatement `loc.end` excludes stripped
whitespace when `~` is used, so the next statement's start is the reliable
boundary:

```ts
function nextStart(body: Stmt[], stmt: Stmt, source: string, offset: (p: hbs.AST.Position) => number): number {
  const next = body[body.indexOf(stmt) + 1];
  return next ? offset(next.loc.start) : source.length;
}
```

`renderText` and `evaluateExpression`:

```ts
export function renderText(source: string, scope: TemplateScope, opts: RenderOptions = {}): { text: string; warnings: RenderWarning[] } {
  const { segments, warnings } = renderSegments(source, scope, opts);
  return { text: segments.map((s) => s.output).join(""), warnings };
}

const CAPTURE = "__atlcliCapture";

export function evaluateExpression(expr: string, scope: TemplateScope, opts: RenderOptions = {}): { value: unknown; warnings: RenderWarning[] } {
  const hbs = createTemplateHandlebars();
  const program = parse(hbs, `{{${CAPTURE} ${expr}}}`);
  if (program instanceof Error) return finish(undefined, [{ code: "parse-error", message: program.message.split("\n")[0]!, unit: opts.unit }], opts);
  const mustache = program.body[0] as hbs.AST.MustacheStatement;
  // Analyse the argument as a standalone mustache so unknown paths warn and yield undefined.
  const probe = parse(hbs, `{{${expr}}}`);
  const warnings = probe instanceof Error ? [] : analyze(probe, `{{${expr}}}`, scope, opts.unit).warnings;
  if (warnings.length > 0) return finish(undefined, warnings, opts);
  let value: unknown;
  hbs.registerHelper(CAPTURE, (v: unknown) => { value = v; return ""; });
  hbs.compile(`{{${CAPTURE} ${expr}}}`, { noEscape: true })(scope.context, { data: scope.data });
  void mustache;
  return finish(value, [], opts);
}
```

`{{${expr}}}` with `expr = "(eq customer \"ACME\")"` parses as a mustache
whose path is a SubExpression. Make `analyze`'s MustacheStatement case treat
`m.path.type === "SubExpression"` through `resolves(m.path, scoped)`, with
`name` set to the subexpression's helper name.

- [ ] **Step 4: Run the tests**

Run: `bun run test packages/core/src/templates/render.test.ts`
Expected: PASS. If `\{{{v}}}` or `~` cases behave differently than the tests
assume, adjust the implementation, not the tests. The tests encode the spec.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add packages/core/src/templates/render.ts packages/core/src/templates/render.test.ts
/usr/bin/git commit -m "feat(core): tolerant Handlebars render core with budget and strict mode"
```

---

### Task 3: Text adapter and field checks

**Files:**
- Create: `packages/core/src/templates/adapters/text.ts`, `packages/core/src/templates/adapters/text.test.ts`

**Interfaces:**
- Consumes: `renderText`, `RenderOptions`, `RenderWarning`, `RenderError`, `TemplateScope` (Task 2)
- Produces:

```ts
export type FieldKind = "summary" | "label" | "string" | "number" | "date" | "option" | "name";
export function checkFieldValue(kind: FieldKind, value: string, unit: string): void // throws RenderError
export function renderTextField(value: string, kind: FieldKind, scope: TemplateScope, opts: RenderOptions & { unit: string }): { value: string; warnings: RenderWarning[] }
export function renderJiraFieldValue(value: unknown, schemaType: string | undefined, scope: TemplateScope, opts: RenderOptions & { unit: string }): { value: unknown; warnings: RenderWarning[] }
```

`renderJiraFieldValue` handles the custom-field shapes:
- a string becomes `"string"`
- a number stays as it is
- `{ value }` is an option, rendered by name
- `{ name }` is a version or component
- an array maps each element
- anything else is returned unchanged with a `not-rendered-field` info warning,
  but only if `JSON.stringify(value)` contains `{{`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/src/templates/adapters/text.test.ts
import { describe, expect, test } from "bun:test";
import { createTemplateScope, RenderError } from "../render.js";
import { checkFieldValue, renderJiraFieldValue, renderTextField } from "./text.js";

const scope = createTemplateScope({ vars: { year: 2026, empty: "", team: "ops team" } });
const opts = { unit: "TPL-1 summary" };

describe("text adapter", () => {
  test("renders a summary", () => {
    expect(renderTextField("Audit {{year}}", "summary", scope, opts).value).toBe("Audit 2026");
  });
  test("rejects an empty summary", () => {
    expect(() => renderTextField("{{empty}}", "summary", scope, opts)).toThrow(RenderError);
  });
  test("rejects a label with whitespace", () => {
    expect(() => renderTextField("{{team}}", "label", scope, { unit: "labels" })).toThrow(/whitespace/);
  });
  test("number and date fields are checked after rendering", () => {
    expect(() => checkFieldValue("number", "12x", "f")).toThrow(RenderError);
    expect(() => checkFieldValue("date", "2026-13-01", "f")).toThrow(RenderError);
    expect(() => checkFieldValue("date", "2026-10-25", "f")).not.toThrow();
  });
  test("custom field shapes", () => {
    expect(renderJiraFieldValue({ value: "Q{{year}}" }, "option", scope, opts).value).toEqual({ value: "Q2026" });
    expect(renderJiraFieldValue([{ name: "R{{year}}" }], "array", scope, opts).value).toEqual([{ name: "R2026" }]);
    expect(renderJiraFieldValue(5, "number", scope, opts).value).toBe(5);
  });
  test("unsupported shapes with placeholders are kept and noted", () => {
    const out = renderJiraFieldValue({ accountId: "{{x}}" }, "user", scope, opts);
    expect(out.value).toEqual({ accountId: "{{x}}" });
    expect(out.warnings[0]!.code).toBe("not-rendered-field");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun run test packages/core/src/templates/adapters/text.test.ts`
Expected: FAIL, module not found

- [ ] **Step 3: Implement**

```ts
// packages/core/src/templates/adapters/text.ts
import { RenderError, renderText, type RenderOptions, type RenderWarning, type TemplateScope } from "../render.js";

export type FieldKind = "summary" | "label" | "string" | "number" | "date" | "option" | "name";

export function checkFieldValue(kind: FieldKind, value: string, unit: string): void {
  const bad = (why: string) => { throw new RenderError(`${unit}: ${why} (got "${value}")`); };
  if ((kind === "summary" || kind === "name" || kind === "option") && value.trim() === "") bad("must not be empty after rendering");
  if (kind === "label" && (value === "" || /\s/.test(value))) bad("labels cannot be empty or contain whitespace");
  if (kind === "number" && (value.trim() === "" || !Number.isFinite(Number(value)))) bad("is not a number");
  if (kind === "date") {
    const d = new Date(`${value}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) bad("is not a YYYY-MM-DD date");
  }
}

export function renderTextField(value: string, kind: FieldKind, scope: TemplateScope, opts: RenderOptions & { unit: string }): { value: string; warnings: RenderWarning[] } {
  const { text, warnings } = renderText(value, scope, opts);
  if (text !== value || kind === "summary") checkFieldValue(kind, text, opts.unit);
  return { value: text, warnings };
}

export function renderJiraFieldValue(value: unknown, schemaType: string | undefined, scope: TemplateScope, opts: RenderOptions & { unit: string }): { value: unknown; warnings: RenderWarning[] } {
  const warnings: RenderWarning[] = [];
  const one = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = renderTextField(v, schemaType === "date" ? "date" : "string", scope, opts);
      warnings.push(...r.warnings);
      return r.value;
    }
    if (typeof v === "number" || v === null || v === undefined || typeof v === "boolean") return v;
    if (Array.isArray(v)) return v.map(one);
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && typeof o.value === "string") return { value: renderTextField(o.value, "option", scope, opts).value };
    if (keys.length === 1 && typeof o.name === "string") return { name: renderTextField(o.name, "name", scope, opts).value };
    if (JSON.stringify(v).includes("{{")) {
      warnings.push({ code: "not-rendered-field", message: `${opts.unit}: field type is not rendered; copied as is`, unit: opts.unit });
    }
    return v;
  };
  return { value: one(value), warnings };
}
```

Collect the warnings from the option/name branches too: assign each
`renderTextField` result, push its `warnings`, then return the value.

- [ ] **Step 4: Run the tests**

Run: `bun run test packages/core/src/templates/adapters/text.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add packages/core/src/templates/adapters/text.ts packages/core/src/templates/adapters/text.test.ts
/usr/bin/git commit -m "feat(core): text template adapter with Jira field checks"
```

---

### Task 4: ADF adapter (inline runs, links, code)

**Files:**
- Create: `packages/core/src/templates/adapters/runs.ts`, `packages/core/src/templates/adapters/adf.ts`, `packages/core/src/templates/adapters/adf.test.ts`

**Interfaces:**
- Consumes: `renderSegments`, `renderText`, `finish`, `RenderOptions`, `RenderWarning`, `TemplateScope` (Task 2)
- Produces:

```ts
// runs.ts: format-neutral
export interface RunPiece { text: string }
/** New text per piece: unchanged segments keep their characters in place; a changed segment goes entirely into the piece where it starts. */
export function distribute(pieces: string[], segments: Segment[]): string[]
// adf.ts
export interface AdfNode { type: string; text?: string; marks?: AdfMark[]; attrs?: Record<string, unknown>; content?: AdfNode[]; [k: string]: unknown }
export interface AdfMark { type: string; attrs?: Record<string, unknown> }
export function renderAdf<T>(doc: T, scope: TemplateScope, opts: RenderOptions & { unit: string }): { value: T; warnings: RenderWarning[] }
```

Rules:
- If `JSON.stringify(doc)` has no `{{`, return the same object.
- Recurse through `content`.
- A node whose `content` contains `text` nodes is an inline container. Its
  children split into runs: maximal sequences of `text` nodes without a `code`
  mark. Any other child (mention, emoji, inlineCard, hardBreak, date, status,
  mediaInline, a text node with a `code` mark) ends the current run and stays
  untouched.
- A `codeBlock` is skipped entirely.
- `link` mark `href` containing `{{` is rendered with `renderText`. The result
  must satisfy `/^(https?:|mailto:|\/|#)/` and, for `http(s)`,
  `new URL(result)`; otherwise keep the original and warn `invalid-url`.
- After distributing, drop text nodes whose text is `""`.
- A run ending in an unclosed `{{` right before a non-text inline node (a
  mustache that crosses it) warns `crosses-inline-node`. Detect it by checking
  whether the run's text has more `{{` than `}}` and the following sibling is a
  non-text inline node; the run then stays literal.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/src/templates/adapters/adf.test.ts
import { describe, expect, test } from "bun:test";
import { createTemplateScope } from "../render.js";
import { renderAdf } from "./adf.js";
import { distribute } from "./runs.js";

const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
const p = (...content: unknown[]) => ({ type: "paragraph", content });
const t = (text: string, ...marks: string[]) => (marks.length ? { type: "text", text, marks: marks.map((type) => ({ type })) } : { type: "text", text });
const scope = createTemplateScope({ vars: { customer: "ACME", year: 2026, empty: "", html: "<b>&</b>" }, source: { key: "TPL-7" } });
const opts = { unit: "TPL-1 description" };
const render = (d: unknown) => renderAdf(d, scope, opts);

describe("distribute", () => {
  test("unchanged segments stay in place, changed ones go to their start piece", () => {
    expect(distribute(["a {{cus", "tomer}} b"], [
      { start: 0, end: 2, output: "a " },
      { start: 2, end: 13, output: "ACME" },
      { start: 13, end: 15, output: " b" },
    ])).toEqual(["a ACME", " b"]);
  });
});

describe("renderAdf", () => {
  test("returns the same object when nothing is templated", () => {
    const d = doc(p(t("plain")));
    expect(render(d).value).toBe(d);
  });
  test("renders a placeholder split across marks", () => {
    const out = render(doc(p(t("for {{cus"), t("tomer}}", "strong"), t(" now"))));
    expect(out.value).toEqual(doc(p(t("for ACME"), t(" now"))));
  });
  test("keeps marks of a placeholder inside one node", () => {
    expect(render(doc(p(t("{{customer}}", "em")))).value).toEqual(doc(p(t("ACME", "em"))));
  });
  test("inserts markup as plain text", () => {
    expect(render(doc(p(t("{{html}}")))).value).toEqual(doc(p(t("<b>&</b>"))));
  });
  test("drops text nodes that render empty", () => {
    expect(render(doc(p(t("x"), t("{{empty}}", "strong")))).value).toEqual(doc(p(t("x"))));
  });
  test("never renders code marks or code blocks", () => {
    const d = doc(p(t("{{customer}}", "code")), { type: "codeBlock", content: [t("{{customer}}")] });
    expect(render(d).value).toEqual(d);
  });
  test("mentions are boundaries; a crossing expression stays literal", () => {
    const mention = { type: "mention", attrs: { id: "1", text: "@Ann" } };
    const d = doc(p(t("hi {{custo"), mention, t("mer}}")));
    const out = render(d);
    expect(out.value).toEqual(d);
    expect(out.warnings.some((w) => w.code === "crosses-inline-node")).toBe(true);
  });
  test("renders link hrefs and keeps invalid results", () => {
    const link = (href: string) => ({ type: "text", text: "issue", marks: [{ type: "link", attrs: { href } }] });
    expect(render(doc(p(link("https://x.atlassian.net/browse/{{source.key}}")))).value).toEqual(doc(p(link("https://x.atlassian.net/browse/TPL-7"))));
    const bad = render(doc(p(link("{{customer}}"))));
    expect(bad.value).toEqual(doc(p(link("{{customer}}"))));
    expect(bad.warnings[0]!.code).toBe("invalid-url");
  });
  test("round-trips a Jinja description unchanged apart from warnings", () => {
    const d = doc(p(t("Run with {{ item.name }} and {{ x | default('a') }}")));
    const out = render(d);
    expect(out.value).toEqual(d);
    expect(out.warnings.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun run test packages/core/src/templates/adapters/adf.test.ts`
Expected: FAIL, module not found

- [ ] **Step 3: Implement `runs.ts`**

```ts
// packages/core/src/templates/adapters/runs.ts
import type { Segment } from "../render.js";

export function distribute(pieces: string[], segments: Segment[]): string[] {
  const starts: number[] = [];
  let at = 0;
  for (const piece of pieces) { starts.push(at); at += piece.length; }
  const source = pieces.join("");
  const out = pieces.map(() => "");
  const pieceAt = (offset: number) => {
    let i = 0;
    while (i + 1 < starts.length && starts[i + 1]! <= offset) i++;
    return i;
  };
  for (const seg of segments) {
    const unchanged = source.slice(seg.start, seg.end) === seg.output;
    if (!unchanged) { out[pieceAt(seg.start)] += seg.output; continue; }
    for (let i = 0; i < pieces.length; i++) {
      const from = Math.max(seg.start, starts[i]!);
      const to = Math.min(seg.end, starts[i]! + pieces[i]!.length);
      if (from < to) out[i] += source.slice(from, to);
    }
  }
  return out;
}
```

Note: `pieceAt` must find the piece *containing* `seg.start`. For a run
starting with empty pieces, empty text nodes cannot exist in ADF, so this is
safe.

- [ ] **Step 4: Implement `adf.ts`**

```ts
// packages/core/src/templates/adapters/adf.ts
import { finish, renderSegments, renderText, type RenderOptions, type RenderWarning, type TemplateScope } from "../render.js";
import { distribute } from "./runs.js";
import { renderAdfBlocks } from "./adf-blocks.js"; // Task 5; until then: (nodes, scope, opts, inline) => nodes.map(inline)

export interface AdfMark { type: string; attrs?: Record<string, unknown> }
export interface AdfNode { type: string; text?: string; marks?: AdfMark[]; attrs?: Record<string, unknown>; content?: AdfNode[]; [k: string]: unknown }

const URL_OK = /^(https?:|mailto:|\/|#)/;
const isRunText = (n: AdfNode) => n.type === "text" && !(n.marks ?? []).some((m) => m.type === "code");

export function renderAdf<T>(doc: T, scope: TemplateScope, opts: RenderOptions & { unit: string }): { value: T; warnings: RenderWarning[] } {
  if (doc === null || typeof doc !== "object" || !JSON.stringify(doc).includes("{{")) return { value: doc, warnings: [] };
  const warnings: RenderWarning[] = [];
  const ctx = { scope, opts, warnings };
  const value = renderNode(doc as unknown as AdfNode, ctx) as unknown as T;
  return finish(value, warnings, opts);
}

interface Ctx { scope: TemplateScope; opts: RenderOptions & { unit: string }; warnings: RenderWarning[] }

export function renderNode(node: AdfNode, ctx: Ctx): AdfNode {
  if (node.type === "codeBlock" || !node.content || !JSON.stringify(node).includes("{{")) return node;
  const content = node.content.some((c) => c.type === "text")
    ? renderInline(node.content, ctx)
    : renderAdfBlocks(node.content, ctx, (child, c) => renderNode(child, c));
  return { ...node, content };
}

function renderInline(children: AdfNode[], ctx: Ctx): AdfNode[] {
  const out: AdfNode[] = [];
  let run: AdfNode[] = [];
  const flush = (next?: AdfNode) => {
    if (run.length === 0) return;
    const pieces = run.map((n) => n.text ?? "");
    const joined = pieces.join("");
    const crosses = next !== undefined && (joined.match(/\{\{/g)?.length ?? 0) > (joined.match(/\}\}/g)?.length ?? 0);
    if (crosses) {
      ctx.warnings.push({ code: "crosses-inline-node", message: `${ctx.opts.unit}: an expression crosses a ${next!.type}; left as is`, unit: ctx.opts.unit });
      out.push(...run.map((n) => renderLinkMarks(n, ctx)));
    } else if (!joined.includes("{{")) {
      out.push(...run.map((n) => renderLinkMarks(n, ctx)));
    } else {
      const { segments, warnings } = renderSegments(joined, ctx.scope, { ...ctx.opts, strict: false });
      ctx.warnings.push(...warnings);
      const texts = distribute(pieces, segments);
      run.forEach((n, i) => { if (texts[i] !== "") out.push(renderLinkMarks({ ...n, text: texts[i] }, ctx)); });
    }
    run = [];
  };
  for (const child of children) {
    if (isRunText(child)) run.push(child);
    else { flush(child); out.push(child.type === "text" ? child : renderNode(child, ctx)); }
  }
  flush();
  return out;
}

function renderLinkMarks(node: AdfNode, ctx: Ctx): AdfNode {
  if (!node.marks?.some((m) => m.type === "link" && typeof m.attrs?.href === "string" && (m.attrs.href as string).includes("{{"))) return node;
  const marks = node.marks.map((m) => {
    if (m.type !== "link" || typeof m.attrs?.href !== "string" || !m.attrs.href.includes("{{")) return m;
    const href = m.attrs.href;
    const { text, warnings } = renderText(href, ctx.scope, { ...ctx.opts, strict: false });
    ctx.warnings.push(...warnings);
    let ok = URL_OK.test(text);
    if (ok && /^https?:/.test(text)) { try { new URL(text); } catch { ok = false; } }
    if (!ok) {
      ctx.warnings.push({ code: "invalid-url", message: `${ctx.opts.unit}: link "${href}" renders to an invalid URL; kept`, unit: ctx.opts.unit });
      return m;
    }
    return { ...m, attrs: { ...m.attrs, href: text } };
  });
  return { ...node, marks };
}
```

Create `adapters/adf-blocks.ts` now with this placeholder body, so Task 4
compiles and Task 5 replaces it:

```ts
// packages/core/src/templates/adapters/adf-blocks.ts
import type { AdfNode } from "./adf.js";
export function renderAdfBlocks<C>(nodes: AdfNode[], ctx: C, render: (n: AdfNode, c: C) => AdfNode): AdfNode[] {
  return nodes.map((n) => render(n, ctx));
}
```

Inner renders pass `strict: false`; only `renderAdf`'s final `finish` applies
`strict`, so a strict run reports every warning at once.

- [ ] **Step 5: Run the tests**

Run: `bun run test packages/core/src/templates/adapters/adf.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
/usr/bin/git add packages/core/src/templates/adapters/runs.ts packages/core/src/templates/adapters/adf.ts packages/core/src/templates/adapters/adf-blocks.ts packages/core/src/templates/adapters/adf.test.ts
/usr/bin/git commit -m "feat(core): ADF template adapter for inline text and links"
```

---

### Task 5: ADF control paragraphs (if, unless, each, with)

**Files:**
- Modify: `packages/core/src/templates/adapters/adf-blocks.ts`
- Test: `packages/core/src/templates/adapters/adf-blocks.test.ts`

**Interfaces:**
- Consumes: `evaluateExpression`, `childScope` (Task 2); `AdfNode`, `renderNode` (Task 4)
- Produces:
  - `renderAdfBlocks(nodes, ctx, render)`, the same signature as the Task 4 placeholder
  - `CONTROL: RegExp` and `controlOf(text: string): Control | undefined`, exported for reuse by the storage adapter

```ts
export type Control =
  | { kind: "open"; name: "if" | "unless" | "each" | "with"; expr: string }
  | { kind: "else" }
  | { kind: "close"; name: "if" | "unless" | "each" | "with" };
export const CONTROL = /^\{\{~?\s*(?:#(if|unless|each|with)\s+([^}]+?)|(else)|\/(if|unless|each|with))\s*~?\}\}$/;
export function controlOf(text: string): Control | undefined
```

Rules:
- A block node is a control when one of these holds:
  - (a) it is a `paragraph` whose inline content is only non-code `text` nodes
    and whose joined, trimmed text matches `CONTROL`
  - (b) it is a `listItem` whose `content` is exactly one such paragraph
  - (c) it is a `tableRow` whose first `tableCell`/`tableHeader` content is
    exactly one such paragraph
- Pair controls with a stack over the sibling list. If a pairing fails
  (unknown close, mismatched name, leftover open, `else` outside an open
  `if`/`unless`/`each`), every control in this sibling list is treated as
  ordinary content and gets one `unbalanced-block` warning. As ordinary
  paragraphs they stay literal on their own, because a lone `{{#if x}}` is a
  parse error.
- Evaluation:
  - `if`: truthy when the value is not `undefined`/`null`/`false`/`0`/`""`/`[]`;
    render the then-range, or the else-range otherwise.
  - `unless`: the inverse.
  - `each`: for an array, render the range once per item with
    `childScope(scope, item, { index, first, last })`; for an object, per entry
    with `key`; empty or missing renders the else-range.
  - `with`: `childScope(scope, value)`, or the else-range when the value is
    empty.
- Control nodes themselves are removed from the output.
- `renderNode` is called for every emitted sibling with the iteration's scope.
  `Ctx` carries the scope, so iteration creates `{ ...ctx, scope: child }`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/src/templates/adapters/adf-blocks.test.ts
import { describe, expect, test } from "bun:test";
import { createTemplateScope } from "../render.js";
import { renderAdf } from "./adf.js";

const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const li = (text: string) => ({ type: "listItem", content: [p(text)] });
const ul = (...items: unknown[]) => ({ type: "bulletList", content: items });
const cell = (text: string) => ({ type: "tableCell", content: [p(text)] });
const row = (...cells: unknown[]) => ({ type: "tableRow", content: cells });
const table = (...rows: unknown[]) => ({ type: "table", content: rows });
const scope = createTemplateScope({ vars: { internal: true, systems: ["IAM", "Backup"], owners: { IAM: "Ann" }, none: [] } });
const render = (d: unknown) => renderAdf(d, scope, { unit: "d" });

describe("ADF control paragraphs", () => {
  test("if/else over sibling paragraphs at doc level", () => {
    expect(render(doc(p("{{#if internal}}"), p("A"), p("{{else}}"), p("B"), p("{{/if}}"), p("C"))).value).toEqual(doc(p("A"), p("C")));
  });
  test("unless and if on missing values", () => {
    expect(render(doc(p("{{#unless internal}}"), p("A"), p("{{/unless}}"))).value).toEqual(doc());
    const out = render(doc(p("{{#if missing}}"), p("A"), p("{{/if}}")));
    expect(out.value).toEqual(doc());
    expect(out.warnings[0]!.code).toBe("unresolved");
  });
  test("each repeats siblings with this, @index, @first, @last", () => {
    expect(render(doc(p("{{#each systems}}"), p("{{@index}} {{this}}{{#if @last}}!{{/if}}"), p("{{/each}}"))).value).toEqual(doc(p("0 IAM"), p("1 Backup!")));
  });
  test("each over an empty list renders else", () => {
    expect(render(doc(p("{{#each none}}"), p("x"), p("{{else}}"), p("nothing"), p("{{/each}}"))).value).toEqual(doc(p("nothing")));
  });
  test("each over list items", () => {
    expect(render(doc(ul(li("{{#each systems}}"), li("{{this}}"), li("{{/each}}")))).value).toEqual(doc(ul(li("IAM"), li("Backup"))));
  });
  test("each over table rows", () => {
    const d = doc(table(row(cell("System"), cell("Owner")), row(cell("{{#each systems}}"), cell("")), row(cell("{{this}}"), cell("{{@root.owners.IAM}}")), row(cell("{{/each}}"), cell(""))));
    expect(render(d).value).toEqual(doc(table(row(cell("System"), cell("Owner")), row(cell("IAM"), cell("Ann")), row(cell("Backup"), cell("Ann")))));
  });
  test("controls inside a panel and nested each in if", () => {
    const panel = (...content: unknown[]) => ({ type: "panel", attrs: { panelType: "info" }, content });
    expect(render(doc(panel(p("{{#if internal}}"), p("{{#each systems}}"), p("{{this}}"), p("{{/each}}"), p("{{/if}}")))).value).toEqual(doc(panel(p("IAM"), p("Backup"))));
  });
  test("unbalanced blocks stay literal with a warning", () => {
    const d = doc(p("{{#if internal}}"), p("A"));
    const out = render(d);
    expect(out.value).toEqual(d);
    expect(out.warnings.some((w) => w.code === "unbalanced-block")).toBe(true);
  });
  test("crossing blocks stay literal", () => {
    const d = doc(p("{{#if internal}}"), p("{{#each systems}}"), p("{{/if}}"), p("{{/each}}"));
    expect(render(d).value).toEqual(d);
  });
});
```

Handlebars' own `lookup` and `log` helpers are not in `TEMPLATE_HELPER_NAMES`.
`analyze` reports them as `unknown-helper` and keeps them literal, which is
intended: only the documented helpers work.

- [ ] **Step 2: Run them to see them fail**

Run: `bun run test packages/core/src/templates/adapters/adf-blocks.test.ts`
Expected: FAIL, controls are rendered as literal paragraphs

- [ ] **Step 3: Implement `adf-blocks.ts`**

```ts
// packages/core/src/templates/adapters/adf-blocks.ts
import { childScope, evaluateExpression, type TemplateScope } from "../render.js";
import type { AdfNode } from "./adf.js";

export type Control =
  | { kind: "open"; name: "if" | "unless" | "each" | "with"; expr: string }
  | { kind: "else" }
  | { kind: "close"; name: "if" | "unless" | "each" | "with" };

export const CONTROL = /^\{\{~?\s*(?:#(if|unless|each|with)\s+([^}]+?)|(else)|\/(if|unless|each|with))\s*~?\}\}$/;

export function controlOf(text: string): Control | undefined {
  const m = CONTROL.exec(text.trim());
  if (!m) return undefined;
  if (m[1]) return { kind: "open", name: m[1] as never, expr: m[2]!.trim() };
  if (m[3]) return { kind: "else" };
  return { kind: "close", name: m[4] as never };
}

const paragraphText = (n: AdfNode | undefined): string | undefined =>
  n?.type === "paragraph" && n.content?.length && n.content.every((c) => c.type === "text" && !(c.marks ?? []).some((m) => m.type === "code"))
    ? n.content.map((c) => c.text ?? "").join("")
    : undefined;

function nodeControl(n: AdfNode): Control | undefined {
  let text = paragraphText(n);
  if (text === undefined && n.type === "listItem" && n.content?.length === 1) text = paragraphText(n.content[0]);
  if (text === undefined && n.type === "tableRow") {
    const first = n.content?.[0];
    if (first && (first.type === "tableCell" || first.type === "tableHeader") && first.content?.length === 1) text = paragraphText(first.content[0]);
  }
  return text === undefined ? undefined : controlOf(text);
}

interface Block { control: Extract<Control, { kind: "open" }>; then: Item[]; otherwise: Item[] }
type Item = { node: AdfNode } | { block: Block };

/** Pairs controls into blocks; undefined when they don't pair. */
function structure(nodes: AdfNode[]): Item[] | undefined {
  const root: Item[] = [];
  const stack: Array<{ block: Block; inElse: boolean; into: Item[] }> = [];
  const target = () => (stack.length ? (stack.at(-1)!.inElse ? stack.at(-1)!.block.otherwise : stack.at(-1)!.block.then) : root);
  for (const node of nodes) {
    const c = nodeControl(node);
    if (!c) { target().push({ node }); continue; }
    if (c.kind === "open") {
      const block: Block = { control: c, then: [], otherwise: [] };
      target().push({ block });
      stack.push({ block, inElse: false, into: target() });
    } else if (c.kind === "else") {
      const top = stack.at(-1);
      if (!top || top.inElse || top.block.control.name === "with") return undefined;
      top.inElse = true;
    } else {
      const top = stack.pop();
      if (!top || top.block.control.name !== c.name) return undefined;
    }
  }
  return stack.length === 0 ? root : undefined;
}

const empty = (v: unknown) => v === undefined || v === null || v === false || v === 0 || v === "" || (Array.isArray(v) && v.length === 0);

export function renderAdfBlocks<C extends { scope: TemplateScope; opts: { unit: string }; warnings: { code: string }[] }>(
  nodes: AdfNode[],
  ctx: C,
  render: (n: AdfNode, c: C) => AdfNode,
): AdfNode[] {
  if (!nodes.some((n) => nodeControl(n))) return nodes.map((n) => render(n, ctx));
  const items = structure(nodes);
  if (!items) {
    ctx.warnings.push({ code: "unbalanced-block", message: `${ctx.opts.unit}: unbalanced {{#…}} control paragraphs; left as is`, unit: ctx.opts.unit } as never);
    return nodes;
  }
  const emit = (list: Item[], c: C): AdfNode[] =>
    list.flatMap((item) => ("node" in item ? [render(item.node, c)] : emitBlock(item.block, c)));
  const emitBlock = (b: Block, c: C): AdfNode[] => {
    const { value, warnings } = evaluateExpression(b.control.expr, c.scope, { unit: c.opts.unit });
    c.warnings.push(...(warnings as never[]));
    switch (b.control.name) {
      case "if": return emit(empty(value) ? b.otherwise : b.then, c);
      case "unless": return emit(empty(value) ? b.then : b.otherwise, c);
      case "with": return empty(value) ? [] : emit(b.then, { ...c, scope: childScope(c.scope, value) });
      case "each": {
        const entries: Array<[string | number, unknown]> = Array.isArray(value)
          ? value.map((v, i) => [i, v])
          : value && typeof value === "object" ? Object.entries(value) : [];
        if (entries.length === 0) return emit(b.otherwise, c);
        return entries.flatMap(([key, item], i) =>
          emit(b.then, { ...c, scope: childScope(c.scope, item, { index: i, key, first: i === 0, last: i === entries.length - 1 }) }),
        );
      }
    }
  };
  return emit(items, ctx);
}
```

The test "unbalanced blocks stay literal" expects the *original* nodes back.
Returning `nodes` unrendered is fine, because each control paragraph is
literal anyway and the remaining content then misses rendering. That matches
the spec: "the controls stay literal and the content renders normally". So
return `nodes.map((n) => nodeControl(n) ? n : render(n, ctx))` instead of
`nodes`, and keep the test's `doc(p("{{#if internal}}"), p("A"))` (A has no
placeholders, so it is identical either way).

`renderNode` (Task 4) must pass its `ctx` through: it calls
`renderAdfBlocks(node.content, ctx, (child, c) => renderNode(child, c))`.
Inline rendering uses `ctx.scope`, so iteration scopes reach the text.

- [ ] **Step 4: Run the ADF tests**

Run: `bun run test packages/core/src/templates/adapters/`
Expected: PASS (adf.test.ts and adf-blocks.test.ts)

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add packages/core/src/templates/adapters/adf-blocks.ts packages/core/src/templates/adapters/adf-blocks.test.ts packages/core/src/templates/adapters/adf.ts
/usr/bin/git commit -m "feat(core): ADF control paragraphs for if, unless, each and with"
```

---

### Task 6: Storage XHTML adapter

The spec says to reuse an existing storage parse/serialize path. There is
none that round-trips bytes: `parseXml` in `packages/confluence/src/export-blocks.ts`
has no serializer and no offsets, and `@atlcli/core` cannot depend on
`@atlcli/confluence`. So this task builds a small **offset tokenizer** in core.
It rewrites only changed text tokens, which keeps every other byte. Record
this in the spec's Implementation notes (Task 16).

**Files:**
- Create: `packages/core/src/templates/adapters/storage.ts`, `packages/core/src/templates/adapters/storage.test.ts`

**Interfaces:**
- Consumes: `renderSegments`, `renderText`, `finish`, `evaluateExpression`, `childScope` (Task 2); `distribute` (Task 4); `controlOf`, `Control` (Task 5)
- Produces: `renderStorage(storage: string, scope: TemplateScope, opts: RenderOptions & { unit: string }): { value: string; warnings: RenderWarning[] }`

Model:
- Tokens via `/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\/?[A-Za-z][\w:.-]*(?:\s[^>]*)?\/?>|[^<]+|</g`, keeping offsets.
- An element tree from tag tokens, with `start`/`end` offsets of the whole
  element and `name`, `attrs` (parse `\s([\w:.-]+)="([^"]*)"`), `children`
  (elements and text tokens). Self-closing tags (`/>`) and void `br`/`hr` have
  no children. A stray close tag that doesn't match: give up on structure
  (return the input unchanged with one `parse-error` warning).
- **Skip** (never rendered): `ac:plain-text-body`, `code`, `pre`, CDATA,
  comments, and `ac:structured-macro` with `ac:name="code"` or
  `ac:name="noformat"`.
- **Inline elements** (part of a run): `strong`, `b`, `em`, `i`, `u`, `s`,
  `del`, `span`, `sub`, `sup`, `small`, `big`, `font`, `a`. Every other element
  inside a block (`ac:link`, `ri:*`, `ac:emoticon`, `ac:image`, `br`, `time`,
  `ac:structured-macro`, `ac:inline-comment-marker`) is a run boundary. It gets
  recursed into, so its own blocks (`ac:rich-text-body`) and `ac:parameter`
  text render on their own.
- **Units:** a run is a maximal sequence of text tokens (descending through
  inline elements) inside one non-inline parent. The text is entity-decoded
  for rendering. Decode `&amp; &lt; &gt; &quot; &apos; &#NN; &#xHH;` and every
  other named entity literally as itself (so `&nbsp;` stays `&nbsp;`; a
  placeholder never contains entities). Only changed tokens are re-encoded
  (`&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`), and unchanged tokens keep their
  original bytes.
- `ac:parameter` content is one unit, with the same rule.
- **Controls:** a `p` whose only content is text matching `controlOf`, an `li`
  whose only child is such a `p` (or whose own text matches), and a `tr` whose
  first `td`/`th` qualifies. Pairing and evaluation are the same as Task 5.
  Output is built by slicing: emitted siblings are their original source
  slices after their inner runs are rendered, and control elements are cut out
  together with the whitespace text between siblings they own.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/src/templates/adapters/storage.test.ts
import { describe, expect, test } from "bun:test";
import { createTemplateScope } from "../render.js";
import { renderStorage } from "./storage.js";

const scope = createTemplateScope({ vars: { customer: "ACME", project: "AUD", html: `<b a="1">&]]></b>`, systems: ["IAM", "Backup"], on: true } });
const render = (s: string) => renderStorage(s, scope, { unit: "page 1" });

describe("renderStorage", () => {
  test("keeps bytes of a page without placeholders", () => {
    const s = `<p>a&nbsp;b &amp; c</p><ac:structured-macro ac:name="info"><ac:rich-text-body><p>x</p></ac:rich-text-body></ac:structured-macro><!-- c --><![CDATA[ y ]]>`;
    expect(render(s).value).toBe(s);
  });
  test("renders across inline elements and keeps tags", () => {
    expect(render(`<p>for {{cus<strong>tomer}}</strong> &amp; co</p>`).value).toBe(`<p>for ACME<strong></strong> &amp; co</p>`);
  });
  test("escapes a value with markup", () => {
    expect(render(`<p>{{html}}</p>`).value).toBe(`<p>&lt;b a="1"&gt;&amp;]]&gt;&lt;/b&gt;</p>`);
  });
  test("renders macro parameters", () => {
    const s = `<ac:structured-macro ac:name="jira"><ac:parameter ac:name="jqlQuery">project = {{project}}</ac:parameter></ac:structured-macro>`;
    expect(render(s).value).toBe(s.replace("{{project}}", "AUD"));
  });
  test("never renders code macros, pre and code", () => {
    const s = `<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[{{customer}}]]></ac:plain-text-body></ac:structured-macro><pre>{{customer}}</pre><p><code>{{customer}}</code></p>`;
    expect(render(s).value).toBe(s);
  });
  test("links are boundaries", () => {
    const s = `<p>{{cus<ac:link><ri:page ri:content-title="X" /></ac:link>tomer}}</p>`;
    expect(render(s).value).toBe(s);
  });
  test("control paragraphs, list items and table rows", () => {
    expect(render(`<p>{{#if on}}</p><p>A</p><p>{{/if}}</p>`).value).toBe(`<p>A</p>`);
    expect(render(`<ul><li>{{#each systems}}</li><li>{{this}}</li><li>{{/each}}</li></ul>`).value).toBe(`<ul><li>IAM</li><li>Backup</li></ul>`);
    expect(render(`<table><tbody><tr><td>{{#each systems}}</td></tr><tr><td>{{this}}</td></tr><tr><td>{{/each}}</td></tr></tbody></table>`).value)
      .toBe(`<table><tbody><tr><td>IAM</td></tr><tr><td>Backup</td></tr></tbody></table>`);
  });
  test("an entity-encoded quote inside a helper call still renders", () => {
    expect(render(`<p>{{default missing &quot;x&quot;}}</p>`).value).toBe(`<p>x</p>`);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun run test packages/core/src/templates/adapters/storage.test.ts`
Expected: FAIL, module not found

- [ ] **Step 3: Implement `storage.ts`**

Implement the model above in about 250 lines. Structure:

```ts
// packages/core/src/templates/adapters/storage.ts
import { childScope, evaluateExpression, finish, renderSegments, type RenderOptions, type RenderWarning, type TemplateScope } from "../render.js";
import { controlOf, type Control } from "./adf-blocks.js";
import { distribute } from "./runs.js";

interface Text { kind: "text"; start: number; end: number; raw: string; decoded: string }
interface El { kind: "el"; name: string; attrs: Record<string, string>; start: number; end: number; openEnd: number; closeStart: number; children: Array<El | Text | Opaque> }
interface Opaque { kind: "opaque"; start: number; end: number } // CDATA, comments

const TOKEN = /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\/?[A-Za-z][\w:.-]*(?:\s[^>]*)?\/?>|[^<]+|</g;
const INLINE = new Set(["strong", "b", "em", "i", "u", "s", "del", "span", "sub", "sup", "small", "big", "font", "a"]);
const SKIP = new Set(["ac:plain-text-body", "code", "pre"]);
const VOID = new Set(["br", "hr", "img", "col"]);

export function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k === "amp") return "&"; if (k === "lt") return "<"; if (k === "gt") return ">";
    if (k === "quot") return '"'; if (k === "apos") return "'";
    const code = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}
export const encodeText = (s: string) => s.replace(/&(?![a-z]+;|#\d+;|#x[0-9a-f]+;)/gi, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function parseTree(storage: string): El | undefined { /* stack-based build from TOKEN matches; undefined on mismatch */ }
const skipped = (el: El) => SKIP.has(el.name) || (el.name === "ac:structured-macro" && /^(code|noformat)$/.test(el.attrs["ac:name"] ?? ""));

export function renderStorage(storage: string, scope: TemplateScope, opts: RenderOptions & { unit: string }): { value: string; warnings: RenderWarning[] } {
  if (!storage.includes("{{")) return { value: storage, warnings: [] };
  const root = parseTree(storage);
  if (!root) return finish(storage, [{ code: "parse-error", message: `${opts.unit}: storage could not be tokenized; left as is`, unit: opts.unit }], opts);
  const warnings: RenderWarning[] = [];
  // Edits: [start, end, replacement] on the original string, collected by walking the tree.
  const edits: Array<[number, number, string]> = [];
  renderChildren(root, scope);
  return finish(applyEdits(storage, edits), warnings, opts);

  // renderChildren(el, scope): pairs controls among el.children (same pairing as adf-blocks,
  //   reusing `controlOf`); for emitted ranges calls renderElementRuns; for each control element
  //   pushes an edit removing it; for an `each`, replaces the whole block range [first control start,
  //   closing control end] with the concatenation of each iteration's rendered slice (render the
  //   slice by recursively running renderStorage on the substring with the child scope and
  //   strict:false, then appending its warnings).
  // renderElementRuns(el, scope): walks children; collects runs of Text tokens through INLINE
  //   elements; a run with "{{" in its decoded text → renderSegments(decoded), distribute over the
  //   tokens' decoded texts, and push an edit per changed token with encodeText(newText).
  //   Non-inline, non-skipped child elements are recursed with renderChildren.
}
```

Write `parseTree`, `renderChildren` and `renderElementRuns` completely,
following the comments. Recursing per `each` iteration on a substring keeps
the code small. The substring's own controls are handled by the same function.

- [ ] **Step 4: Run the tests**

Run: `bun run test packages/core/src/templates/adapters/storage.test.ts`
Expected: PASS

- [ ] **Step 5: Run the nested-macro fixtures through the adapter as a fidelity guard**

Add this test to `storage.test.ts`. It reads the storage strings used by
`packages/confluence/src/markdown-nested-macros.test.ts`, copied inline
(core cannot import from confluence), and asserts the output equals the input
when no `{{` is present, and that only the placeholder bytes change when one
is injected into a `<p>`:

```ts
test("nested macros keep their bytes", () => {
  const s = `<ac:structured-macro ac:name="expand"><ac:rich-text-body><ac:structured-macro ac:name="info"><ac:rich-text-body><p>Hi {{customer}}</p></ac:rich-text-body></ac:structured-macro></ac:rich-text-body></ac:structured-macro>`;
  expect(render(s).value).toBe(s.replace("{{customer}}", "ACME"));
});
```

Run: `bun run test packages/core/src/templates/adapters/storage.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
/usr/bin/git add packages/core/src/templates/adapters/storage.ts packages/core/src/templates/adapters/storage.test.ts
/usr/bin/git commit -m "feat(core): byte-preserving storage XHTML template adapter"
```

---

### Task 7: Wiki markup, body dispatch, variable collection, exports

**Files:**
- Create: `packages/core/src/templates/adapters/wikimarkup.ts`, `packages/core/src/templates/adapters/index.ts`, `packages/core/src/templates/adapters/index.test.ts`
- Modify: `packages/core/src/templates/index.ts`, `packages/core/src/index.browser.ts`

**Interfaces:**
- Produces:

```ts
export function renderWikiMarkup(text: string, scope: TemplateScope, opts: RenderOptions & { unit: string }): { value: string; warnings: RenderWarning[] }
export type BodyFormat = "text" | "adf" | "storage" | "wikimarkup";
/** A string is "text" unless format says otherwise; an object with type "doc" is ADF. */
export function renderBody(value: unknown, scope: TemplateScope, opts: RenderOptions & { unit: string; format?: BodyFormat }): { value: unknown; warnings: RenderWarning[] }
export interface VariableUse { name: string; unit: string; line?: number }
/** Root variable names used (not @data, not helpers, not inside each/with bodies), by unit. */
export function collectVariables(units: Array<{ unit: string; value: unknown; format?: BodyFormat }>): VariableUse[]
```

`collectVariables` parses each text unit with Handlebars. For ADF it uses the
text runs; for storage, the decoded runs. It walks MustacheStatement paths,
SubExpression params and BlockStatement params, and records `parts[0]` of
non-data, depth-0 paths outside `each`/`with` bodies. `source` and `parent`
are excluded (operation context). Parse errors are skipped. Reuse the run
extraction by exporting `adfTextUnits(doc): string[]` from `adf.ts` and
`storageTextUnits(s): string[]` from `storage.ts`, the decoded run strings
those adapters already compute.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/src/templates/adapters/index.test.ts
import { describe, expect, test } from "bun:test";
import { createTemplateScope } from "../render.js";
import { collectVariables, renderBody } from "./index.js";
import { renderWikiMarkup } from "./wikimarkup.js";

const scope = createTemplateScope({ vars: { year: 2026 } });

describe("wiki markup", () => {
  test("skips code and noformat, keeps unknown monospace", () => {
    const s = "Audit {{year}} {{monospace}}\n{code:js}{{year}}{code}\n{noformat}{{year}}{noformat}";
    expect(renderWikiMarkup(s, scope, { unit: "d" }).value).toBe("Audit 2026 {{monospace}}\n{code:js}{{year}}{code}\n{noformat}{{year}}{noformat}");
  });
});

describe("renderBody", () => {
  test("dispatches by shape and format", () => {
    expect(renderBody("Y{{year}}", scope, { unit: "s" }).value).toBe("Y2026");
    expect(renderBody({ type: "doc", version: 1, content: [] }, scope, { unit: "d" }).value).toEqual({ type: "doc", version: 1, content: [] });
    expect(renderBody("<p>{{year}}</p>", scope, { unit: "p", format: "storage" }).value).toBe("<p>2026</p>");
  });
});

describe("collectVariables", () => {
  test("finds root variables across formats", () => {
    const uses = collectVariables([
      { unit: "summary", value: "Audit {{year}} {{@today}} {{source.key}}" },
      { unit: "description", value: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "{{#each systems}}{{name}}{{/each}} {{default owner \"x\"}}" }] }] } },
      { unit: "page", value: "<p>{{customer}}</p>", format: "storage" },
    ]);
    expect(uses.map((u) => u.name).sort()).toEqual(["customer", "owner", "systems", "year"]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun run test packages/core/src/templates/adapters/index.test.ts`
Expected: FAIL, module not found

- [ ] **Step 3: Implement**

```ts
// packages/core/src/templates/adapters/wikimarkup.ts
import { finish, renderText, type RenderOptions, type RenderWarning, type TemplateScope } from "../render.js";

const CODE = /\{(code|noformat)(?::[^}]*)?\}[\s\S]*?\{\1\}/g;

export function renderWikiMarkup(text: string, scope: TemplateScope, opts: RenderOptions & { unit: string }): { value: string; warnings: RenderWarning[] } {
  if (!text.includes("{{")) return { value: text, warnings: [] };
  const warnings: RenderWarning[] = [];
  let out = "";
  let last = 0;
  for (const m of text.matchAll(CODE)) {
    const r = renderText(text.slice(last, m.index), scope, { ...opts, strict: false });
    warnings.push(...r.warnings);
    out += r.text + m[0];
    last = m.index! + m[0].length;
  }
  const r = renderText(text.slice(last), scope, { ...opts, strict: false });
  warnings.push(...r.warnings);
  return finish(out + r.text, warnings, opts);
}
```

```ts
// packages/core/src/templates/adapters/index.ts
import Handlebars from "handlebars";
import { renderText, finish, type RenderOptions, type RenderWarning, type TemplateScope } from "../render.js";
import { adfTextUnits, renderAdf } from "./adf.js";
import { renderStorage, storageTextUnits } from "./storage.js";
import { renderWikiMarkup } from "./wikimarkup.js";

export type BodyFormat = "text" | "adf" | "storage" | "wikimarkup";
export interface VariableUse { name: string; unit: string; line?: number }

export function renderBody(value: unknown, scope: TemplateScope, opts: RenderOptions & { unit: string; format?: BodyFormat }): { value: unknown; warnings: RenderWarning[] } {
  if (value === null || value === undefined) return { value, warnings: [] };
  const format = opts.format ?? (typeof value === "string" ? "text" : "adf");
  if (format === "adf") return renderAdf(value, scope, opts);
  if (typeof value !== "string") throw new TypeError(`${opts.unit}: ${format} body must be a string`);
  if (format === "storage") return renderStorage(value, scope, opts);
  if (format === "wikimarkup") return renderWikiMarkup(value, scope, opts);
  const r = renderText(value, scope, { ...opts, strict: false });
  return finish(r.text, r.warnings, opts);
}

export function collectVariables(units: Array<{ unit: string; value: unknown; format?: BodyFormat }>): VariableUse[] {
  const uses: VariableUse[] = [];
  const seen = new Set<string>();
  for (const u of units) {
    const format = u.format ?? (typeof u.value === "string" ? "text" : "adf");
    const texts = format === "adf" ? adfTextUnits(u.value) : format === "storage" ? storageTextUnits(String(u.value)) : [String(u.value ?? "")];
    for (const text of texts) {
      if (!text.includes("{{")) continue;
      let program: hbs.AST.Program;
      try { program = Handlebars.parse(text); } catch { continue; }
      const add = (expr: hbs.AST.Expression | undefined, line: number) => {
        if (!expr) return;
        if (expr.type === "SubExpression") { for (const p of (expr as hbs.AST.SubExpression).params) add(p, line); return; }
        if (expr.type !== "PathExpression") return;
        const path = expr as hbs.AST.PathExpression;
        const name = path.parts[0];
        if (path.data || path.depth > 0 || !name || name === "source" || name === "parent") return;
        const key = `${u.unit}\0${name}`;
        if (!seen.has(key)) { seen.add(key); uses.push({ name, unit: u.unit, line }); }
      };
      const walk = (body: hbs.AST.Statement[], scoped: boolean) => {
        for (const s of body) {
          if (s.type === "MustacheStatement") {
            const m = s as hbs.AST.MustacheStatement;
            const isCall = m.params.length > 0;
            if (!scoped) { if (isCall) m.params.forEach((p) => add(p, s.loc.start.line)); else add(m.path, s.loc.start.line); }
          } else if (s.type === "BlockStatement") {
            const b = s as hbs.AST.BlockStatement;
            if (!scoped) b.params.forEach((p) => add(p, s.loc.start.line));
            walk(b.program.body, scoped || ["each", "with"].includes((b.path as hbs.AST.PathExpression).original));
            if (b.inverse) walk(b.inverse.body, scoped);
          }
        }
      };
      walk(program.body, false);
    }
  }
  return uses;
}
```

Helper names (`default`, `formatDate`, …) in a no-param mustache are not
variables. In `walk`, skip `add(m.path, …)` when `TEMPLATE_HELPER_NAMES`
includes the name (import it from `../helpers.js`).

Also add the control-paragraph texts: `adfTextUnits` returns each paragraph's
joined text, so `{{#each systems}}` appears as its own unit. That text alone is
a parse error. So in `collectVariables`, before parsing, test the unit with
`controlOf` (import from `./adf-blocks.js`) and for an `open` control call
`add` on the parsed `{{${expr}}}`'s path or params.

- [ ] **Step 4: Export the render API**

In `packages/core/src/templates/index.ts` add:

```ts
// Render engine (browser-safe; also exported from index.browser.ts)
export * from "./render-exports.js";
```

Create `packages/core/src/templates/render-exports.ts`:

```ts
export { createTemplateHandlebars, TEMPLATE_HELPER_NAMES, dateAdd } from "./helpers.js";
export { childScope, createTemplateScope, evaluateExpression, finish, RenderBudget, RenderError, renderSegments, renderText } from "./render.js";
export type { RenderOptions, RenderWarning, RenderWarningCode, Segment, TemplateScope } from "./render.js";
export { checkFieldValue, renderJiraFieldValue, renderTextField } from "./adapters/text.js";
export type { FieldKind } from "./adapters/text.js";
export { renderAdf } from "./adapters/adf.js";
export type { AdfMark, AdfNode } from "./adapters/adf.js";
export { renderStorage } from "./adapters/storage.js";
export { renderWikiMarkup } from "./adapters/wikimarkup.js";
export { collectVariables, renderBody } from "./adapters/index.js";
export type { BodyFormat, VariableUse } from "./adapters/index.js";
export { getBuiltinVariables, BUILTIN_VARIABLE_NAMES, formatDate } from "./builtins.js";
```

In `packages/core/src/index.browser.ts` append
`export * from "./templates/render-exports.js";`. Then remove the duplicate
`getBuiltinVariables`/`formatDate`/`BUILTIN_VARIABLE_NAMES` export from
`templates/index.ts`, because `render-exports` now carries them.

- [ ] **Step 5: Run the tests and the browser gate**

Run: `bun run test packages/core/src/templates/`
Expected: PASS

Run: `bun scripts/check-browser-build.ts`
Expected: PASS, no `node:` specifiers in the browser graph. If the script has
another name, list `scripts/` and run the browser-build check that CI uses
(see `.github/workflows`).

- [ ] **Step 6: Commit**

```bash
/usr/bin/git add packages/core/src/templates packages/core/src/index.browser.ts
/usr/bin/git commit -m "feat(core): wiki markup adapter, renderBody dispatch and variable collection"
```

---

### Task 8: Vars file, value resolution and CLI flags

**Files:**
- Create: `packages/core/src/templates/vars-file.ts`, `packages/core/src/templates/vars-file.test.ts`, `apps/cli/src/commands/template-flags.ts`, `apps/cli/src/commands/template-flags.test.ts`
- Modify: `packages/core/src/templates/render-exports.ts`, `apps/cli/src/commands/template.ts:1361-1390`, `apps/cli/src/commands/page.ts:372`, `apps/cli/src/commands/docs.ts:3090`

**Interfaces:**
- Consumes: `TemplateVariable`, `validateVariableValue` (existing `validation.ts`)
- Produces (core, browser-safe, uses `yaml`):

```ts
export interface VarsFile { variables: TemplateVariable[]; values: Record<string, unknown> }
export function parseVarsFile(yamlText: string): VarsFile // throws Error with a clear message
/** Precedence: cli > file values > declared default. Returns values and the declared-required names still missing. */
export function resolveTemplateValues(input: {
  cli: Record<string, unknown>; file?: VarsFile; declarations?: TemplateVariable[];
}): { values: Record<string, unknown>; missing: TemplateVariable[]; errors: string[]; declarations: TemplateVariable[] }
export function unusedVariables(values: Record<string, unknown>, declarations: TemplateVariable[], used: Set<string>): string[]
```

- Produces (CLI):

```ts
export interface TemplateRunInput { values: Record<string, unknown>; declarations: TemplateVariable[]; now: Date; strict: boolean; requested: boolean }
/** Parses --var/--vars-file/--now/--strict. requested = any of --var/--vars-file given. */
export async function parseTemplateFlags(flags: Flags, opts: OutputOptions, extra?: { declarations?: TemplateVariable[] }): Promise<TemplateRunInput>
/** Prompts for declared required variables in a TTY (not with --json/--yes); otherwise fails listing them. */
export async function completeTemplateValues(input: TemplateRunInput, flags: Flags, opts: OutputOptions): Promise<TemplateRunInput>
export function parseVarAssignments(assignments: string[]): Record<string, unknown> // shared by template.ts, page.ts, docs.ts
```

`parseVarAssignments` keeps today's semantics in `template.ts:1361`:
- `key` alone means `true`
- a value that parses as JSON becomes that JSON
- otherwise the value is a string
- new: `a.b=v` nests into `{ a: { b: v } }`

- [ ] **Step 1: Write the failing core tests**

```ts
// packages/core/src/templates/vars-file.test.ts
import { describe, expect, test } from "bun:test";
import { parseVarsFile, resolveTemplateValues, unusedVariables } from "./vars-file.js";

describe("vars file", () => {
  test("full form", () => {
    const f = parseVarsFile("variables:\n  year: { type: number, required: true }\n  quarter: { type: select, options: [Q1, Q2], default: Q1 }\nvalues:\n  year: 2026\n  systems: [IAM]\n");
    expect(f.variables.map((v) => v.name)).toEqual(["year", "quarter"]);
    expect(f.values).toEqual({ year: 2026, systems: ["IAM"] });
  });
  test("short form is values only", () => {
    expect(parseVarsFile("year: 2026\n")).toEqual({ variables: [], values: { year: 2026 } });
  });
  test("rejects a non-object document and bad declarations", () => {
    expect(() => parseVarsFile("- a\n")).toThrow(/mapping/);
    expect(() => parseVarsFile("variables:\n  x: { type: color }\n")).toThrow(/x.*type/);
  });
});

describe("resolveTemplateValues", () => {
  const declarations = [
    { name: "year", type: "number" as const, required: true },
    { name: "quarter", type: "select" as const, options: ["Q1", "Q2"], default: "Q1" },
    { name: "kickoff", type: "date" as const },
  ];
  test("precedence cli > file > default, with type conversion", () => {
    const r = resolveTemplateValues({ cli: { year: "2027" }, file: { variables: [], values: { year: 2026, quarter: "Q2" } }, declarations });
    expect(r.values).toEqual({ year: 2027, quarter: "Q2" });
    expect(r.missing).toEqual([]);
  });
  test("declared required without a value is missing; bad select is an error", () => {
    const r = resolveTemplateValues({ cli: { quarter: "Q9" }, declarations });
    expect(r.missing.map((v) => v.name)).toEqual(["year"]);
    expect(r.errors[0]).toMatch(/quarter/);
  });
  test("file declarations win over operation declarations", () => {
    const r = resolveTemplateValues({ cli: {}, file: { variables: [{ name: "year", type: "string" }], values: {} }, declarations });
    expect(r.missing).toEqual([]);
  });
  test("unused variables", () => {
    expect(unusedVariables({ year: 1, yaer: 2 }, [], new Set(["year"]))).toEqual(["yaer"]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun run test packages/core/src/templates/vars-file.test.ts`
Expected: FAIL, module not found

- [ ] **Step 3: Implement `vars-file.ts`**

```ts
// packages/core/src/templates/vars-file.ts
import { parse } from "yaml";
import type { TemplateVariable, VariableType } from "./types.js";
import { validateVariableValue } from "./validation.js";

export interface VarsFile { variables: TemplateVariable[]; values: Record<string, unknown> }
const TYPES: VariableType[] = ["string", "number", "date", "boolean", "select"];
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export function parseVarsFile(yamlText: string): VarsFile {
  const doc = parse(yamlText) ?? {};
  if (!isObject(doc)) throw new Error("Vars file must be a YAML mapping");
  const full = "variables" in doc || "values" in doc;
  const values = full ? (doc.values ?? {}) : doc;
  if (!isObject(values)) throw new Error("Vars file: values must be a mapping");
  const declared = full ? (doc.variables ?? {}) : {};
  if (!isObject(declared)) throw new Error("Vars file: variables must be a mapping");
  const variables = Object.entries(declared).map(([name, d]): TemplateVariable => {
    const def = isObject(d) ? d : {};
    const type = (def.type ?? "string") as VariableType;
    if (!TYPES.includes(type)) throw new Error(`Vars file: variable ${name} has unknown type "${String(def.type)}"`);
    if (type === "select" && !Array.isArray(def.options)) throw new Error(`Vars file: select variable ${name} needs options`);
    return {
      name, type,
      ...(def.required === true ? { required: true } : {}),
      ...(def.default !== undefined ? { default: String(def.default) } : {}),
      ...(typeof def.description === "string" ? { description: def.description } : {}),
      ...(Array.isArray(def.options) ? { options: def.options.map(String) } : {}),
    };
  });
  return { variables, values };
}

export function resolveTemplateValues(input: { cli: Record<string, unknown>; file?: VarsFile; declarations?: TemplateVariable[] }) {
  const byName = new Map<string, TemplateVariable>();
  for (const d of input.declarations ?? []) byName.set(d.name, d);
  for (const d of input.file?.variables ?? []) byName.set(d.name, d);
  const merged: Record<string, unknown> = { ...(input.file?.values ?? {}), ...input.cli };
  const values: Record<string, unknown> = {};
  const missing: TemplateVariable[] = [];
  const errors: string[] = [];
  for (const [name, value] of Object.entries(merged)) {
    const d = byName.get(name);
    if (!d || typeof value === "object") { values[name] = value; continue; }
    const r = validateVariableValue(value, d);
    if (r.valid) values[name] = r.coerced; else errors.push(r.error ?? `Invalid value for ${name}`);
  }
  for (const d of byName.values()) {
    if (d.name in merged) continue;
    if (d.default !== undefined) values[d.name] = validateVariableValue(d.default, d).coerced;
    else if (d.required) missing.push(d);
  }
  return { values, missing, errors, declarations: [...byName.values()] };
}

export function unusedVariables(values: Record<string, unknown>, declarations: TemplateVariable[], used: Set<string>): string[] {
  const names = new Set([...Object.keys(values), ...declarations.map((d) => d.name)]);
  return [...names].filter((n) => !used.has(n)).sort();
}
```

Check `validateVariableValue`'s behaviour for `number` (does `coerced` become a
number?) and for `select` errors by reading `validation.ts:22-118`. If
`coerced` stays a string for numbers, convert with `Number()` in
`resolveTemplateValues`, so the test's `year: 2027` holds.

Export `parseVarsFile`, `resolveTemplateValues`, `unusedVariables` and
`VarsFile` from `render-exports.ts`.

- [ ] **Step 4: Run the core tests**

Run: `bun run test packages/core/src/templates/vars-file.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing CLI tests**

```ts
// apps/cli/src/commands/template-flags.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTemplateFlags, parseVarAssignments } from "./template-flags.js";

const opts = { json: true } as never;

describe("parseVarAssignments", () => {
  test("keeps the old semantics and adds nesting", () => {
    expect(parseVarAssignments(["flag", "n=5", "s=hi", 'list=["a"]', "a.b=c"])).toEqual({ flag: true, n: 5, s: "hi", list: ["a"], a: { b: "c" } });
  });
});

describe("parseTemplateFlags", () => {
  test("reads --vars-file, --var, --now and --strict", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlcli-vars-"));
    const file = join(dir, "v.yml");
    await writeFile(file, "variables:\n  year: { type: number }\nvalues:\n  year: 2026\n");
    const r = await parseTemplateFlags({ "vars-file": file, var: ["year=2027"], now: "2026-10-25T00:00:00Z", strict: true }, opts);
    expect(r).toMatchObject({ values: { year: 2027 }, strict: true, requested: true });
    expect(r.now.toISOString()).toBe("2026-10-25T00:00:00.000Z");
  });
  test("without flags nothing is requested and now is the current time", async () => {
    const r = await parseTemplateFlags({}, opts);
    expect(r.requested).toBe(false);
    expect(Math.abs(r.now.getTime() - Date.now())).toBeLessThan(5000);
  });
});
```

Missing-variable failure without a TTY calls `fail()`, which exits the
process. Test it through a spawned CLI in Task 11's CLI test (`jira template
apply` without a TTY), not here.

- [ ] **Step 6: Implement `template-flags.ts`**

```ts
// apps/cli/src/commands/template-flags.ts
import { readFile } from "node:fs/promises";
import { ERROR_CODES, fail, getFlag, getFlags, hasFlag, isInteractive, parseVarsFile, promptInput, resolveTemplateValues, type OutputOptions, type TemplateVariable } from "@atlcli/core";

type Flags = Record<string, string | boolean | string[]>;
export interface TemplateRunInput { values: Record<string, unknown>; declarations: TemplateVariable[]; now: Date; strict: boolean; requested: boolean; missing: TemplateVariable[] }

export function parseVarAssignments(assignments: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of assignments) {
    const eq = a.indexOf("=");
    const key = eq === -1 ? a : a.slice(0, eq);
    let value: unknown = true;
    if (eq !== -1) {
      const raw = a.slice(eq + 1);
      try { value = JSON.parse(raw); } catch { value = raw; }
    }
    const parts = key.split(".");
    let node = out;
    for (const p of parts.slice(0, -1)) node = (node[p] ??= {}) as Record<string, unknown>;
    node[parts.at(-1)!] = value;
  }
  return out;
}

export async function parseTemplateFlags(flags: Flags, opts: OutputOptions, extra: { declarations?: TemplateVariable[] } = {}): Promise<TemplateRunInput> {
  const path = getFlag(flags, "vars-file");
  let file;
  if (path) {
    try { file = parseVarsFile(await readFile(path, "utf8")); }
    catch (e) { fail(opts, 1, ERROR_CODES.USAGE, `--vars-file ${path}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  const nowFlag = getFlag(flags, "now");
  const now = nowFlag ? new Date(nowFlag) : new Date();
  if (Number.isNaN(now.getTime())) fail(opts, 1, ERROR_CODES.USAGE, `--now expects an ISO date or datetime, got "${nowFlag}"`);
  const cli = parseVarAssignments(getFlags(flags, "var"));
  const r = resolveTemplateValues({ cli, file, declarations: extra.declarations });
  if (r.errors.length) fail(opts, 1, ERROR_CODES.USAGE, r.errors.join("\n"));
  return { values: r.values, declarations: r.declarations, now, strict: hasFlag(flags, "strict"), requested: Boolean(path) || getFlags(flags, "var").length > 0, missing: r.missing };
}

export async function completeTemplateValues(input: TemplateRunInput, flags: Flags, opts: OutputOptions): Promise<TemplateRunInput> {
  if (input.missing.length === 0) return input;
  const list = input.missing.map((v) => `${v.name}${v.description ? ` (${v.description})` : ""}`).join(", ");
  if (opts.json || hasFlag(flags, "yes") || !isInteractive()) {
    fail(opts, 1, ERROR_CODES.USAGE, `Missing required template variables: ${list}. Pass --var name=value or --vars-file.`);
  }
  const values = { ...input.values };
  for (const v of input.missing) values[v.name] = await promptInput(`${v.name}${v.description ? ` (${v.description})` : ""}: `);
  return { ...input, values, missing: [] };
}
```

Check the exact names: `isInteractive` is imported in `template.ts:18`, so use
the same import path. For the prompt helper, check `packages/core/src/prompt.ts`
and use the exported prompt function's real name. Then replace `parseVarFlags`
in `template.ts`, and the inline `flags["var"]` parsing in `page.ts:372` and
`docs.ts:3090`, with `parseVarAssignments(getFlags(flags, "var"))`. Keep each
call site's later handling unchanged.

- [ ] **Step 7: Run CLI and template tests**

Run: `bun run test apps/cli/src/commands/template-flags.test.ts apps/cli/src/commands/template`
Expected: PASS, including the existing wiki-template CLI tests

- [ ] **Step 8: Commit**

```bash
/usr/bin/git add packages/core/src/templates/vars-file.ts packages/core/src/templates/vars-file.test.ts packages/core/src/templates/render-exports.ts apps/cli/src/commands/template-flags.ts apps/cli/src/commands/template-flags.test.ts apps/cli/src/commands/template.ts apps/cli/src/commands/page.ts apps/cli/src/commands/docs.ts
/usr/bin/git commit -m "feat(cli): shared --var, --vars-file, --now and --strict parsing"
```

---

### Task 9: `atlcli.render()` in the script runtime

**Files:**
- Modify: `packages/script-runtime/src/port.ts`, `verbs.ts`, `plan.ts`, `sandbox.ts:68-77`, `script-types.ts`
- Modify: `apps/cli/src/commands/script-port.ts`, `apps/cli/src/commands/script.ts`
- Test: `packages/script-runtime/src/verbs.test.ts`, `packages/script-runtime/src/plan-apply.test.ts`, `apps/cli/src/commands/script-port.test.ts`

**Interfaces:**
- Consumes: `renderBody`, `createTemplateScope`, `RenderBudget`, `RenderError` from `@atlcli/core` (CLI side only)
- Produces:
  - `ScriptPort.render(input: unknown, options: { format?: "text" | "adf" | "storage" | "wikimarkup"; vars: Record<string, unknown>; source?: unknown; parent?: unknown; unit: string; now: string; strict: boolean }): { value: unknown; warnings: TemplateWarningView[] }`. It is synchronous and pure; it throws `Error` with `name = "RenderError"` on strict failure or a limit.
  - `export interface TemplateWarningView { code: string; message: string; unit?: string; line?: number; column?: number }` in `port.ts`.
  - `PlanScriptOptions.templating?: { vars: Record<string, unknown>; now: string; strict: boolean }`.
  - `ScriptRunPlan.templating?: { now: string; vars: Record<string, unknown> }` and `ScriptRunPlan.renderWarnings: TemplateWarningView[]`.
  - `ScriptPlanV1.templating?` and `ScriptPlanV1.renderWarnings?`, both optional in the zod schema. Old plans without them still parse, and the digest covers them.
  - `ScriptErrorKind` gains `"template"`.
  - Guest API: `atlcli.render(input, { vars?, format?, source?, parent?, unit? })` returns the rendered value. A per-call `vars` wins over run vars. The default unit is `"render#<n>"`.

- [ ] **Step 1: Write the failing runtime tests**

Add to `packages/script-runtime/src/verbs.test.ts`. It uses that file's
existing fake-port helper; extend the fake with
`render: (input, o) => ({ value: typeof input === "string" ? input.replace("{{year}}", String(o.vars.year)) : input, warnings: String(input).includes("{{nope}}") ? [{ code: "unresolved", message: "Unresolved {{nope}}", unit: o.unit }] : [] })`:

```ts
describe("atlcli.render", () => {
  test("renders with run vars, call vars win, warnings land in the plan", async () => {
    const run = await planScript(
      `export default () => [atlcli.render("Y{{year}}"), atlcli.render("Y{{year}}", { vars: { year: 1 } }), atlcli.render("{{nope}}")]`,
      { port: fakePort(), templating: { vars: { year: 2026 }, now: "2026-10-25T00:00:00.000Z", strict: false } },
    );
    expect(run.value).toEqual(["Y2026", "Y1", "{{nope}}"]);
    expect(run.renderWarnings.map((w) => w.code)).toEqual(["unresolved"]);
    expect(run.templating).toEqual({ now: "2026-10-25T00:00:00.000Z", vars: { year: 2026 } });
    expect(run.operations).toEqual([]);
  });
  test("a render error ends the run as a template ScriptError", async () => {
    const port = { ...fakePort(), render: () => { const e = new Error("Template warnings with --strict"); e.name = "RenderError"; throw e; } };
    await expect(planScript(`atlcli.render("x")`, { port })).rejects.toMatchObject({ name: "ScriptError", kind: "template" });
  });
});
```

Add to `plan-apply.test.ts`:

```ts
test("plans keep templating and render warnings in the digest, old plans still parse", async () => {
  const plan = await createScriptPlan({ ...runFixture(), templating: { now: "2026-10-25T00:00:00.000Z", vars: { y: 1 } }, renderWarnings: [{ code: "unresolved", message: "m" }] }, planOptions());
  const parsed = await parseScriptPlan(serializeScriptPlan(plan));
  expect(parsed.templating?.now).toBe("2026-10-25T00:00:00.000Z");
  const tampered = { ...JSON.parse(serializeScriptPlan(plan)), templating: { now: "2027-01-01T00:00:00.000Z", vars: {} } };
  await expect(parseScriptPlan(tampered)).rejects.toThrow(/digest/i);
  const old = JSON.parse(serializeScriptPlan(await createScriptPlan(runFixture(), planOptions())));
  delete old.templating; delete old.renderWarnings;
  // re-digest as an old writer would have
  await expect(parseScriptPlan(old)).resolves.toBeDefined();
});
```

Use that file's existing fixtures. If `runFixture`/`planOptions` don't exist
under those names, build the `ScriptRunPlan` inline as the neighbouring tests
do. The last assertion must use a plan created *without* templating, so its
digest is valid.

- [ ] **Step 2: Run them to see them fail**

Run: `bun run test packages/script-runtime/src/verbs.test.ts packages/script-runtime/src/plan-apply.test.ts`
Expected: FAIL, `atlcli.render is not a function` / missing fields

- [ ] **Step 3: Implement the runtime side**

`port.ts`: add `render(...)` to `ScriptPort` with the doc comment "Pure;
renders a template with the host's engine. Never IO." Also add
`TemplateWarningView`.

`verbs.ts`:

```ts
// in PlanScriptOptions:
  /** Template vars and the frozen clock for atlcli.render (CLI --var/--vars-file/--now/--strict). */
  templating?: { vars: Record<string, unknown>; now: string; strict: boolean };
// in ScriptRunPlan:
  templating?: { now: string; vars: Record<string, unknown> };
  renderWarnings: TemplateWarningView[];

// Recorder gets: readonly renderWarnings: TemplateWarningView[] = []; renderCount = 0;
//   constructor(..., readonly templating = { vars: {}, now: new Date().toISOString(), strict: false })

const renderOptions = z.strictObject({
  vars: z.record(z.string(), z.unknown()).optional(),
  format: z.enum(["text", "adf", "storage", "wikimarkup"]).optional(),
  source: z.unknown().optional(),
  parent: z.unknown().optional(),
  unit: z.string().optional(),
});

// in VERBS:
  render: verb(z.tuple([z.unknown(), renderOptions.optional()]), async (r, [input, o = {}]) => {
    const unit = o.unit ?? `render#${++r.renderCount}`;
    try {
      const out = r.port.render(input, {
        format: o.format, source: o.source, parent: o.parent, unit,
        vars: { ...r.templating.vars, ...(o.vars ?? {}) },
        now: r.templating.now, strict: r.templating.strict,
      });
      r.renderWarnings.push(...out.warnings);
      return out.value;
    } catch (error) {
      if ((error as Error)?.name === "RenderError") throw new ScriptError("template", (error as Error).message);
      throw error;
    }
  }),
```

In `planScript`, pass `options.templating` into `new Recorder(...)`. Return
`renderWarnings: recorder.renderWarnings` and, when `options.templating` is
set, `templating: { now: options.templating.now, vars: options.templating.vars }`.
`render` is not a write verb, so it is not added to `WRITE_VERBS` or
`meta.permissions` checks.

`sandbox.ts`: add `| "template"` to `ScriptErrorKind`, with the comment
`// atlcli.render failed (--strict, output limit)`.

`plan.ts`: add the optional fields to `ScriptPlanV1` and the zod schema in
`parseScriptPlan`. `createScriptPlan` copies `run.templating` and, when
non-empty, `run.renderWarnings` into the plan *before* digesting. Omit
`renderWarnings` when empty, so plans of scripts that never render stay
byte-identical to today's.

`script-types.ts`: add the `render` declaration next to the other `atlcli`
members, matching their doc-comment style:

```ts
/**
 * Renders a template with atlcli's engine (Handlebars, tolerant). A string is
 * plain text unless `format` says otherwise; an object with `type: "doc"` is
 * ADF. Unresolved `{{…}}` stays literal and is reported in the plan.
 */
render<T>(input: T, options?: { vars?: Record<string, unknown>; format?: "text" | "adf" | "storage" | "wikimarkup"; source?: unknown; parent?: unknown; unit?: string }): T;
```

Check: `script-types.test.ts` compares this file with `SCRIPT_VERBS`. Update
the expectation if it lists verbs explicitly.

- [ ] **Step 4: Implement the CLI side**

`script-port.ts`: add to the object returned by the port factory (next to
`confluenceNormalizeMarkdown`):

```ts
render(input, o) {
  const scope = createTemplateScope({ vars: o.vars, now: new Date(o.now), profile: profile.name, source: o.source, parent: o.parent });
  return renderBody(input, scope, { unit: o.unit, format: o.format, strict: o.strict, budget });
},
```

`budget` is one `new RenderBudget()` created per port instance, so one run
shares the 16 MB. Add `script-port.test.ts` coverage: a port renders
`"{{@today}}"` with `now: "2026-10-25T00:00:00.000Z"` to `"2026-10-25"`.

`script.ts`:
- `runCommand` and `planCommand` (if separate) call
  `const templating = await parseTemplateFlags(flags, opts)` and then
  `completeTemplateValues` only when `templating.declarations` is non-empty.
- Add a `templating?: { vars; now; strict }` argument to `planAndApply` and
  pass it to `rt.planScript(..., { templating })` as
  `{ vars: templating.values, now: templating.now.toISOString(), strict: templating.strict }`.
- `renderPlan` (the text plan renderer) adds, when present:

```
Templates: rendered at 2026-10-25T08:30:00.000Z (re-plan with --now 2026-10-25T08:30:00.000Z to repeat)
Template warnings (3):
  TPL-1 summary 1:6  Unresolved {{custmer}}
```

  Show at most 20 warnings, then `… and N more (see --json)`.
- `--json` output already carries `plan`, which now has `templating` and
  `renderWarnings`.
- Help text: add `--var`, `--vars-file`, `--now`, `--strict` to the
  `script run` help block.

- [ ] **Step 5: Add the determinism regression test (Review Focus 5)**

In `apps/cli/src/builtin-scripts/copy-issues.test.ts` (it plans in the real
sandbox), after Task 10 adds rendering, add:

```ts
it("same --now gives the same plan", async () => {
  const templating = { vars: { year: 2026 }, now: "2026-10-25T08:30:00.000Z", strict: false };
  const a = await planScript(script, { port: new FakeJira().port(), params: baseParams, templating });
  const b = await planScript(script, { port: new FakeJira().port(), params: baseParams, templating });
  expect(b.operations).toEqual(a.operations);
});
```

`baseParams` is the params object the file already uses; the fake port gets
the real CLI `render` (import `renderBody`/`createTemplateScope` from
`@atlcli/core` and build the same function as `script-port.ts`). Put a
`makeRender()` helper at the top of the test file.

- [ ] **Step 6: Run the tests**

Run: `bun run test packages/script-runtime/ apps/cli/src/commands/script-port.test.ts apps/cli/src/commands/script`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
/usr/bin/git add packages/script-runtime/src apps/cli/src/commands/script-port.ts apps/cli/src/commands/script-port.test.ts apps/cli/src/commands/script.ts
/usr/bin/git commit -m "feat(script): atlcli.render with frozen clock, vars and plan-recorded warnings"
```

---

### Task 10: copy-issues and clone render templates

**Files:**
- Modify: `apps/cli/src/builtin-scripts/copy-issues.script`, `apps/cli/src/builtin-scripts/copy-issues.test.ts`, `apps/cli/src/commands/jira.ts:545-620,1676-1760`
- Test: `apps/cli/src/commands/jira-copy-issues-cli.test.ts`

**Interfaces:**
- Consumes: `atlcli.render` (Task 9), `parseTemplateFlags` (Task 8), `renderBody`, `renderTextField`, `renderJiraFieldValue`, `createTemplateScope`, `RenderBudget` (core)
- Produces: copy-issues and clone accept `--var`, `--vars-file`, `--now`, `--strict`.

Script changes (`copy-issues.script`):
- Remove `PLACEHOLDER`, `textOf` and the leftover-placeholder warning loop.
- `replaceText`/`replaceBody` stay; `--replace` pairs apply first.
- Build `source = { key: issue.key, id: issue.id, summary: f.summary, project: issue.key.split("-")[0], fields: f }`
  and `unit = (name) => \`${issue.key} ${name}\``.
- `summary = atlcli.render(replaceText(f.summary, pairs), { source, unit: unit("summary") })`
- `copyFields.description = atlcli.render(replaceBody(f.description, pairs), { source, unit: unit("description"), format: typeof f.description === "string" ? "wikimarkup" : "adf" })`
- `copyFields.labels = f.labels.map((l, i) => atlcli.render(l, { source, unit: unit(\`label ${i + 1}\`) }))`
- components and fixVersions: `name: atlcli.render(c.name, { source, unit: unit("component") })`
- extra custom fields (`--fields`): strings and `{ value }`/`{ name }` shapes go
  through `atlcli.render` per string leaf. Add a small `renderLeaves(value, source, unitName)`
  function in the script that maps strings and `value`/`name` keys and leaves
  other objects as they are.
- Comments with `--comments`: `atlcli.render(commentBody(...), { source, unit: unit(\`comment ${n}\`), format: typeof body === "string" ? "wikimarkup" : "adf" })`.
  Mention stripping happens first, as today.
- Label and summary validity: the `jira.create` zod schema already rejects
  whitespace labels and empty summaries, and the run fails as a ScriptError
  with that message. That is acceptable and needs no extra check.

CLI changes (`jira.ts`):
- In the copy-issues handler, call `parseTemplateFlags(flags, opts)` and pass
  the templating object to `planAndApply`.
- Add `--var`, `--vars-file`, `--now`, `--strict` to the copy-issues and clone
  help text and the usage examples.
- In `handleIssueClone`, after `replaceInBody`, build
  `const scope = createTemplateScope({ vars: t.values, now: t.now, profile: profile?.name, source: { key, id: issue.id, summary: f.summary, project: key.split("-")[0], fields: f } })`.
  Render summary, description (`format` by type), labels and `--fields`
  leaves with `renderTextField`/`renderBody`/`renderJiraFieldValue` and one
  `RenderBudget`, collecting warnings. Then:
  - Add `warnings[]` entries for render warnings (keep the legacy `warning`
    field as is).
  - In text mode, print `Template warnings:` lines.
  - With `t.strict` and warnings, `fail(opts, 1, ERROR_CODES.VALIDATION, …)`
    *before* creating anything.

- [ ] **Step 1: Write the failing tests**

In `copy-issues.test.ts` (the fake already has `summary: "Release {{version}} checks"`):

```ts
it("renders summary, description, labels and comments from --var", async () => {
  const jira = new FakeJira();
  jira.source[0]!.fields.labels = ["rel-{{version}}"];
  const run = await planScript(script, { port: jira.port(), params: { ...baseParams, comments: true }, templating: { vars: { version: "4.2" }, now: "2026-10-25T00:00:00.000Z", strict: false } });
  const create = run.operations.find((o) => o.verb === "jira.create")!;
  expect(create.args.summary).toBe("Release 4.2 checks");
  expect(JSON.stringify(create.args.fields)).toContain("Ship 4.2 after ");
  expect((create.args.fields as { labels: string[] }).labels).toEqual(["rel-4.2"]);
});
it("leaves unknown placeholders literal and reports them in renderWarnings", async () => {
  const run = await planScript(script, { port: new FakeJira().port(), params: baseParams });
  expect(run.operations.find((o) => o.verb === "jira.create")!.args.summary).toBe("Release {{version}} checks");
  expect(run.renderWarnings.some((w) => w.unit === "SUP-1 summary" && w.code === "unresolved")).toBe(true);
  expect((run.value as { warnings: string[] }).warnings.some((w) => w.includes("placeholder"))).toBe(false);
});
it("applies --replace before rendering", async () => {
  const run = await planScript(script, { port: new FakeJira().port(), params: { ...baseParams, replace: JSON.stringify([["{{version}}", "{{v}}"]]) }, templating: { vars: { v: "9" }, now: "2026-10-25T00:00:00.000Z", strict: false } });
  expect(run.operations.find((o) => o.verb === "jira.create")!.args.summary).toBe("Release 9 checks");
});
it("strict fails the plan on a leftover placeholder", async () => {
  await expect(planScript(script, { port: new FakeJira().port(), params: baseParams, templating: { vars: {}, now: "2026-10-25T00:00:00.000Z", strict: true } })).rejects.toMatchObject({ kind: "template" });
});
```

The fake port must use the real renderer: `render: makeRender()` from Task 9
Step 5.

In `jira-copy-issues-cli.test.ts`, add a help assertion: `jira project copy-issues --help`
output contains `--vars-file` and `--strict`.

- [ ] **Step 2: Run them to see them fail**

Run: `bun run test apps/cli/src/builtin-scripts/copy-issues.test.ts apps/cli/src/commands/jira-copy-issues-cli.test.ts`
Expected: FAIL, summary still has `{{version}}` and the help lacks the flags

- [ ] **Step 3: Implement the script and CLI changes above**

- [ ] **Step 4: Add a clone unit test**

Find the existing clone tests (`rtk proxy grep -rln "handleIssueClone\|issue clone" apps/cli/src/commands/*.test.ts`).
If clone is only covered by E2E, extract the field-building part of
`handleIssueClone` into an exported pure function
`buildCloneFields(f, { pairs, scope, budget, extraFields })` → `{ summary, fields, warnings }`
in `jira.ts`, and test it in `apps/cli/src/commands/jira-clone-render.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createTemplateScope, RenderBudget } from "@atlcli/core";
import { buildCloneFields } from "./jira.js";

describe("clone rendering", () => {
  test("renders summary, description and labels; replace runs first", () => {
    const scope = createTemplateScope({ vars: { v: "2" }, source: { key: "A-1" } });
    const out = buildCloneFields(
      { summary: "R {{x}}", description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "{{source.key}}" }] }] }, labels: ["l-{{v}}"] },
      { pairs: [["{{x}}", "{{v}}"]], scope, budget: new RenderBudget(), extraFields: [] },
    );
    expect(out.summary).toBe("R 2");
    expect(JSON.stringify(out.fields.description)).toContain("A-1");
    expect(out.fields.labels).toEqual(["l-2"]);
  });
});
```

- [ ] **Step 5: Run the tests**

Run: `bun run test apps/cli/src/builtin-scripts/ apps/cli/src/commands/jira-copy-issues-cli.test.ts apps/cli/src/commands/jira-clone-render.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
/usr/bin/git add apps/cli/src/builtin-scripts/copy-issues.script apps/cli/src/builtin-scripts/copy-issues.test.ts apps/cli/src/commands/jira.ts apps/cli/src/commands/jira-copy-issues-cli.test.ts apps/cli/src/commands/jira-clone-render.test.ts
/usr/bin/git commit -m "feat(jira): render templates in copy-issues and clone"
```

---

### Task 11: `jira template` variables

**Files:**
- Modify: `packages/jira/src/templates.ts:43-51`, `apps/cli/src/commands/jira.ts:6800-7060` (template save/get/apply)
- Test: `apps/cli/src/commands/jira-template-level.test.ts` (existing), new `apps/cli/src/commands/jira-template-vars.test.ts`

**Interfaces:**
- Consumes: `collectVariables`, `renderBody`, `renderTextField`, `renderJiraFieldValue`, `createTemplateScope`, `RenderBudget`, `TemplateVariable` (core); `parseTemplateFlags`, `completeTemplateValues` (Task 8)
- Produces:
  - `JiraTemplate.variables?: TemplateVariable[]`
  - exported pure function in `jira.ts`: `inferTemplateVariables(fields: JiraTemplateFields): TemplateVariable[]`, inferred required strings, sorted by name
  - `renderTemplateFields(fields, scope, budget): { fields: JiraTemplateFields; warnings: RenderWarning[] }`, which renders summary (`summary` kind), description (`renderBody`, format by type), labels (`label`), components/fixVersions names, `duedate` (`date`) and other custom fields (`renderJiraFieldValue`)

- [ ] **Step 1: Write the failing tests**

```ts
// apps/cli/src/commands/jira-template-vars.test.ts
import { describe, expect, test } from "bun:test";
import { createTemplateScope, RenderBudget } from "@atlcli/core";
import { inferTemplateVariables, renderTemplateFields } from "./jira.js";

const fields = {
  issuetype: { name: "Task" },
  summary: "Release {{version}}",
  description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Owner {{owner}} on {{@today}}" }] }] },
  labels: ["rel-{{version}}"],
  duedate: "{{dateAdd @today 14 \"d\"}}",
};

describe("jira template variables", () => {
  test("infers used variables as required strings", () => {
    expect(inferTemplateVariables(fields as never)).toEqual([
      { name: "owner", type: "string", required: true },
      { name: "version", type: "string", required: true },
    ]);
  });
  test("renders every templated field", () => {
    const scope = createTemplateScope({ vars: { version: "4.2", owner: "Ann" }, now: new Date("2026-10-25T00:00:00Z") });
    const out = renderTemplateFields(fields as never, scope, new RenderBudget());
    expect(out.fields.summary).toBe("Release 4.2");
    expect(out.fields.labels).toEqual(["rel-4.2"]);
    expect(out.fields.duedate).toBe("2026-11-08");
    expect(JSON.stringify(out.fields.description)).toContain("Owner Ann on 2026-10-25");
  });
  test("old templates without variables render by inference only", () => {
    const scope = createTemplateScope({ vars: {} });
    expect(renderTemplateFields({ issuetype: { name: "Bug" }, summary: "Plain" } as never, scope, new RenderBudget()).warnings).toEqual([]);
  });
});
```

Also add a spawned-CLI test to the same file that runs
`bun --conditions=development run --cwd apps/cli src/index.ts jira template apply rel --project X --json`.
Use a temp `ATLCLI_TEMPLATES_DIR`/home holding a project-less global template
with `variables: [{ name: "version", type: "string", required: true }]`. It
asserts exit code 1 and a JSON error mentioning `Missing required template
variables: version`, without any network call; the check happens before
`getClient`. Follow how `jira-template-level.test.ts` isolates the template
directory (copy its setup), and set a 30 s timeout on this test (spawn-heavy;
see the release memory note about CI runners).

- [ ] **Step 2: Run them to see them fail**

Run: `bun run test apps/cli/src/commands/jira-template-vars.test.ts`
Expected: FAIL, exports missing

- [ ] **Step 3: Implement**

- `packages/jira/src/templates.ts`: add `variables?: TemplateVariable[];` to
  `JiraTemplate`, importing the type from `@atlcli/core` (the package already
  depends on core; check `packages/jira/package.json`, and if not, declare a
  local identical `TemplateVariable` interface instead of adding a dependency).
- `inferTemplateVariables`:
  `collectVariables([{ unit: "summary", value: f.summary }, { unit: "description", value: f.description, format: typeof f.description === "string" ? "wikimarkup" : "adf" }, ...other string leaves])`,
  then dedupe by name, map to `{ name, type: "string", required: true }` and
  sort.
- `template save --issue`: set `template.variables = inferTemplateVariables(template.fields)`
  when non-empty. Print `Variables: owner, version` in text mode.
- `template get`: text output gets a `Variables:` section
  (`name  type  required  default  description`); JSON already includes the
  field.
- `template apply`:
  - Resolve the template **before** `getClient`, so a missing variable fails
    without a connection.
  - `const t = await completeTemplateValues(await parseTemplateFlags(flags, opts, { declarations: template.variables ?? [] }), flags, opts)`.
  - `scope = createTemplateScope({ vars: t.values, now: t.now, project: projectKey, profile })`.
  - `renderTemplateFields(template.fields, scope, new RenderBudget())`.
  - With strict and warnings, fail.
  - `--summary` / `--description` overrides are rendered as templates too.
  - Pass the rendered fields to `templateToCreateInput`.
  - Add `warnings` to the JSON output and print them in text mode.
- Help: document `--var`, `--vars-file`, `--now`, `--strict` for apply.

- [ ] **Step 4: Run the tests**

Run: `bun run test apps/cli/src/commands/jira-template-vars.test.ts apps/cli/src/commands/jira-template-level.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add packages/jira/src/templates.ts apps/cli/src/commands/jira.ts apps/cli/src/commands/jira-template-vars.test.ts
/usr/bin/git commit -m "feat(jira): template variables for jira template save, get and apply"
```

---

### Task 12: Confluence port operations for raw storage copies

**Files:**
- Modify: `packages/script-runtime/src/port.ts`, `verbs.ts`, `apply.ts`, `script-types.ts`; `apps/cli/src/commands/script-port.ts`; `packages/confluence/src/client.ts` (only if a method below is missing)
- Test: `packages/script-runtime/src/verbs.test.ts`, `packages/script-runtime/src/plan-apply.test.ts`

**Interfaces:**
- Produces (port):
  - `confluenceGetPageStorage(id, { signal }): Promise<{ id; title; spaceKey; parentId?; version; storage: string; properties: Record<string, unknown> }>`; `properties` contains `atlcli.copiedFrom` when set
  - `confluenceChildren(id, { signal }): Promise<ConfluencePageRef[]>`, direct child pages
  - `confluenceCopyAttachment(attachmentId: string, sourcePageId: string, toPageId: string): Promise<{ id: string }>`, streamed host-side like `jiraCopyAttachment`
  - `confluenceCreatePage` input gains `storage?: string` (exclusive with `markdown`) and `properties?: Record<string, unknown>`
- Produces (guest verbs):
  - `confluence.getPage(id, { storage: true })` returns the storage view (read)
  - `confluence.children(id)` (read)
  - `confluence.createPage({ space, title, parent?, storage, properties? })`; `markdown` or `storage`, exactly one
  - `confluence.copyAttachment(attachmentId, sourcePageId, toPageId)`: a write verb, not a producer; precondition `confluence-page-unchanged` on the source page version. It is skipped when the target already has an attachment of that name and size (read `confluenceAttachments` of the target when it is not a `plan:` ref).
  - `WRITE_VERBS` gains `"confluence.copyAttachment"`; apply dispatches it to `port.confluenceCopyAttachment`, resolving `plan:` refs as for other verbs.

- [ ] **Step 1: Write the failing tests**

In `verbs.test.ts`, extend the fake port with `confluenceGetPageStorage`,
`confluenceChildren`, `confluenceAttachments` and `confluenceCopyAttachment`
(throwing on call during planning), then:

```ts
describe("confluence storage copies", () => {
  test("createPage with storage and properties records one producer op", async () => {
    const run = await planScript(`
      const src = await atlcli.confluence.getPage("10", { storage: true });
      const page = await atlcli.confluence.createPage({ space: "DOCSY", title: "Copy", storage: src.storage, properties: { "atlcli.copiedFrom": { id: src.id } } });
      await atlcli.confluence.copyAttachment("att1", "10", page.id);
    `, { port: fakePort() });
    expect(run.operations.map((o) => o.verb)).toEqual(["confluence.createPage", "confluence.copyAttachment"]);
    expect(run.operations[0]!.args).toMatchObject({ storage: "<p>x</p>", properties: { "atlcli.copiedFrom": { id: "10" } } });
    expect(run.operations[1]!.dependsOn).toEqual([1]);
  });
  test("createPage rejects markdown and storage together", async () => {
    await expect(planScript(`await atlcli.confluence.createPage({ space: "D", title: "T", markdown: "a", storage: "<p/>" })`, { port: fakePort() })).rejects.toThrow(/markdown or storage/);
  });
});
```

In `plan-apply.test.ts`: applying a plan with `confluence.createPage` (storage
plus properties) and `confluence.copyAttachment` calls
`port.confluenceCreatePage({ …, storage, properties })` and then
`port.confluenceCopyAttachment("att1", "10", "<created id>")`.

- [ ] **Step 2: Run them to see them fail**

Run: `bun run test packages/script-runtime/src/verbs.test.ts packages/script-runtime/src/plan-apply.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

Follow the existing `confluence.createPage`, `confluence.attach` and
`jira.copyAttachment` implementations in `verbs.ts`/`apply.ts`. Mirror their
zod schemas, `r.record(...)` calls, precondition builders and apply dispatch,
changing only names and arguments. `pageInput` gains
`storage: z.string().optional()` and `properties: z.record(str, z.unknown()).optional()`
with a `.refine` for "markdown or storage". The unchanged-page skip in
`updatePage` is not affected.

CLI port (`script-port.ts`):
- `confluenceGetPageStorage`: use the existing `client.getPage(id)` (it
  returns `storage`, `title`, `spaceKey`, `parentId`, `version`). For
  properties, read the content property `atlcli.copiedFrom`. If
  `ConfluenceClient` has no content-property method, add
  `getContentProperty(pageId, key)` and `setContentProperty(pageId, key, value)`
  to `packages/confluence/src/client.ts` using
  `GET/POST /wiki/rest/api/content/{id}/property/{key}` (Cloud and DC share this
  v1 endpoint). Return `undefined` on 404.
- `confluenceChildren`: `client.getChildren(id, { limit: 250 })` mapped to refs,
  paging if the method supports a cursor.
- `confluenceCreatePage` with `storage`: `client.createPage({ spaceKey, title, storage, parentId })`,
  then `setContentProperty` for each property.
- `confluenceCopyAttachment`: download the source attachment stream to a temp
  file and upload it to the target, as `copyAttachment` in
  `packages/jira/src/attachment-copy.ts` does for Jira (mkdtemp, mode 0600,
  size check, cleanup in `finally`). If the Confluence client lacks a streaming
  download, add `openAttachment(pageId, attachmentId): Promise<Response>`
  following the Jira client's `openAttachment`.
- Add `script-types.ts` declarations for the new and extended verbs.

- [ ] **Step 4: Run the tests**

Run: `bun run test packages/script-runtime/ apps/cli/src/commands/script-port.test.ts packages/confluence/src/client`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add packages/script-runtime/src apps/cli/src/commands/script-port.ts packages/confluence/src/client.ts
/usr/bin/git commit -m "feat(script): Confluence storage page copies, children and attachment copy verbs"
```

---

### Task 13: `wiki page copy` templating and `--tree`

**Files:**
- Create: `apps/cli/src/builtin-scripts/copy-pages.script`, `apps/cli/src/builtin-scripts/copy-pages.test.ts`
- Modify: `apps/cli/src/commands/page.ts:96,1556-1579` (and the page help block)
- Test: `apps/cli/src/commands/page-copy-cli.test.ts` (new; help and flag validation only)

**Interfaces:**
- Consumes: Tasks 9 and 12 verbs, `planAndApply`, `parseLimits` (exported from `script.ts`), `parseTemplateFlags`
- Produces:
  - `wiki page copy --id <id> [--title <tpl>] [--space <key>] [--parent <id>] [--tree] [--no-attachments] [--var …] [--vars-file …] [--now …] [--strict] [--apply] [--yes] [--plan-out <file>] [--print-script]`
  - Without `--tree`: direct, as today, plus rendering: get storage, render
    title and body, `createPage({ storage })`, copy attachments. It prints the
    warnings and fails before writing when `--strict` is set and warnings
    exist.
  - With `--tree`: plan/apply through `copy-pages.script`, like copy-issues
    (`--apply` to execute).

`copy-pages.script` (params: `id`, `space`, `parent`, `title`, `attachments`):
1. Walk the tree breadth-first from `id` with `confluence.getPage(id, { storage: true })`
   and `confluence.children`, keeping depth order (parents first).
2. For each page:
   - Compute `source = { id, title }` and `parent = { id: <copy id or plan ref>, title: <rendered parent title> }`.
   - Rendered title: for the root, `atlcli.render(p.title || src.title, { source, unit: \`page ${src.id} title\` })`;
     for children, `atlcli.render(src.title, { source, parent, unit })`.
   - Body: `atlcli.render(src.storage, { format: "storage", source, parent, unit: \`page ${src.id} body\` })`.
3. Preflight: collect rendered titles. A duplicate within the plan fails the
   run with `throw new Error(\`Two pages would be titled "${t}"\`)`. For each
   title, `confluence.findPage(space, title)`. If one exists:
   - when its properties carry `atlcli.copiedFrom.id === src.id`, it is a
     resume: reuse its id, and don't create or copy attachments again unless
     missing (same-name-and-size skip in the verb);
   - otherwise fail with `throw new Error(\`A page titled "${t}" already exists in ${space}\`)`.
4. `confluence.createPage({ space, title, parent: parentRef, storage, properties: { "atlcli.copiedFrom": { id: src.id, version: src.version } } })`.
5. Attachments: for each `confluence.attachments(src.id)`, run
   `confluence.copyAttachment(a.id, src.id, ref)`.
6. Return `{ pages: n, resumed: r, attachments: k, warnings }`.

Resuming uses the title together with `atlcli.copiedFrom`, not a content-property
search: titles must be unique in a space anyway, and CQL cannot query
unindexed properties. Record this in the Implementation notes (Task 16).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/cli/src/builtin-scripts/copy-pages.test.ts
import { describe, expect, it } from "bun:test";
import { planScript, type ScriptPort } from "@atlcli/script-runtime";
import { createTemplateScope, renderBody } from "@atlcli/core";
import source from "./copy-pages.script" with { type: "text" };

const script = new Bun.Transpiler({ loader: "ts", target: "browser" }).transformSync(source);
const render: ScriptPort["render"] = (input, o) =>
  renderBody(input, createTemplateScope({ vars: o.vars, now: new Date(o.now), source: o.source, parent: o.parent }), { unit: o.unit, format: o.format, strict: o.strict }) as never;

function port(existing: Record<string, { id: string; copiedFrom?: string }> = {}): ScriptPort {
  const pages: Record<string, { id: string; title: string; storage: string; children: string[] }> = {
    "1": { id: "1", title: "Retro template", storage: "<p>Sprint {{sprint}}</p>", children: ["2"] },
    "2": { id: "2", title: "Actions ({{sprint}})", storage: "<p>Parent: {{parent.title}}</p>", children: [] },
  };
  return {
    render,
    confluenceGetPageStorage: async (id) => ({ ...pages[id]!, spaceKey: "DOCSY", version: 3, properties: {} }),
    confluenceChildren: async (id) => pages[id]!.children.map((c) => ({ id: c, title: pages[c]!.title, spaceKey: "DOCSY" })),
    confluenceAttachments: async (id) => (id === "1" ? [{ id: "a1", title: "board.png", fileSize: 10 } as never] : []),
    confluenceFindPage: async (_s, title) => (existing[title] ? { id: existing[title]!.id, version: 1 } : null),
    confluenceGetPage: async (id) => ({ id, title: "x", spaceKey: "DOCSY", version: 1, markdown: "" }),
  } as unknown as ScriptPort;
}
const params = { id: "1", space: "DOCSY", parent: "", title: "Retro {{sprint}}", attachments: true };
const templating = { vars: { sprint: 42 }, now: "2026-10-25T00:00:00.000Z", strict: false };

describe("copy-pages", () => {
  it("renders titles and bodies, parents first, with parent.title", async () => {
    const run = await planScript(script, { port: port(), params, templating });
    const creates = run.operations.filter((o) => o.verb === "confluence.createPage");
    expect(creates.map((o) => o.args.title)).toEqual(["Retro 42", "Actions (42)"]);
    expect(creates[1]!.args.storage).toBe("<p>Parent: Retro 42</p>");
    expect(creates[1]!.args.parentId).toBe("plan:1");
    expect(run.operations.filter((o) => o.verb === "confluence.copyAttachment")).toHaveLength(1);
  });
  it("fails on a title collision with an unrelated page", async () => {
    await expect(planScript(script, { port: port({ "Retro 42": { id: "99" } }), params, templating })).rejects.toThrow(/already exists/);
  });
});
```

The arg name for the parent in recorded ops (`parentId` vs `parent`) must
match what `confluence.createPage` records today (see `verbs.ts:688`). Adjust
the assertion to the real name once, not the verb.

```ts
// apps/cli/src/commands/page-copy-cli.test.ts
import { describe, expect, test } from "bun:test";
const cli = (...args: string[]) => Bun.spawnSync(["bun", "--conditions=development", "run", "--cwd", "apps/cli", "src/index.ts", ...args]);
describe("wiki page copy help", () => {
  test("documents tree and template flags", () => {
    const out = cli("wiki", "page", "copy", "--help").stdout.toString();
    for (const f of ["--tree", "--vars-file", "--now", "--strict", "--apply"]) expect(out).toContain(f);
  }, 30_000);
});
```

Check how existing CLI help tests spawn the CLI (`help-never-dispatches.test.ts`)
and use the same helper, including `cwd`.

- [ ] **Step 2: Run them to see them fail**

Run: `bun run test apps/cli/src/builtin-scripts/copy-pages.test.ts apps/cli/src/commands/page-copy-cli.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `copy-pages.script` and the `page.ts` changes**

The `page.ts` `copy` case:
- With `--tree`: import `copyPagesScript` (as text, the same way `jira.ts`
  imports `copyIssuesScript`) and call `planAndApply(copyPagesScript, { name: "copy-pages" }, params, parseLimits(flags, opts), flags, opts, templating)`.
  `--print-script` prints the script and exits, as copy-issues does.
- Without `--tree`:
  - `getPage(id)` → `storage` and `title`
  - `const t = await parseTemplateFlags(flags, opts)`
  - `scope = createTemplateScope({ vars: t.values, now: t.now, space, source: { id, title } })`
  - title: `renderTextField(titleFlag ?? \`Copy of ${title}\`, "name", …)`
  - body: `renderStorage(storage, …)`
  - With strict and warnings, fail before writing.
  - `client.createPage({ spaceKey, title, storage, parentId })`.
  - Unless `--no-attachments`, copy each attachment via the Task 12 client
    methods (this is new for single pages; mention it in the docs).
  - Output as today, plus `warnings`.

- [ ] **Step 4: Run the tests**

Run: `bun run test apps/cli/src/builtin-scripts/ apps/cli/src/commands/page-copy-cli.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add apps/cli/src/builtin-scripts/copy-pages.script apps/cli/src/builtin-scripts/copy-pages.test.ts apps/cli/src/commands/page.ts apps/cli/src/commands/page-copy-cli.test.ts
/usr/bin/git commit -m "feat(confluence): templated wiki page copy with --tree plan/apply"
```

---

### Task 14: `atlcli template vars`

**Files:**
- Create: `apps/cli/src/commands/template-vars.ts`, `apps/cli/src/commands/template-vars.test.ts`
- Modify: `apps/cli/src/index.ts` (both `case` lists), `apps/cli/src/root-commands.ts`, `apps/cli/src/completions.ts`

**Interfaces:**
- Consumes: `collectVariables`, `VariableUse`, `parseVarsFile` (core); Jira template resolver (`getJiraTemplateContext` in `jira.ts`; export it if it isn't exported); Jira/Confluence clients
- Produces: `handleTemplateCommand(args, flags, opts)`, plus a pure, exported
  `summarizeVariables(uses: VariableUse[], declarations: TemplateVariable[]): Array<{ name; type; required; default?; description?; usedIn: string[] }>`
  and `valuesSkeleton(rows): string` (YAML text with `values:`)

Sources (exactly one is required):
- `--jira-template <name>`
- `--issue <key>`
- `--jql <q>` (max 500 issues; summary, description, labels and string custom fields)
- `--page <id> [--tree]`
- `--file <path>`: a local file. `.json` is read as a Jira template file, and
  `.md` is a wiki template (frontmatter declarations from `parseTemplate`,
  body as text).

`--vars-file` merges declarations. Text output is a table:
`NAME  TYPE  REQUIRED  DEFAULT  USED IN`. `--json` prints
`{ schemaVersion: "1", variables: rows, skeleton: "<yaml>" }`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/cli/src/commands/template-vars.test.ts
import { describe, expect, test } from "bun:test";
import { summarizeVariables, valuesSkeleton } from "./template-vars.js";

describe("template vars", () => {
  const uses = [
    { name: "year", unit: "TPL-1 summary" },
    { name: "year", unit: "TPL-2 description" },
    { name: "owner", unit: "TPL-1 description" },
  ];
  test("merges uses with declarations", () => {
    expect(summarizeVariables(uses, [{ name: "year", type: "number", required: true, description: "Audit year" }, { name: "unused", type: "string" }])).toEqual([
      { name: "owner", type: "string", required: true, usedIn: ["TPL-1 description"] },
      { name: "unused", type: "string", required: false, usedIn: [] },
      { name: "year", type: "number", required: true, description: "Audit year", usedIn: ["TPL-1 summary", "TPL-2 description"] },
    ]);
  });
  test("skeleton is a valid vars file", () => {
    expect(valuesSkeleton(summarizeVariables(uses, []))).toBe("values:\n  owner: \"\"\n  year: \"\"\n");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun run test apps/cli/src/commands/template-vars.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

`summarizeVariables`:
- Group uses by name.
- An undeclared name gets `{ type: "string", required: true }`.
- A declared name copies its declaration (required defaults to `false`).
- Sort by name.

`valuesSkeleton` uses `yaml`'s `stringify({ values: Object.fromEntries(rows.map(r => [r.name, r.default ?? ""])) })`.
Adjust the expected string in the test to `yaml`'s exact output (quotes) once,
by running it.

Command: `atlcli template vars …`. Register it:
- In `index.ts`, add a `case "template":` to both switch blocks next to
  `script`, importing lazily like the neighbours.
- In `ROOT_COMMANDS`, add
  `["template", "Inspect template variables across Jira and Confluence"]`
  after `script`.
- In `completions.ts`, follow how `script` subcommands are listed.

- [ ] **Step 4: Run the tests plus root-command and completion guards**

Run: `bun run test apps/cli/src/commands/template-vars.test.ts apps/cli/src/completions.test.ts apps/cli/src/help-never-dispatches.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add apps/cli/src/commands/template-vars.ts apps/cli/src/commands/template-vars.test.ts apps/cli/src/index.ts apps/cli/src/root-commands.ts apps/cli/src/completions.ts
/usr/bin/git commit -m "feat(cli): atlcli template vars lists template variables per source"
```

---

### Task 15: Docs, agent skill, API reports

**Files:**
- Create: `src/content/docs/templating.md`
- Modify: `astro.config.mjs` (sidebar), `src/content/docs/jira/copy-issues.md`, `jira/templates.md`, `jira/issues.md`, `confluence/pages.md`, `confluence/templates.md`, `reference/scripts.md`, `reference/cli-commands.md`
- Modify: `skills/atlcli/references/jira-issues.md`, `confluence-pages.md`, `confluence-templates.md`, `scripts.md` (and `skills/atlcli/SKILL.md` if it indexes topics)
- Modify: `packages/*/etc/*.api.md` via the script

- [ ] **Step 1: Write `templating.md`**

Follow the docs template from CLAUDE.md (intro → prerequisites → steps →
options → examples → troubleshooting → related topics), with an in-page TOC.
Sections:
1. What templating does: the four operations and live objects vs. files.
2. Syntax: variables, `source.*`, `parent.*`, built-ins (table: name, example
   value, notes; `@today` is always ISO, `@quarter` is `4`, `@week` is an ISO
   week, `@uuid` is stable per `--now`).
3. Helpers: a table with a signature and example for each of the 11 helpers.
4. Blocks inside one paragraph and **control paragraphs**: doc, panel and cell
   level; list items; table rows. Include a template issue example and a
   storage example. Screenshot placeholders get real screenshots from the E2E
   in Task 16; caption them.
5. Tolerant vs `--strict`: what stays literal and the warning list format.
6. Variables: `--var`, `a.b=c`, JSON values, `--vars-file` (full and short
   form), precedence, declarations, prompts, CI behaviour.
7. `atlcli template vars`.
8. Examples:
   - minimal: `jira template apply rel --var version=4.2`
   - realistic: an audit with `audit-2026.yml` used for copy-issues and
     `wiki page copy --tree`, including `#each systems` table rows
9. Troubleshooting:
   - Symptom "`{{x}}` stays in the copy". Causes: typo, missing `--var`,
     expression crossing a mention or link, code formatting, parse error.
     Fix: `atlcli template vars`, `--strict`.
   - DC monospace `{{text}}`: escape with `\{{`.
   - Jinja and Helm snippets.
   - Resume after midnight: `--now`.
   - `{{year}}` inside `#each` is empty: use `@root.year`.
10. Related topics.

- [ ] **Step 2: Update the feature pages**

- `jira/copy-issues.md`: add a "Templates" section with the new flags; move
  `--replace` under "Legacy: --replace", noting it runs before rendering.
- `jira/templates.md`: add a variables block in the template JSON, a save
  inference note, apply flags, and `get` output.
- `jira/issues.md` (clone): the new flags.
- `confluence/pages.md` (copy): single page rendering, attachments copied,
  `--tree` plan/apply, resume, title collisions.
- `confluence/templates.md`: the shared built-ins and helpers table, linking to
  `templating.md`.
- `reference/scripts.md`: `atlcli.render` signature, formats, warnings in the
  plan, `--var`/`--vars-file`/`--now`/`--strict` on `script run`, and the new
  Confluence verbs (`getPage({ storage })`, `children`, `createPage({ storage, properties })`,
  `copyAttachment`).
- `reference/cli-commands.md`: `template vars`, plus the new flags on each
  command.
- Add `templating` to the `astro.config.mjs` sidebar under Feature Guides,
  next to the scripts guide.

- [ ] **Step 3: Update the agent skill**

In each named reference file, add the flags and one example. Put a short
"Templating" section in `scripts.md` that names `atlcli.render` and tolerant
mode. If `skills/atlcli/SKILL.md` lists reference topics, add a one-line
pointer. Run `bun run test apps/cli/src/skill-files.test.ts`.

- [ ] **Step 4: Regenerate the API reports and typecheck**

Run: `bun scripts/api-report.ts --update`, then review the diff
(`/usr/bin/git diff packages/core/etc packages/script-runtime/etc packages/jira/etc`).
It should show only the new exports.
Run: `bun run typecheck`
Expected: no errors

- [ ] **Step 5: Build the docs**

Run: `bun run build --filter=docs`, or the docs build task defined in
`turbo.json`. Use `bunx turbo run build --filter=<docs package>`, never the
root `bun run build --filter`: the root prebuild deletes extension artifacts
(see PR #342).
Expected: build OK, no broken links

- [ ] **Step 6: Commit**

```bash
/usr/bin/git add src/content/docs astro.config.mjs skills/atlcli packages/core/etc packages/script-runtime/etc packages/jira/etc
/usr/bin/git commit -m "docs: templating guide, operation pages, skill and API reports"
```

---

### Task 16: Full test run, live E2E, implementation notes

**Files:**
- Modify: `specs/operation-templating/PLAN.md` (append "Implementation notes")
- Modify: `src/content/docs/templating.md` (screenshots, if taken)

- [ ] **Step 1: Run the full suite and typecheck**

Run: `bun run typecheck`, then `bun run test --parallel`
Expected: green, except the 16 known Astro/Starlight tests that fail locally on
Node 22.18 (Astro needs >= 22.23.4). Name them in the PR if they fail.

- [ ] **Step 2: Live E2E, Jira copy (profile `kiteweave`)**

Use a scratch script in the session scratchpad (not the repo) that creates the
temporary projects `TPLSRC`/`TPLDST` through REST, as for #341, and deletes
them afterwards via `DELETE /project/{key}`. Never touch `KAN`. Source issues:
- summary `Audit {{year}}: {{control}}` (a mustache split across bold in the
  description)
- a description with control paragraphs `{{#each systems}}` over table rows
- a mention next to a placeholder
- a link `https://…/browse/{{source.key}}`
- a code block containing `{{year}}`
- a Jinja snippet `{{ item.name }}`
- labels `audit-{{year}}`

Run: `atlcli jira project copy-issues --from TPLSRC --to TPLDST --vars-file audit.yml --comments --profile kiteweave`
(plan), then the same with `--apply --yes`.

Verify via `atlcli jira issue get … --json`:
- rendered summary, labels and rows
- the code block and Jinja text unchanged
- the link rewritten
- the warnings in the plan

Re-plan with the plan's `--now` and expect "No changes planned".
`--strict` without `control` in the vars must fail.

- [ ] **Step 3: Live E2E, Confluence (profile `mayflower`, space `DOCSY` only)**

Create a template page tree in DOCSY (root and one child) with:
- `{{sprint}}` in titles
- a Jira macro whose `jqlQuery` parameter contains `project = {{project}}`
- an info macro with a nested placeholder
- a code macro containing `{{sprint}}`
- an image attachment on the root

Run `atlcli wiki page copy --id <root> --tree --title "Retro {{sprint}}" --var sprint=42 --var project=ATLCLI --space DOCSY --profile mayflower`,
then with `--apply --yes`. Verify the titles, the macro parameter, the
untouched code macro and the copied attachment (the image renders). Re-plan to
see the resume. Also test a single-page copy without `--tree`. Delete all
pages created (template and copies) with `atlcli wiki page delete … --confirm`.

- [ ] **Step 4: Live E2E, Jira template (profile `mayflower`, project `ATLCLI`)**

`jira template save e2e-tpl --issue <an ATLCLI issue whose summary has {{version}}>`,
then `jira template get e2e-tpl` (it shows the variables), then
`jira template apply e2e-tpl --project ATLCLI --var version=4.2`. Verify the
created issue, then delete it (`jira issue delete … --confirm`) and the
template (`jira template delete e2e-tpl --confirm`). Delete the source issue
if you created it.

- [ ] **Step 5: Append Implementation notes to the spec**

Append an "Implementation notes" section to `specs/operation-templating/PLAN.md`
with:
- storage uses a core offset tokenizer, not a `parseXml` serializer (none
  exists)
- `TemplateEngine` shares the helper factory and built-ins but keeps its own
  render loop (wiki behaviour is unchanged by design, and it isn't tolerant)
- page-tree resume uses title + `atlcli.copiedFrom`, not a property search
- `@uuid` is derived from `--now`
- paths inside control-paragraph `each`/`with` resolve against the item; use
  `@root.x` (the `../x` form is not supported in control paragraphs)
- anything else that differed during the build
- E2E evidence: commands, issue keys/page ids created and deleted

- [ ] **Step 6: Commit**

```bash
/usr/bin/git add specs/operation-templating/PLAN.md src/content/docs/templating.md
/usr/bin/git commit -m "docs(spec): templating implementation notes and E2E evidence"
```

- [ ] **Step 7: Mark the PR ready (only on the user's go)**

Push the branch and update the PR body: summary, E2E list (sites, what was
created and deleted), test results, known local Astro failures. Don't mark it
ready or merge without the user's explicit go.
