import { close, createIndex } from "pagefind";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertPagefindSearchBudgetV1,
  measurePagefindSearchBudgetV1,
  PUBLICATION_SEARCH_BUDGETS_V1,
  publicationSearchCorpusClassV1,
  type PublicationSearchBudgetMeasurementV1,
  type PublicationSearchBudgetV1,
} from "./search-budget.js";

export const PAGEFIND_VERSION_V1 = "1.5.2";

export interface BuildPagefindIndexOptionsV1 {
  /** Absolute static site candidate directory. */
  outputDirectory: string;
  /** Relative HTML files already bound to trusted publication page identities. */
  pageOutputPaths: readonly string[];
  /** Optional override for tests or an operator's explicitly stricter gate. */
  budget?: PublicationSearchBudgetV1;
}

function assertNoErrors(errors: readonly string[], operation: string): void {
  if (errors.length > 0) throw new Error(`Pagefind ${operation} failed: ${errors.join("; ")}`);
}

/**
 * Build a complete Pagefind index from only the static HTML files that the
 * integration already associated with immutable publication source IDs.
 */
export async function buildPagefindIndexV1(options: BuildPagefindIndexOptionsV1): Promise<PublicationSearchBudgetMeasurementV1> {
  const created = await createIndex({ keepIndexUrl: false, writePlayground: false });
  if (created.index === undefined) {
    throw new Error(`Pagefind did not create an index: ${created.errors.join("; ")}`);
  }
  try {
    assertNoErrors(created.errors, "initialization");
    for (const sourcePath of options.pageOutputPaths) {
      const content = await readFile(join(options.outputDirectory, sourcePath), "utf8");
      const bodies = content.match(/\bdata-pagefind-body\b/gu) ?? [];
      if (bodies.length !== 1) {
        throw new Error(`Pagefind requires exactly one trusted data-pagefind-body region in ${sourcePath}`);
      }
      const result = await created.index.addHTMLFile({ sourcePath, content });
      assertNoErrors(result.errors, `indexing ${sourcePath}`);
    }
    const written = await created.index.writeFiles({ outputPath: `${options.outputDirectory}/pagefind` });
    assertNoErrors(written.errors, "writing output");
    const measurement = await measurePagefindSearchBudgetV1({
      outputDirectory: options.outputDirectory,
      pageCount: options.pageOutputPaths.length,
    });
    assertPagefindSearchBudgetV1(
      measurement,
      options.budget ?? PUBLICATION_SEARCH_BUDGETS_V1[publicationSearchCorpusClassV1(options.pageOutputPaths.length)],
    );
    return measurement;
  } finally {
    await created.index.deleteIndex();
    await close();
  }
}
