import { isPdfBytesHandle, type PdfBytesHandle } from "@atlcli/pdf/browser";

export interface MemoryEmission {
  name: string;
  bytes: Uint8Array;
}

/**
 * Output sink shared by the two format-specific harness cases.
 *
 * Accepts either shape because the two engines no longer agree: `PdfOutputSink`
 * takes a {@link PdfBytesHandle} since spec 010 T5.6, while the DOCX
 * `OutputSink` still hands over a `Uint8Array`. Widening the one shared sink
 * keeps every harness case unchanged.
 */
export class MemoryOutputSink {
  readonly emissions: MemoryEmission[] = [];

  async emit(name: string, bytes: Uint8Array | PdfBytesHandle): Promise<void> {
    const array = isPdfBytesHandle(bytes) ? await bytes.asUint8Array() : bytes;
    this.emissions.push({ name, bytes: array.slice() });
  }

  get single(): MemoryEmission {
    if (this.emissions.length !== 1) {
      throw new Error(`Expected exactly one output, received ${this.emissions.length}.`);
    }
    return this.emissions[0]!;
  }
}
