/** Render-stage resource demand used by host admission policy. */
export interface ResourceEstimateV1 {
  heapBytes: number;
  spoolBytes: number;
  outputBytes: number;
  rasterPixels: number;
  confidence: "measured" | "estimated" | "unknown";
}
