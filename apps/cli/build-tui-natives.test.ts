import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNativeFor, missingNativeExternals, nativePackageFor, opentuiNativePackages } from "./build-tui-natives.js";

const root = mkdtempSync(join(tmpdir(), "atlcli-natives-"));
const pkg = (name: string, body: object = { name }) => {
  mkdirSync(join(root, "node_modules", name), { recursive: true });
  writeFileSync(join(root, "node_modules", name, "package.json"), JSON.stringify(body));
};
pkg("@opentui/core", { optionalDependencies: { "@opentui/core-linux-x64": "1", "@opentui/core-linux-x64-musl": "1", "@opentui/core-win32-x64": "1" } });
pkg("@opentui/core-linux-x64");
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("OpenTUI native packages in builds", () => {
  test("the packages come from @opentui/core's optional dependencies", () => {
    expect(opentuiNativePackages(root)).toEqual(["@opentui/core-linux-x64", "@opentui/core-linux-x64-musl", "@opentui/core-win32-x64"]);
  });

  test("only the ones this install lacks are external (CI: a glibc runner has no -musl package)", () => {
    expect(missingNativeExternals(root)).toEqual(["--external", "@opentui/core-linux-x64-musl", "--external", "@opentui/core-win32-x64"]);
  });

  test("a release target without its package fails the build", () => {
    expect(nativePackageFor("windows-x64")).toBe("@opentui/core-win32-x64");
    expect(() => assertNativeFor("linux-x64", root)).not.toThrow();
    expect(() => assertNativeFor("windows-x64", root)).toThrow("--os='*' --cpu='*'");
  });

  test("the real install embeds this platform's package", () => {
    const own = nativePackageFor(`${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`);
    expect(missingNativeExternals()).not.toContain(own);
  });
});
