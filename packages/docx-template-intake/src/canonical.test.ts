import { afterEach, expect, test } from "bun:test";
import { canonicalIntakeJson } from "./canonical.js";

const original = String.prototype.localeCompare;
afterEach(() => {
  String.prototype.localeCompare = original;
});

test("canonical key order does not follow the host's default locale", () => {
  // Simulate a Lithuanian default locale, which sorts "y" between "i" and "j".
  String.prototype.localeCompare = function (
    this: string,
    that: string,
    locales?: Intl.LocalesArgument,
    options?: Intl.CollatorOptions
  ) {
    return original.call(this, that, locales ?? "lt", options);
  } as typeof original;
  expect(canonicalIntakeJson({ z: 1, y: 2, j: 3, i: 4 })).toBe(
    '{"i":4,"j":3,"y":2,"z":1}'
  );
});
