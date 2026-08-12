import { describe, expect, it } from "bun:test";
import { rehearseDevRelease } from "./rehearse-dev-release";

describe("dev release rehearsal", () => {
  it("accepts only the dev channel and an explicit Homebrew decision", async () => {
    await expect(rehearseDevRelease(["--channel", "stable", "--publish-homebrew", "false"]))
      .rejects.toThrow("only --channel dev");
    await expect(rehearseDevRelease(["--channel", "dev", "--publish-homebrew", "maybe"]))
      .rejects.toThrow("requires true or false");
  });
});
