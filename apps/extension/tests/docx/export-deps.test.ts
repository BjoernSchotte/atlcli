import { describe, expect, it, mock } from "bun:test";
import type { ScanResult } from "@atlcli/docx/browser";
import { prepareExportDeps, scanDependencies } from "../../utils/docx/export-deps.js";

function scan(...raw: string[]): ScanResult {
  return {
    supported: raw.map((value) => ({
      base: value.replace(/\.?\(.*$/, ""),
      status: "supported" as const,
      count: 1,
      raw: [value],
    })),
    unsupported: [],
    never: [],
    parts: ["word/document.xml"],
    hasContentPlaceholder: true,
  };
}

function loaders() {
  return {
    getSpaceWithIcon: mock(async (key: string) => ({
      space: { id: "1", key, name: key, type: "global" as const },
      icon: { path: `/download/${key}?version=1` },
    })),
    getCurrentUser: mock(async () => ({ accountId: "u", displayName: "User" })),
    getPageOwner: mock(async () => ({ accountId: "o", displayName: "Owner" })),
    getSpaceHomepageStorage: mock(async () => "<p>home</p>"),
  };
}

describe("scanDependencies", () => {
  it("recognizes only the resolver/logo calls required by supported placeholders", () => {
    const deps = scanDependencies(
      scan(
        "$scroll.title",
        "$scroll.space.name",
        "$scroll.exporter.fullName",
        "$scroll.pageowner.fullName",
        "$scroll.spacelogo",
        "$scroll.pageproperty.(Status,false)",
        "$scroll.pageproperty.(Owner,macro-id,true,Unknown)"
      )
    );
    expect([...deps].sort().join(",")).toBe(
      ["currentUser", "owner", "space", "spaceHomepage", "spaceLogo"].sort().join(",")
    );
  });
});

describe("prepareExportDeps", () => {
  it("pre-starts only scan-indicated calls and coalesces space + logo", async () => {
    const host = loaders();
    const deps = prepareExportDeps(
      scan("$scroll.space.name", "$scroll.spacelogo"),
      { id: "42", spaceKey: "DOCSY" },
      host
    );

    expect(host.getSpaceWithIcon).toHaveBeenCalledTimes(1);
    expect(host.getCurrentUser).not.toHaveBeenCalled();
    expect(host.getPageOwner).not.toHaveBeenCalled();
    expect(host.getSpaceHomepageStorage).not.toHaveBeenCalled();
    expect(await deps.getSpace!("DOCSY")).toMatchObject({ key: "DOCSY" });
    expect(await deps.getSpaceLogo!("DOCSY")).toEqual({
      url: "/download/DOCSY?version=1",
    });
    expect(host.getSpaceWithIcon).toHaveBeenCalledTimes(1);
  });

  it("keeps current-user and homepage loads per-export while preserving rejection", async () => {
    const host = loaders();
    host.getCurrentUser.mockImplementation(async () => {
      throw new Error("logged out");
    });
    const deps = prepareExportDeps(
      scan("$scroll.exporter", "$scroll.pageproperty.(Status,true)"),
      { id: "42", spaceKey: "DOCSY" },
      host
    );

    expect(host.getCurrentUser).toHaveBeenCalledTimes(1);
    expect(host.getSpaceHomepageStorage).toHaveBeenCalledTimes(1);
    await expect(deps.getCurrentUser!()).rejects.toThrow("logged out");
    expect(await deps.getSpaceHomepageStorage!("DOCSY")).toBe("<p>home</p>");
    expect(host.getSpaceHomepageStorage).toHaveBeenCalledTimes(1);
  });

  it("does not retain auth/content-sensitive values across exports", async () => {
    const host = loaders();
    const templateScan = scan("$scroll.exporter", "$scroll.pageproperty.(Status,true)");

    prepareExportDeps(templateScan, { id: "42", spaceKey: "DOCSY" }, host);
    prepareExportDeps(templateScan, { id: "42", spaceKey: "DOCSY" }, host);

    expect(host.getCurrentUser).toHaveBeenCalledTimes(2);
    expect(host.getSpaceHomepageStorage).toHaveBeenCalledTimes(2);
  });
});
