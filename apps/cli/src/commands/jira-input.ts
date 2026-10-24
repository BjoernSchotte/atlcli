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

/** `$VISUAL`, else `$EDITOR`, else `vi` (`notepad` on Windows); an empty variable counts as unset (`VISUAL=` would run nothing). */
export function editorCommand(env: Record<string, string | undefined> = process.env, platform: string = process.platform): string {
  // Windows has no vi; Notepad is always there and blocks until closed.
  return env.VISUAL?.trim() || env.EDITOR?.trim() || (platform === "win32" ? "notepad" : "vi");
}

/**
 * The shell line that runs the editor on the file in `$ATLCLI_EDIT_FILE`.
 * The editor is a shell line on purpose (`code --wait`); the file name never
 * becomes shell text, so a name with quotes or `$(…)` cannot run anything.
 */
export function editorShellLine(editor: string, platform: string = process.platform): string {
  return platform === "win32" ? `${editor} "%ATLCLI_EDIT_FILE%"` : `${editor} "$ATLCLI_EDIT_FILE"`;
}

/** A temp file name from `name`: letters, digits, `.`, `_` and `-` only. */
export const safeFileName = (name: string) => name.replace(/[^\w.-]/g, "_").replace(/^\.+/, "_") || "atlcli.md";

/** Edit `initial` in `$VISUAL`/`$EDITOR` (default `vi`); needs a terminal. */
export async function editInEditor(initial: string, name = "atlcli.md"): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("--edit needs a terminal; use --description-file or --body-file in scripts.");
  const dir = await mkdtemp(join(tmpdir(), "atlcli-edit-"));
  const file = join(dir, safeFileName(name));
  try {
    await writeFile(file, initial, "utf8");
    const editor = editorCommand();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(editorShellLine(editor), { stdio: "inherit", shell: true, env: { ...process.env, ATLCLI_EDIT_FILE: file } });
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Editor exited with code ${code}.`))));
    });
    return await readFile(file, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
