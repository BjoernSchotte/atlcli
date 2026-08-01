import { close, createIndex } from "pagefind";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const PAGEFIND_VERSION_V1 = "1.5.2";

export interface BuildPagefindIndexOptionsV1 {
  /** Absolute static site candidate directory. */
  outputDirectory: string;
  /** Relative HTML files already bound to trusted publication page identities. */
  pageOutputPaths: readonly string[];
}

function assertNoErrors(errors: readonly string[], operation: string): void {
  if (errors.length > 0) throw new Error(`Pagefind ${operation} failed: ${errors.join("; ")}`);
}

/**
 * Build a complete Pagefind index from only the static HTML files that the
 * integration already associated with immutable publication source IDs.
 */
export async function buildPagefindIndexV1(options: BuildPagefindIndexOptionsV1): Promise<void> {
  const created = await createIndex({ keepIndexUrl: false, writePlayground: false });
  if (created.index === undefined) {
    throw new Error(`Pagefind did not create an index: ${created.errors.join("; ")}`);
  }
  try {
    assertNoErrors(created.errors, "initialization");
    for (const sourcePath of options.pageOutputPaths) {
      const content = await readFile(join(options.outputDirectory, sourcePath), "utf8");
      const result = await created.index.addHTMLFile({ sourcePath, content });
      assertNoErrors(result.errors, `indexing ${sourcePath}`);
    }
    const written = await created.index.writeFiles({ outputPath: `${options.outputDirectory}/pagefind` });
    assertNoErrors(written.errors, "writing output");
  } finally {
    await created.index.deleteIndex();
    await close();
  }
}
