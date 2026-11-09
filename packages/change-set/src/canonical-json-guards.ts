import type { CanonicalJsonBudgetV1 } from "./canonical-json.js";

export class CanonicalJsonErrorV1 extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "CanonicalJsonErrorV1";
  }
}

export function fail(path: string, message: string): never {
  throw new CanonicalJsonErrorV1(path, message);
}

export function positiveBudget(value: number, name: keyof CanonicalJsonBudgetV1): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("$", `${name} must be a positive safe integer`);
  }
}

export function propertyValue(object: object, key: string, path: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
    return fail(path, "expected an enumerable data property");
  }
  return descriptor.value;
}
