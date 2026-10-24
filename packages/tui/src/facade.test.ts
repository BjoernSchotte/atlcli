/**
 * `index.d.ts` is hand-written so importers need not typecheck OpenTUI. This
 * file fails the package typecheck when the implementation drifts from it.
 */
import { expect, test } from "bun:test";
import type * as Facade from "../index.js";
import * as impl from "./index.js";

const runTui: typeof Facade.runTui = impl.runTui;
const selfTest: typeof Facade.selfTest = impl.selfTest;
const options = (o: Facade.TuiOptions): Parameters<typeof impl.runTui>[0] => o;

test("the package exports what its facade declares", () => {
  expect(typeof runTui).toBe("function");
  expect(typeof selfTest).toBe("function");
  expect(typeof options).toBe("function");
});
