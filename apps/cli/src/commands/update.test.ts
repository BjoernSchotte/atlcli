import { describe, expect, test } from "bun:test";
import { homebrewUpdateCommand } from "./update";

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
