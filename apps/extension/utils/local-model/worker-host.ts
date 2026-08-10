import type { LocalModelWorkerConnectV1 } from "./protocol.js";

export interface LocalModelWorkerLikeV1 {
  postMessage(message: LocalModelWorkerConnectV1, transfer: Transferable[]): void;
  terminate(): void;
}

/** Offscreen-owned lifetime boundary for the one loaded local model worker. */
export class LocalModelWorkerHostV1 {
  constructor(
    readonly modelId: string,
    readonly worker: LocalModelWorkerLikeV1,
  ) {}

  connect(): { kind: "local-gemma"; modelId: string; port: MessagePort } {
    const channel = new MessageChannel();
    this.worker.postMessage(
      { kind: "local-model:connect", port: channel.port2 },
      [channel.port2],
    );
    return { kind: "local-gemma", modelId: this.modelId, port: channel.port1 };
  }

  terminate(): void {
    this.worker.terminate();
  }
}
