import { afterEach, describe, expect, test } from "bun:test";
import {
  RESEARCH_PACKET_BODY_SCHEMA_V2,
  SqliteResearchSessionStoreV1,
} from "@atlcli/research/bun";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const roots: string[] = [];
const fixture = join(import.meta.dir, "research-process-recovery.fixture.ts");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runFixture(args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const child = Bun.spawn([
    process.execPath,
    "--conditions=development",
    "run",
    fixture,
    ...args,
  ], {
    cwd: join(import.meta.dir, "..", "..", "..", ".."),
    env: { ...process.env, ATLCLI_DISABLE_UPDATE_CHECK: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("research CLI process recovery", () => {
  test("recovers hard stops at a checkpoint and after continuation consumption without duplicating accepted work", async () => {
    const root = await mkdtemp(join(tmpdir(), "atlcli-research-process-recovery-"));
    roots.push(root);
    const interrupted = await runFixture(["--mode", "interrupt", "--root", root]);
    expect(interrupted.exitCode).not.toBe(0);

    const store = new SqliteResearchSessionStoreV1({
      databasePath: join(root, "catalog.sqlite"),
      root: join(root, "sessions"),
    });
    const checkpointed = await store.read("research-session:process-recovery");
    const checkpointedTurn = checkpointed?.turns.find((turn) => turn.id === "research-turn:process-recovery");
    const taskIds = Array.from(checkpointedTurn!.tasks, (task) => task.taskId).sort();
    const packetIds = Array.from(checkpointedTurn!.acceptedPackets, (packet) => packet.packetRef).sort();
    expect(checkpointed).toMatchObject({ status: "waiting_authentication" });
    expect(checkpointedTurn).toMatchObject({
      tasks: expect.arrayContaining([
        expect.objectContaining({ status: "complete", expectedOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V2 }),
      ]),
      acceptedPackets: expect.arrayContaining([
        expect.objectContaining({ body: expect.objectContaining({ schema: RESEARCH_PACKET_BODY_SCHEMA_V2 }) }),
      ]),
      retrievalAssessments: [expect.objectContaining({ continuation: expect.objectContaining({ status: "issued" }) })],
    });
    store.close();

    const consumedThenKilled = await runFixture(["--mode", "consume-and-kill", "--root", root, "--output", join(root, "unused.md")]);
    expect(consumedThenKilled.exitCode).not.toBe(0);
    const afterConsumeStore = new SqliteResearchSessionStoreV1({
      databasePath: join(root, "catalog.sqlite"),
      root: join(root, "sessions"),
    });
    const afterConsume = await afterConsumeStore.read("research-session:process-recovery");
    const afterConsumeTurn = afterConsume?.turns.find((turn) => turn.id === "research-turn:process-recovery");
    expect(afterConsume).toMatchObject({ status: "running" });
    expect(afterConsumeTurn?.retrievalAssessments).toEqual([
      expect.objectContaining({ continuation: expect.objectContaining({ status: "consumed" }) }),
    ]);
    expect(afterConsumeTurn && Array.from(afterConsumeTurn.tasks, (task) => task.taskId).sort()).toEqual(taskIds);
    expect(afterConsumeTurn && Array.from(afterConsumeTurn.acceptedPackets, (packet) => packet.packetRef).sort()).toEqual(packetIds);
    afterConsumeStore.close();

    await Bun.sleep(20);
    const output = join(root, "report.md");
    const resumed = await runFixture(["--mode", "resume", "--root", root, "--output", output]);
    expect(resumed.exitCode).toBe(0);
    const markdown = await readFile(output, "utf8");
    expect(resumed.stdout).toBe(markdown);
    expect(markdown).toContain("# Recovered process report");

    const reopened = new SqliteResearchSessionStoreV1({
      databasePath: join(root, "catalog.sqlite"),
      root: join(root, "sessions"),
    });
    const recovered = await reopened.read("research-session:process-recovery");
    const recoveredTurn = recovered?.turns.find((turn) => turn.id === "research-turn:process-recovery");
    expect(recovered).toMatchObject({ status: "running" });
    expect(recoveredTurn && Array.from(recoveredTurn.tasks, (task) => task.taskId).sort()).toEqual(taskIds);
    expect(recoveredTurn && Array.from(recoveredTurn.acceptedPackets, (packet) => packet.packetRef).sort()).toEqual(packetIds);
    expect(recoveredTurn?.retrievalAssessments).toEqual([
      expect.objectContaining({ continuation: expect.objectContaining({ status: "consumed" }) }),
    ]);
    expect((await reopened.events("research-session:process-recovery")).map((event) => event.kind))
      .toEqual([
        "create_turn",
        "record_brief",
        "propose_graph",
        "approve_graph",
        "commit_graph_selection",
        "admit_tasks",
        "dispatch_started",
        "accept_packet",
        "admit_tasks",
        "dispatch_started",
        "accept_packet",
        "record_retrieval_assessment",
        "wait_authentication",
        "recover",
        "resume",
        "consume_retrieval_continuation",
        "heartbeat",
        "recover",
        "reissue_retrieval_continuation",
        "consume_retrieval_continuation",
      ]);
    reopened.close();
  });
});
