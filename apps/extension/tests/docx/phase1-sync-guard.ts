/**
 * Source-level guard for migration **phase 1**: nothing reachable from
 * `req.onupgradeneeded` in `utils/docx/template-store.ts` may await, be async,
 * or chain a promise.
 *
 * ## Why this cannot be a behavioural test
 *
 * In a real browser an `await` inside `onupgradeneeded` lets the version-change
 * transaction auto-commit mid-await, and the follow-up `put()` throws
 * `TransactionInactiveError`. `fake-indexeddb` — verified by probe, not assumed
 * — does **not** model that: an upgrade handler that awaits
 * `crypto.subtle.digest` and then puts succeeds silently under the fake. So no
 * test run against the fake can catch the regression the two-phase split exists
 * to prevent. Only the source can.
 *
 * ## Why it is an AST walk and not a regex
 *
 * The first version of this guard matched `^function <name>` for **six
 * hard-coded names** and brace-matched their bodies by hand. It therefore
 * proved nothing:
 *
 *  - a `const helper = async () => …` arrow was invisible to it (not a
 *    top-level `function` declaration);
 *  - an *imported* helper was invisible to it;
 *  - any newly added function simply had to not be one of the six;
 *  - its brace matcher could terminate early on a `}` inside a string literal,
 *    truncating the body it scanned.
 *
 * This version follows the real call graph from the real entry point, using the
 * TypeScript parser, and is **closed by default**: every callee must resolve to
 * a function defined in the same module (which is then walked too), or appear
 * in one of the small allowlists below. An unrecognised call, an imported call,
 * or a call the guard cannot resolve is itself a violation — so the guard fails
 * *loudly* on code it cannot prove synchronous rather than silently ignoring it.
 *
 * The mutation tests in `template-store-migration.test.ts` re-run this guard
 * against deliberately sabotaged copies of the source (arrow-const helper,
 * imported helper, unlisted name, `}`-in-a-string) and assert each one is
 * caught. A guard without those is a guard nobody has ever seen fail.
 */
import ts from "typescript";

/**
 * Bare-identifier calls allowed without a local definition.
 *
 * Deliberately tiny. `setTimeout`/`queueMicrotask`/`requestIdleCallback` are
 * **not** here on purpose: deferring work out of the version-change transaction
 * is precisely the bug class this guard exists to catch, so they must fail.
 */
const ALLOWED_UNRESOLVED_CALLS = new Set([
  // The Promise executor's own settlement callbacks — synchronous by definition.
  "reject",
  "resolve",
  "clearTimeout",
]);

/**
 * Method names phase 1 may call. Every one is a synchronous IndexedDB or
 * built-in operation. Adding to this list is a deliberate act: check the new
 * method really cannot return a promise before doing it.
 */
const ALLOWED_MEMBER_CALLS = new Set([
  // IDBDatabase / IDBObjectStore / IDBTransaction — all synchronous, all
  // returning either void or an IDBRequest (never a promise).
  "contains",
  "createObjectStore",
  "deleteObjectStore",
  "objectStore",
  "createIndex",
  "getAll",
  "put",
  // Built-ins.
  "randomUUID",
  "now",
  "replace",
  "trim",
  "map",
  "join",
  "push",
]);

/** Constructors phase 1 may use. `Promise` is pointedly absent. */
const ALLOWED_CONSTRUCTORS = new Set(["Error", "URL"]);

export interface Phase1GuardReport {
  /** Human-readable violations; empty means the guard passed. */
  violations: string[];
  /** Names of module functions the walk actually reached, for sanity checks. */
  reached: string[];
}

type Callable = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

/**
 * Index every named function in the module — `function f()`, `const f = () =>`,
 * `const f = function ()` — at **any** scope depth, so a nested helper is
 * resolvable too. Same-name declarations in different scopes are merged, which
 * over-approximates (the guard walks both). Over-approximating is the safe
 * direction for a guard.
 */
function collectCallables(sf: ts.SourceFile): Map<string, Callable[]> {
  const byName = new Map<string, Callable[]>();
  const add = (name: string, fn: Callable): void => {
    const list = byName.get(name);
    if (list) list.push(fn);
    else byName.set(name, [fn]);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) add(node.name.text, node);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      add(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return byName;
}

/** Every name this module imports — none of which the guard can verify. */
function collectImportedNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const clause = statement.importClause;
    if (clause.name) names.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
    else for (const element of bindings.elements) names.add(element.name.text);
  }
  return names;
}

