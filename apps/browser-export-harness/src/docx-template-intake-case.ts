import type { DocxTemplateIntakeCaseResult } from "./docx-template-intake-flow.js";
import { runDocxTemplateIntakeFlow } from "./docx-template-intake-flow.js";
import { HarnessPdfWorkerClient } from "./pdf-worker-client.js";

const compiler = new HarnessPdfWorkerClient();

export async function runDocxTemplateIntakeCase(): Promise<DocxTemplateIntakeCaseResult> {
  return (await runDocxTemplateIntakeFlow(compiler)).result;
}
