import type { CanonicalJsonValue } from "./types.js";

export interface CanonicalJsonBudgetV1 {
  maxDepth: number;
  maxNodes: number;
  maxStringBytes: number;
  maxOutputBytes: number;
}

export const DEFAULT_CANONICAL_JSON_BUDGET_V1:
Readonly<CanonicalJsonBudgetV1> = Object.freeze({
  maxDepth: 128,
  maxNodes: 250_000,
  maxStringBytes: 8 * 1024 * 1024,
  maxOutputBytes: 16 * 1024 * 1024,
});

export class CanonicalJsonErrorV1 extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "CanonicalJsonErrorV1";
  }
}

const encoder = new TextEncoder();

function fail(path: string, message: string): never {
  throw new CanonicalJsonErrorV1(path, message);
}

function positiveBudget(value: number, name: keyof CanonicalJsonBudgetV1): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("$", `${name} must be a positive safe integer`);
  }
}

function propertyValue(object: object, key: string, path: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
    return fail(path, "expected an enumerable data property");
  }
  return descriptor.value;
}

/**
 * Serialize plain JSON data with recursively sorted object keys.
 *
 * Arrays retain source order. Unsupported JavaScript values fail closed rather
 * than being coerced or omitted as `JSON.stringify()` normally would.
 */
export function canonicalJsonV1(
  value: unknown,
  budget: CanonicalJsonBudgetV1 = DEFAULT_CANONICAL_JSON_BUDGET_V1,
): string {
  positiveBudget(budget.maxDepth, "maxDepth");
  positiveBudget(budget.maxNodes, "maxNodes");
  positiveBudget(budget.maxStringBytes, "maxStringBytes");
  positiveBudget(budget.maxOutputBytes, "maxOutputBytes");

  let nodes = 0;
  let stringBytes = 0;
  const active = new WeakSet<object>();
  const chunks: string[] = [];
  let pending: string[] = [];
  let pendingLength = 0;
  const emit = (text: string): void => {
    pending.push(text);
    pendingLength += text.length;
    if (pendingLength >= 64 * 1024) {
      chunks.push(pending.join(""));
      pending = [];
      pendingLength = 0;
    }
  };

  const countString = (item: string, path: string): void => {
    stringBytes += encoder.encode(item).byteLength;
    if (stringBytes > budget.maxStringBytes) {
      fail(path, "string-byte budget exceeded");
    }
  };

  const walk = (item: unknown, path: string, depth: number): void => {
    nodes += 1;
    if (nodes > budget.maxNodes) fail(path, "node budget exceeded");
    if (depth > budget.maxDepth) fail(path, "depth budget exceeded");

    if (item === null || typeof item === "boolean") {
      emit(JSON.stringify(item));
      return;
    }
    if (typeof item === "string") {
      countString(item, path);
      emit(JSON.stringify(item));
      return;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) fail(path, "expected a finite number");
      emit(JSON.stringify(item));
      return;
    }
    if (typeof item !== "object") {
      fail(path, "expected JSON-only data");
    }
    if (active.has(item)) fail(path, "cyclic value");
    active.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.getOwnPropertySymbols(item).length > 0) {
          fail(path, "symbol properties are not JSON data");
        }
        const ownNames = Object.getOwnPropertyNames(item);
        if (ownNames.some((key) => key !== "length" && !/^(0|[1-9]\d*)$/u.test(key))) {
          fail(path, "array has non-index properties");
        }
        emit("[");
        for (let index = 0; index < item.length; index += 1) {
          if (!Object.hasOwn(item, index)) fail(`${path}[${index}]`, "sparse arrays are not JSON data");
          if (index > 0) emit(",");
          walk(propertyValue(item, String(index), `${path}[${index}]`), `${path}[${index}]`, depth + 1);
        }
        emit("]");
        return;
      }

      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        fail(path, "expected a plain object");
      }
      if (Object.getOwnPropertySymbols(item).length > 0) {
        fail(path, "symbol properties are not JSON data");
      }
      const ownNames = Object.getOwnPropertyNames(item);
      const keys = Object.keys(item);
      if (ownNames.length !== keys.length) {
        fail(path, "non-enumerable properties are not JSON data");
      }
      keys.sort();
      emit("{");
      keys.forEach((key, index) => {
        countString(key, `${path}.${key}`);
        if (index > 0) emit(",");
        emit(`${JSON.stringify(key)}:`);
        walk(
          propertyValue(item, key, `${path}.${key}`),
          `${path}.${key}`,
          depth + 1,
        );
      });
      emit("}");
    } finally {
      active.delete(item);
    }
  };

  walk(value, "$", 0);
  if (pending.length > 0) chunks.push(pending.join(""));
  const serialized = chunks.join("");
  if (encoder.encode(serialized).byteLength > budget.maxOutputBytes) {
    fail("$", "output-byte budget exceeded");
  }
  return serialized;
}

/** UTF-8 bytes of {@link canonicalJsonV1}. */
export function canonicalJsonBytesV1(
  value: unknown,
  budget?: CanonicalJsonBudgetV1,
): Uint8Array {
  return encoder.encode(canonicalJsonV1(value, budget));
}

/** Assert JSON safety and budgets while preserving the caller's exact value. */
export function assertCanonicalJsonValueV1(
  value: unknown,
  budget?: CanonicalJsonBudgetV1,
): asserts value is CanonicalJsonValue {
  canonicalJsonV1(value, budget);
}
