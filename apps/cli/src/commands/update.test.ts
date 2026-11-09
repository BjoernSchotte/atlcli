import { describe, expect, test } from "bun:test";
import { homebrewUpdateCommand, reportUpdateFailure } from "./update";

describe("Homebrew update command", () => {
  test("keeps the stable formula command unchanged", () => {
    expect(homebrewUpdateCommand("homebrew")).toBe("brew update && brew upgrade atlcli");
  });

  test("routes dev builds only to the dev formula", () => {
    const command = homebrewUpdateCommand("homebrew-dev");
    expect(command).toBe("brew update && brew upgrade atlcli-dev");
    expect(command).not.toBe("brew update && brew upgrade atlcli");
  });
});

describe("failed update", () => {
  test("exits non-zero under --json too", () => {
    const write = process.stdout.write;
    let printed = "";
    process.stdout.write = ((chunk: string) => ((printed += chunk), true)) as typeof process.stdout.write;
    try {
      reportUpdateFailure("download failed", { json: true });
      expect(process.exitCode).toBe(1);
    } finally {
      process.stdout.write = write;
      process.exitCode = 0;
    }
    expect(JSON.parse(printed)).toEqual({ schemaVersion: "1", success: false, error: "download failed" });
  });
});
