import { expect, test } from "bun:test";
import { assertGenericBrowserGlobals } from "../src/generic-browser-globals.js";

test("accepts ordinary Chrome globals but rejects Node and extension APIs", () => {
  expect(() => assertGenericBrowserGlobals({})).not.toThrow();
  expect(() => assertGenericBrowserGlobals({ chrome: { app: {}, csi() {}, loadTimes() {} } })).not.toThrow();
  for (const name of ["Buffer", "process", "browser"]) {
    expect(() => assertGenericBrowserGlobals({ [name]: {} })).toThrow(name);
  }
  for (const name of ["runtime", "storage", "tabs", "scripting"]) {
    expect(() => assertGenericBrowserGlobals({ chrome: { [name]: {} } })).toThrow(`extension API ${name}`);
  }
});
