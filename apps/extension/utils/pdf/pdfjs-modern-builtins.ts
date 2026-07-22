/**
 * Compatibility operations used by PDF.js 6's modern build but not present in
 * the Chrome 140 baseline exercised by the packed-extension browser test.
 *
 * Keep this list deliberately small and standards-shaped. Raising the manifest
 * floor and running the real MV3 worker test is preferable to silently growing
 * a second, project-owned "legacy build" here.
 */
export function ensurePdfjsModernBuiltins(): void {
  const prototype = Map.prototype as Map<unknown, unknown> & {
    getOrInsertComputed?: (key: unknown, callback: (key: unknown) => unknown) => unknown;
  };
  if (typeof prototype.getOrInsertComputed !== "function") {
    Object.defineProperty(prototype, "getOrInsertComputed", {
      configurable: true,
      writable: true,
      value(this: Map<unknown, unknown>, key: unknown, callback: (key: unknown) => unknown) {
        if (this.has(key)) return this.get(key);
        const value = callback(key);
        this.set(key, value);
        return value;
      },
    });
  }

  const math = Math as Math & { sumPrecise?: (values: Iterable<number>) => number };
  if (typeof math.sumPrecise !== "function") {
    Object.defineProperty(math, "sumPrecise", {
      configurable: true,
      writable: true,
      value(values: Iterable<number>) {
        let sum = 0;
        for (const value of values) {
          if (typeof value !== "number") throw new TypeError("Math.sumPrecise expects numbers.");
          sum += value;
        }
        return sum;
      },
    });
  }
}
