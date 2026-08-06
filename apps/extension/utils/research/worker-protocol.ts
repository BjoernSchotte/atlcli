import type {
  ChatPresentationStreamEventV1,
  ChatQualityPolicyV1,
  ChatAnswerV1,
  ResearchErrorCode,
  ResearchOneShotEventV1,
  ResearchOneShotPolicyV1,
  ResearchProgressV1,
  ResearchReport,
  ResearchRequestV1,
} from "./contracts.js";
import type { ChatHostIdentityV1 } from "@atlcli/research";

export type ResearchWorkerRequestV1 =
  | {
      kind: "research-worker:run";
      runId: string;
      sessionId: string;
      turnId: string;
      apiKey: string;
      mode?: "chat" | "research";
      request: ResearchRequestV1;
      policy?: ResearchOneShotPolicyV1;
      qualityPolicy?: ChatQualityPolicyV1;
      hostIdentity?: ChatHostIdentityV1;
      resume?: false;
    }
  | {
      /**
       * Resume has no caller-controlled request or policy. The dedicated
       * worker reconstructs both from the accepted durable brief.
       */
      kind: "research-worker:run";
      runId: string;
      sessionId: string;
      turnId: string;
      apiKey: string;
      resume: true;
    };

export type ResearchWorkerResponseV1 =
  | {
      kind: "research-worker:chat-presentation";
      runId: string;
      event: ChatPresentationStreamEventV1;
    }
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
      answer?: never;
    }
  | {
      kind: "research-worker:complete";
      runId: string;
      answer: ChatAnswerV1;
      report?: never;
    }
  | {
      kind: "research-worker:error";
      runId: string;
      code: ResearchErrorCode;
      error: string;
    };
