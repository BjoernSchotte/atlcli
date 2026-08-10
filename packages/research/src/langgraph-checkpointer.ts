import { ResearchContractError } from "./contracts.js";
import { researchThreadIdForSessionV1 } from "./checkpoint-identity.js";
import {
  MemorySaver,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";

function rejectForeignThread(config: RunnableConfig, expectedThreadId: string): void {
  if (config.configurable?.thread_id !== expectedThreadId) {
    throw new ResearchContractError("access-denied", "LangGraph checkpoint operation is outside the research session thread.");
  }
}

/**
 * LangGraph-native T4 adapter for one durable research session. It deliberately
 * owns exactly one derived thread ID; callers cannot inspect or erase another
 * session by supplying a different `configurable.thread_id`.
 *
 * Memory is the T4 reference backend. SQLite/filesystem and IndexedDB adapters
 * will retain this same scope fence and public BaseCheckpointSaver semantics.
 */
export class ResearchSessionMemoryCheckpointerV1 extends MemorySaver {
  readonly #threadId: string;

  constructor(sessionId: string) {
    super();
    this.#threadId = researchThreadIdForSessionV1(sessionId);
  }

  override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    rejectForeignThread(config, this.#threadId);
    return super.getTuple(config);
  }

  override async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    rejectForeignThread(config, this.#threadId);
    if (options?.before) rejectForeignThread(options.before, this.#threadId);
    for await (const tuple of super.list(config, options)) yield tuple;
  }

  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions?: ChannelVersions,
  ): Promise<RunnableConfig> {
    rejectForeignThread(config, this.#threadId);
    return super.put(config, checkpoint, metadata);
  }

  override async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    rejectForeignThread(config, this.#threadId);
    return super.putWrites(config, writes, taskId);
  }

  override async deleteThread(threadId: string): Promise<void> {
    if (threadId !== this.#threadId) {
      throw new ResearchContractError("access-denied", "LangGraph checkpoint deletion is outside the research session thread.");
    }
    return super.deleteThread(threadId);
  }
}
