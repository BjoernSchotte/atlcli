import { describe, expect, it } from "bun:test";
import {
  buildGovernance,
  governanceHasEffects,
  parsePrincipal,
  renderGovernanceSummary,
} from "./destination-governance.js";

describe("parsePrincipal", () => {
  it("parses cloud kinds and rejects DC kinds explicitly", () => {
    expect(parsePrincipal("account:557058:abc")).toEqual({
      kind: "cloud-account",
      accountId: "557058:abc",
    });
    expect(parsePrincipal("group-id:g-1")).toEqual({ kind: "cloud-group", groupId: "g-1" });
    expect(() => parsePrincipal("user-key:k1")).toThrow(/Data Center/);
    expect(() => parsePrincipal("group:devs")).toThrow(/Data Center/);
    expect(() => parsePrincipal("bogus:1")).toThrow(/Invalid principal kind/);
    expect(() => parsePrincipal("account:")).toThrow(/empty identifier/);
    expect(() => parsePrincipal("noseparator")).toThrow(/principals must be/);
  });
});

describe("buildGovernance", () => {
  it("defaults to inherit with no effects", () => {
    const { governance, errors } = buildGovernance({});
    expect(errors).toEqual([]);
    expect(governance.restriction).toEqual({ mode: "inherit" });
    expect(governanceHasEffects(governance)).toBe(false);
  });

  it("collects every violation in one pass", () => {
    const { errors } = buildGovernance({
      restriction: "explicit",
      viewers: ["account:a", "account:a", "bogus:1"],
      editors: ["group:legacy"],
      labels: ["ok-label", "has space"],
      contentProperties: ["noequals", "wrong.ns=1", "atlcli.x=1", "atlcli.x=2"],
    });
    expect(errors).toEqual([
      "Duplicate viewer principal account:a.",
      'Invalid principal kind "bogus": principals must be `account:<accountId>` or `group-id:<groupId>` (Cloud).',
      'Principal "group:legacy" uses a Data Center kind; this import targets Cloud. principals must be `account:<accountId>` or `group-id:<groupId>` (Cloud).',
      'Invalid label "has space": no spaces/commas, 1-255 characters.',
      'Invalid content property "noequals": expected key=value.',
      'Invalid property key "wrong.ns": must match the atlcli.* namespace (lowercase letters, digits, ., _, -).',
      'Duplicate property key "atlcli.x".',
    ]);
  });

  it("rejects viewers outside explicit mode and empty explicit viewer sets", () => {
    expect(buildGovernance({ restriction: "private", viewers: ["account:a"] }).errors).toEqual([
      '--viewer/--editor require --restriction explicit (got "private").',
    ]);
    expect(buildGovernance({ restriction: "explicit" }).errors).toEqual([
      "--restriction explicit requires at least one --viewer.",
    ]);
  });

  it("canonicalizes deterministically: sorted principals, labels, properties", () => {
    const { governance, errors } = buildGovernance({
      restriction: "explicit",
      viewers: ["group-id:zz", "account:aa"],
      labels: ["Zeta", "alpha", "alpha"],
      contentProperties: ["atlcli.z=true", "atlcli.a=42", "atlcli.m=hello", "atlcli.n=null"],
      stagingParentTitle: "  Imported drafts  ",
    });
    expect(errors).toEqual([]);
    if (governance.restriction.mode !== "explicit") throw new Error("unreachable");
    expect(governance.restriction.viewers.map((p) => ("accountId" in p ? p.accountId : p.groupId))).toEqual(["aa", "zz"]);
    expect(governance.labels).toEqual(["alpha", "zeta"]);
    expect(governance.contentProperties).toEqual([
      { key: "atlcli.a", value: 42 },
      { key: "atlcli.m", value: "hello" },
      { key: "atlcli.n", value: null },
      { key: "atlcli.z", value: true },
    ]);
    expect(governance.staging).toEqual({ mode: "private-parent", title: "Imported drafts" });
    expect(governanceHasEffects(governance)).toBe(true);
  });

  it("bounds property values and count", () => {
    const big = `atlcli.big=${"x".repeat(3000)}`;
    expect(buildGovernance({ contentProperties: [big] }).errors[0]).toContain("exceeds 2048");
    const many = Array.from({ length: 21 }, (_, i) => `atlcli.k${i}=1`);
    expect(buildGovernance({ contentProperties: many }).errors[0]).toContain("At most 20");
  });
});

describe("renderGovernanceSummary", () => {
  it("includes the attachment-visibility caveat whenever restricted", () => {
    const priv = buildGovernance({ restriction: "private" }).governance;
    expect(renderGovernanceSummary(priv).join("\n")).toContain("attachment downloads follow page visibility");
    const inherit = buildGovernance({}).governance;
    expect(renderGovernanceSummary(inherit).join("\n")).not.toContain("attachment downloads");
  });
});