/** The phase-1 entry point: the right-hand side of `req.onupgradeneeded = …`. */
function findUpgradeHandler(sf: ts.SourceFile): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === "onupgradeneeded"
    ) {
      found = node.right;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function isAsync(node: ts.Node): boolean {
  const modifiers = (node as { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers;
  return (modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
}

/**
 * Walk the call graph rooted at `req.onupgradeneeded` and report everything
 * that is (or might be) asynchronous.
 */
export function findPhase1AsyncViolations(source: string): Phase1GuardReport {
  const sf = ts.createSourceFile(
    "template-store.ts",
    source,
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ true,
    ts.ScriptKind.TS
  );

  const entry = findUpgradeHandler(sf);
  if (!entry) {
    return {
      violations: [
        "phase-1 entry point `req.onupgradeneeded = …` was not found — the guard " +
          "has nothing to walk, which is itself a failure.",
      ],
      reached: [],
    };
  }

  const callables = collectCallables(sf);
  const imported = collectImportedNames(sf);
  const violations: string[] = [];
  const reached: string[] = [];
  const visited = new Set<ts.Node>();
  const queue: { node: ts.Node; label: string }[] = [{ node: entry, label: "req.onupgradeneeded" }];

  const enqueue = (name: string): void => {
    const targets = callables.get(name);
    if (!targets) return;
    if (!reached.includes(name)) reached.push(name);
    for (const target of targets) {
      if (!visited.has(target)) queue.push({ node: target, label: name });
    }
  };

  while (queue.length > 0) {
    const { node: fn, label } = queue.pop()!;
    if (visited.has(fn)) continue;
    visited.add(fn);

    const inspect = (node: ts.Node): void => {
      if (ts.isAwaitExpression(node)) {
        violations.push(`${label} awaits — the version-change transaction would commit mid-await.`);
      }
      if (ts.isFunctionLike(node) && isAsync(node)) {
        violations.push(`${label} contains an async function — phase 1 must be strictly synchronous.`);
      }
      if (ts.isForOfStatement(node) && node.awaitModifier) {
        violations.push(`${label} uses \`for await\` — phase 1 must be strictly synchronous.`);
      }
      if (ts.isNewExpression(node)) {
        const name = ts.isIdentifier(node.expression) ? node.expression.text : "<computed>";
        if (name === "Promise") {
          violations.push(`${label} constructs a Promise — phase 1 must be strictly synchronous.`);
        } else if (!ALLOWED_CONSTRUCTORS.has(name)) {
          violations.push(
            `${label} constructs unrecognised \`new ${name}()\` — the guard cannot prove it is ` +
              "synchronous; verify it and add it to ALLOWED_CONSTRUCTORS."
          );
        }
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (ts.isIdentifier(callee)) {
          const name = callee.text;
          if (imported.has(name)) {
            violations.push(
              `${label} calls imported \`${name}()\` — an imported helper is outside this ` +
                "module and cannot be proven synchronous; inline it instead."
            );
          } else if (!callables.has(name) && !ALLOWED_UNRESOLVED_CALLS.has(name)) {
            violations.push(
              `${label} calls unrecognised \`${name}()\` — the guard cannot resolve it to a ` +
                "function in this module; define it here or add it to ALLOWED_UNRESOLVED_CALLS."
            );
          }
        } else if (ts.isPropertyAccessExpression(callee)) {
          const method = callee.name.text;
          if (method === "then" || method === "catch" || method === "finally") {
            violations.push(`${label} chains a promise via .${method}() — phase 1 must be synchronous.`);
          } else if (!ALLOWED_MEMBER_CALLS.has(method)) {
            violations.push(
              `${label} calls unrecognised method \`.${method}()\` — the guard cannot prove it is ` +
                "synchronous; verify it and add it to ALLOWED_MEMBER_CALLS."
            );
          }
        } else {
          violations.push(
            `${label} makes a call whose callee the guard cannot resolve — phase 1 must stay ` +
              "trivially verifiable."
          );
        }
      }
      // Any reference to a module function is followed, not just a direct call:
      // passing a helper as a callback must not smuggle async code past us.
      if (ts.isIdentifier(node) && callables.has(node.text)) enqueue(node.text);
      ts.forEachChild(node, inspect);
    };

    inspect(fn);
  }

  return { violations, reached };
}
