/**
 * Compatibility operations used by the modern PDF.js 6 build but not yet
 * present in every Chrome version supported by the extension.
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
