import type {
  ResearchErrorCode,
  ResearchProgressV1,
  ResearchReportV1,
  ResearchRequestV1,
} from "./contracts.js";

export type ResearchWorkerRequestV1 = {
  kind: "research-worker:run";
  runId: string;
  apiKey: string;
  request: ResearchRequestV1;
};

export type ResearchWorkerResponseV1 =
  | {
      kind: "research-worker:progress";
      runId: string;
      progress: ResearchProgressV1;
    }
  | {
      kind: "research-worker:complete";
      runId: string;
      report: ResearchReportV1;
    }
  | {
      kind: "research-worker:error";
      runId: string;
      code: ResearchErrorCode;
      error: string;
    };
