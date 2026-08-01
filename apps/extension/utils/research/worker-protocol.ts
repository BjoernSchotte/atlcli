import type {
  ResearchErrorCode,
  ResearchOneShotEventV1,
  ResearchOneShotPolicyV1,
  ResearchProgressV1,
  ResearchReport,
  ResearchRequestV1,
} from "./contracts.js";

export type ResearchWorkerRequestV1 = {
  kind: "research-worker:run";
  runId: string;
  sessionId: string;
  turnId: string;
  apiKey: string;
  request: ResearchRequestV1;
  policy?: ResearchOneShotPolicyV1;
};

export type ResearchWorkerResponseV1 =
  | {
      kind: "research-worker:event";
      runId: string;
      event: ResearchOneShotEventV1;
    }
  | {
      kind: "research-worker:progress";
      runId: string;
      progress: ResearchProgressV1;
    }
  | {
      kind: "research-worker:complete";
      runId: string;
      report: ResearchReport;
    }
  | {
      kind: "research-worker:error";
      runId: string;
      code: ResearchErrorCode;
      error: string;
    };
