import { describe, expect, it } from "bun:test";
import { rehearseDevRelease, requiredBoolean } from "./rehearse-dev-release";

describe("dev release rehearsal", () => {
  it("accepts only the dev channel and an explicit Homebrew decision", async () => {
    await expect(rehearseDevRelease(["--channel", "stable", "--publish-homebrew", "false"]))
      .rejects.toThrow("only --channel dev");
    await expect(rehearseDevRelease(["--channel", "dev", "--publish-homebrew", "maybe"]))
      .rejects.toThrow("requires true or false");
  });

  it("accepts the equals-style boolean used by the implementation plan", async () => {
    expect(requiredBoolean(["--publish-homebrew=false"], "--publish-homebrew")).toBe(false);
    expect(requiredBoolean(["--publish-homebrew=true"], "--publish-homebrew")).toBe(true);
  });
});
