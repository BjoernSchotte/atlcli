/**
 * Input and list-output helpers for `atlcli jira`. The pure helpers live in
 * `@atlcli/jira` (shared with the TUI) and are re-exported here; only the
 * editor, which needs a terminal, stays in the CLI.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export {
  type UserRef,
  resolveUser,
  pickUser,
  splitNegation,
  jqlIn,
  jqlStatusNames,
  jqlAssignee,
  jqlSince,
  jqlBefore,
  type SearchFilters,
  buildSearchJql,
  type SearchInput,
  SearchInputError,
  searchInputFromFlags,
  searchJql,
  pageAgile,
  findTransition,
  parseReplacements,
  replaceText,
  replaceInBody,
  DEFAULT_COLUMNS,
  needsFieldList,
  resolveColumns,
  cellValue,
  issueCell,
  type TableFormat,
  renderTable,
  renderDetails,
  changelogRows,
  renderIssueView,
} from "@atlcli/jira";

// ============ Editor ============

/** `$VISUAL`, else `$EDITOR`, else `vi`; an empty variable counts as unset (`VISUAL=` would run nothing). */
export function editorCommand(env: Record<string, string | undefined> = process.env): string {
  return env.VISUAL?.trim() || env.EDITOR?.trim() || "vi";
}

/** Edit `initial` in `$VISUAL`/`$EDITOR` (default `vi`); needs a terminal. */
export async function editInEditor(initial: string, name = "atlcli.md"): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("--edit needs a terminal; use --description-file or --body-file in scripts.");
  const dir = await mkdtemp(join(tmpdir(), "atlcli-edit-"));
  const file = join(dir, name);
  try {
    await writeFile(file, initial, "utf8");
    const editor = editorCommand();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(`${editor} "${file}"`, { stdio: "inherit", shell: true });
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Editor exited with code ${code}.`))));
    });
    return await readFile(file, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
