import type {
  ChatAgentPortV1,
  ChatInteractionStateV1,
} from "@atlcli/research/node";

export type CliChatControlResultV1 = {
  kind: "ignored" | "help" | "queue" | "queued" | "edited" | "removed" | "steered" | "stopped";
  message: string;
  state?: ChatInteractionStateV1;
};

function argument(line: string, command: string): string {
  return line.slice(command.length).trim();
}

function queueSummary(state: ChatInteractionStateV1 | null): string {
  const queue = state?.queue ?? [];
  const steering = state?.pendingSteering ?? state?.acceptedSteering;
  if (queue.length === 0 && !steering) return "No queued follow-ups or steering request.";
  return [
    ...queue.map((entry) => `${entry.id} [r${entry.revision}] ${entry.content}`),
    ...(steering
      ? [`${steering.id} [r${steering.revision}] STEER ${steering.instruction}`]
      : []),
  ].join("\n");
}

function requireValue(value: string, usage: string): string {
  if (!value) throw new Error(`Missing value. Usage: ${usage}`);
  return value;
}

/**
 * Line-oriented presenter for the shared ChatAgentPortV1 controls. A future TUI
 * can call the same port directly; this parser owns no workflow or state.
 */
export async function handleCliChatControlLineV1(input: {
  line: string;
  port: ChatAgentPortV1;
  siteOrigin: string;
  createId(kind: "message" | "steering"): string;
}): Promise<CliChatControlResultV1> {
  const line = input.line.trim();
  if (!line) return { kind: "ignored", message: "" };
  if (line === "/help") {
    return {
      kind: "help",
      message: [
        "Enter text to queue a follow-up.",
        "/steer <instruction>  apply at the next safe checkpoint",
        "/queue                list queued and steering messages",
        "/edit <id> <text>     edit a queued message",
        "/delete <id>          remove a queued message",
        "/stop                 stop the active turn",
      ].join("\n"),
    };
  }
  if (line === "/queue") {
    return {
      kind: "queue",
      message: queueSummary(await input.port.getInteraction(input.siteOrigin)),
    };
  }
  if (line === "/stop") {
    const status = await input.port.stop();
    return {
      kind: "stopped",
      message: status === "stop_requested" ? "Stop requested." : "No Chat turn is active.",
    };
  }
  const current = await input.port.getInteraction(input.siteOrigin);
  const expectedRevision = current?.revision ?? 1;
  if (line.startsWith("/steer")) {
    const instruction = requireValue(argument(line, "/steer"), "/steer <instruction>");
    const state = await input.port.control({
      kind: "steer",
      expectedRevision,
      steeringId: input.createId("steering"),
      instruction,
    });
    return { kind: "steered", message: "Steering saved; replanning at the next safe checkpoint.", state };
  }
  if (line.startsWith("/edit")) {
    const value = requireValue(argument(line, "/edit"), "/edit <id> <text>");
    const separator = value.indexOf(" ");
    if (separator < 1) throw new Error("Missing text. Usage: /edit <id> <text>");
    const messageId = value.slice(0, separator);
    const content = value.slice(separator + 1).trim();
    const queued = current?.queue.find((entry) => entry.id === messageId);
    if (!queued || !content) throw new Error("The queued message is unavailable or the edit is empty.");
    const state = await input.port.control({
      kind: "edit",
      expectedRevision,
      messageId,
      expectedMessageRevision: queued.revision,
      content,
    });
    return { kind: "edited", message: `Edited ${messageId}.`, state };
  }
  if (line.startsWith("/delete")) {
    const messageId = requireValue(argument(line, "/delete"), "/delete <id>");
    const queued = current?.queue.find((entry) => entry.id === messageId);
    if (!queued) throw new Error("The queued message is unavailable.");
    const state = await input.port.control({
      kind: "remove",
      expectedRevision,
      messageId,
      expectedMessageRevision: queued.revision,
    });
    return { kind: "removed", message: `Removed ${messageId}.`, state };
  }
  if (line.startsWith("/")) {
    throw new Error("Unknown Chat control. Use /help.");
  }
  const messageId = input.createId("message");
  const state = await input.port.control({
    kind: "enqueue",
    expectedRevision,
    messageId,
    content: line,
  });
  return { kind: "queued", message: `Queued ${messageId}.`, state };
}
