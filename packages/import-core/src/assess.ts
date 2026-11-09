import type { ImportBlock } from "./model.js";
import { documentToAdf } from "./adf.js";
import { EDITABILITY_BUDGETS, assessEncodedAdf } from "./assess-adf.js";

export type EditabilityLevel = "ok" | "caution" | "risk";

export interface EditabilityAssessment {
  adfBytes: number;
  nodeCount: number;
  tableCells: number;
  images: number;
  level: EditabilityLevel;
  recommendation?: string;
}

export { EDITABILITY_BUDGETS };

export function assessEditability(blocks: ImportBlock[]): EditabilityAssessment {
  const adf = documentToAdf({ blocks });
  return assessEncodedAdf(adf, new TextEncoder().encode(JSON.stringify(adf)).byteLength);
}
