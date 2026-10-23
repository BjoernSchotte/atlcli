import { describe, expect, test } from "bun:test";
import { parseArgs } from "./utils.js";

describe("parseArgs", () => {
  test("a lone '-' after a long flag is its value (stdin), not a positional", () => {
    const parsed = parseArgs(["issue", "create", "--description-file", "-", "--json"]);
    expect(parsed.flags["description-file"]).toBe("-");
    expect(parsed.flags.json).toBe(true);
    expect(parsed._).toEqual(["issue", "create"]);
  });

  test("a dash before a digit is a value: relative dates, negative numbers", () => {
    expect(parseArgs(["--updated", "-7d", "--offset", "-2", "--json"]).flags).toEqual({ updated: "-7d", offset: "-2", json: true });
  });

  test("a following flag still makes the long flag boolean", () => {
    expect(parseArgs(["--dry-run", "--json"]).flags).toEqual({ "dry-run": true, json: true });
  });

  test("--flag=value keeps everything after the first '=' (#271)", () => {
    const parsed = parseArgs(["search", "--jql=project = PROJ AND key = PROJ-1", "--set=field=value", "-x=a=b"]);
    expect(parsed.flags.jql).toBe("project = PROJ AND key = PROJ-1");
    expect(parsed.flags.set).toBe("field=value");
    expect(parsed.flags.x).toBe("a=b");
  });

  test("a switch never swallows the next positional (#272)", () => {
    expect(parseArgs(["jira", "watchers", "--json", "PROJ-123"])).toEqual({ _: ["jira", "watchers", "PROJ-123"], flags: { json: true } });
    expect(parseArgs(["page", "delete", "--confirm", "123", "--dry-run", "456"])._).toEqual(["page", "delete", "123", "456"]);
  });

  test("the jira list and output switches never swallow a positional either", () => {
    expect(parseArgs(["jira", "search", "--watching", "project = AB", "--csv"])).toEqual({
      _: ["jira", "search", "project = AB"],
      flags: { watching: true, csv: true },
    });
    expect(parseArgs(["jira", "issue", "clone", "--edit", "AB-1"])._).toEqual(["jira", "issue", "clone", "AB-1"]);
    expect(parseArgs(["--updated", "-7d"]).flags.updated).toBe("-7d");
  });

  test("audit wiki check switches never swallow the directory", () => {
    expect(parseArgs(["audit", "wiki", "--orphans", "--broken-links", "./docs", "--json"])).toEqual({
      _: ["audit", "wiki", "./docs"],
      flags: { orphans: true, "broken-links": true, json: true },
    });
  });

  test("a value starting with '-' that is not a flag is the value (#272)", () => {
    expect(parseArgs(["--description", "- first item"]).flags.description).toBe("- first item");
    expect(parseArgs(["--offset", "-5"]).flags.offset).toBe("-5");
    expect(parseArgs(["--limit", "-n"]).flags).toEqual({ limit: true, n: true });
  });
});
