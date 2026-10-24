import { expect, test } from "bun:test";
import { createCliScriptPort } from "./script-port.js";

const unused = (): never => {
  throw new Error("no client call expected");
};

// Regression: the page id becomes a positional argument of the `wiki export`
// child process, and a plan file can be edited, so a flag must not get through.
test.each([["--output=/tmp/x"], ["--template=evil.docx"], ["123 --json"], ["plan:3"]])(
  "export refuses a page id that is not one (%s)",
  async (pageId) => {
    const port = createCliScriptPort(unused, unused, "https://example.atlassian.net", { profileName: "p", outDir: "/tmp" });
    await expect(port.confluenceExport({ pageId, format: "pdf", path: "x.pdf" })).rejects.toThrow("Not a Confluence page id");
  },
);
