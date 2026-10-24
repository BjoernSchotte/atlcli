import { expect, it } from "bun:test";
import { ATLCLI_SCRIPT_TYPES } from "./script-types.js";
import { SCRIPT_VERBS } from "./verbs.js";

it("declares every script verb and nothing else", () => {
  const declared = new Set<string>();
  let namespace = "";
  for (const line of ATLCLI_SCRIPT_TYPES.split("\n")) {
    const ns = /^ {2}readonly (\w+): \{$/.exec(line);
    if (ns) namespace = ns[1]!;
    const method = /^ {4}(\w+)\(/.exec(line);
    if (method && namespace) declared.add(`${namespace}.${method[1]}`);
  }
  expect([...declared].sort()).toEqual([...SCRIPT_VERBS].sort());
});
