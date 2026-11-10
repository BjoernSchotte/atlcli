import { expect, test } from "bun:test";
import { posix, win32 } from "node:path";
import { isPathInside } from "./path-containment.js";

test("a path on another Windows drive is outside, not inside", () => {
  // The site on D:, the private workspace in the user's temp directory on C:.
  expect(isPathInside("D:\\a\\site\\dist", "C:\\Users\\runner\\Temp\\inventory.json", win32)).toBe(false);
  expect(isPathInside("D:\\a\\site\\dist", "D:\\a\\site\\dist\\inventory.json", win32)).toBe(true);
  expect(isPathInside("D:\\a\\site\\dist", "D:\\a\\site\\private\\inventory.json", win32)).toBe(false);
  expect(isPathInside("D:\\a\\site\\dist", "D:\\a\\site\\dist", win32)).toBe(true);
});

test("posix containment", () => {
  expect(isPathInside("/site/dist", "/site/dist/inventory.json", posix)).toBe(true);
  expect(isPathInside("/site/dist", "/site/dist", posix)).toBe(true);
  expect(isPathInside("/site/dist", "/site/private/inventory.json", posix)).toBe(false);
  expect(isPathInside("/site/dist", "/tmp/inventory.json", posix)).toBe(false);
});
