import { expect, it } from "bun:test";
import DEBUG_VARIANT from "@jitl/quickjs-ng-wasmfile-debug-sync";
import { FixtureMissError, recordingPort, replayPort } from "./fixture-port.js";
import type { ScriptPort } from "./port.js";
import { planScript } from "./verbs.js";

const live = {
  jiraGetIssue: async (key: string) => ({ id: "1", key, fields: { updated: "2026-10-26T10:00:00.000+0000", summary: "Live" } }),
  jiraSearch: async () => ({ issues: [{ id: "1", key: "ATL-1", fields: { updated: "u", summary: "Live" } }] }),
  httpFetch: async (req: { headers: Record<string, string> }) => ({ status: 200, headers: {}, text: `seen ${req.headers.authorization}` }),
  secret: (name: string) => (name === "TOKEN" ? "real-token" : undefined),
  confluenceNormalizeMarkdown: (m: string) => m,
} as unknown as ScriptPort;

const SCRIPT = `export const meta = { permissions: ["jira:read", "jira:write:ATL", "http:api.example.com"], secrets: ["TOKEN"] };
const r = await atlcli.http.get("https://api.example.com/x", { headers: { authorization: atlcli.secret("TOKEN") } });
for await (const issue of atlcli.jira.search("project = ATL")) await atlcli.jira.update(issue.key, { summary: issue.fields.summary + "!" });
export default r.text;`;

it("records every host read without abort signals or secret values, and replays them to the same plan", async () => {
  const { port, calls } = recordingPort(live, new Map([["real-token", "TOKEN"]]));
  const recorded = await planScript(SCRIPT, { port, variant: DEBUG_VARIANT });
  expect(JSON.stringify(calls)).not.toContain("real-token");
  expect(calls.map((c) => c.method)).toEqual(["httpFetch", "jiraSearch", "jiraGetIssue"]);
  expect(calls[0]!.args).toEqual([{ headers: { authorization: "{secret:TOKEN}" }, method: "GET", url: "https://api.example.com/x" }]);

  const replay = replayPort(JSON.parse(JSON.stringify(calls)), { confluenceNormalizeMarkdown: (m) => m });
  const replayed = await planScript(SCRIPT, { port: replay.port, variant: DEBUG_VARIANT });
  expect(replayed.operations).toEqual(recorded.operations);
  expect(replayed.value).toBe("seen {secret:TOKEN}");
  expect(replay.misses).toEqual([]);
});

it("names the call a fixture lacks, and replays recorded errors", async () => {
  const replay = replayPort([{ method: "jiraGetIssue", args: ["ATL-1", { fields: ["summary"] }], error: "Issue does not exist" }], {
    confluenceNormalizeMarkdown: (m) => m,
  });
  await expect(planScript(`await atlcli.jira.get("ATL-1", { fields: ["summary"] })`, { port: replay.port, variant: DEBUG_VARIANT })).rejects.toThrow(
    "Issue does not exist",
  );
  await expect(planScript(`await atlcli.jira.get("ATL-2")`, { port: replay.port, variant: DEBUG_VARIANT })).rejects.toThrow(/no answer for jiraGetIssue\("ATL-2"\)/);
  expect(replay.misses[0]).toBeInstanceOf(FixtureMissError);
});
