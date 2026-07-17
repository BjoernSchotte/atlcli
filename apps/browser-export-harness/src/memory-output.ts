export interface MemoryEmission {
  name: string;
  bytes: Uint8Array;
}

/** Output sink shared by the two format-specific harness cases. */
export class MemoryOutputSink {
  readonly emissions: MemoryEmission[] = [];

  async emit(name: string, bytes: Uint8Array): Promise<void> {
    this.emissions.push({ name, bytes: bytes.slice() });
  }

  get single(): MemoryEmission {
    if (this.emissions.length !== 1) {
      throw new Error(`Expected exactly one output, received ${this.emissions.length}.`);
    }
    return this.emissions[0]!;
  }
}
