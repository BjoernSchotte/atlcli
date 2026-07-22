import type { ExportJobStage } from "./snapshot.js";

/** Redacted origin of an issue; large or credential-bearing values are forbidden. */
export interface ExportIssueSourceV1 {
  pageId?: string;
  pageTitle?: string;
  blockId?: string;
  assetRef?: string;
}

/** Stable error categories used for host-neutral policy and presentation. */
export type ExportJobErrorCategoryV1 =
  | "auth"
  | "permission"
  | "network"
  | "rate-limit"
  | "quota"
  | "source"
  | "template"
  | "render"
  | "validation"
  | "commit"
  | "worker"
  | "unknown";

/** Redacted terminal or waiting error attached to a job snapshot. */
export interface ExportJobErrorV1 {
  code: string;
  message: string;
  category: ExportJobErrorCategoryV1;
  retryable: boolean;
  stage?: ExportJobStage;
  source?: ExportIssueSourceV1;
  occurredAt: number;
}
