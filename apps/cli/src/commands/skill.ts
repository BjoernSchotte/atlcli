/**
 * `atlcli skill`: the agent skill built into this binary.
 *
 * atlcli skill                     - Print SKILL.md
 * atlcli skill <path>              - Print one file, by a link as written
 * atlcli skill --list              - List the files
 * atlcli skill --install <root>    - Write the skill to <root>/atlcli/
 *
 * Printing is raw `process.stdout.write`, so the bytes an agent reads are the
 * bytes of the file, without the newline `output()` appends.
 */
import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { ERROR_CODES, fail, hasFlag, output } from "@atlcli/core";
import type { OutputOptions } from "@atlcli/core";
import { findSkillFile, SKILL_FILES } from "../skill-files.js";

type Flags = Record<string, string | boolean | string[]>;

export async function handleSkill(args: string[], flags: Flags, opts: OutputOptions): Promise<void> {
  if (hasFlag(flags, "help") || hasFlag(flags, "h")) {
    output(skillHelp(), opts);
    return;
  }

  // =========================================================================
  // Arguments
  // =========================================================================

  // `--list` is a switch, so only `--list=value` can give it a value.
  if (typeof flags.list === "string" || Array.isArray(flags.list)) {
    usage(opts, "--list takes no value");
  }
  const list = flags.list === true;

  // `--install=` parses as an empty string, which would resolve to the
  // working directory and install there unasked.
  const install = flags.install;
  if (install === true || install === "") {
    usage(opts, "--install needs a skills directory, such as .claude/skills");
  }
  if (Array.isArray(install)) {
    usage(opts, "--install takes one directory");
  }

  if (args.length > 1) {
    usage(opts, "atlcli skill takes at most one path");
  }
  const [link] = args;
  if ([link !== undefined, list, install !== undefined].filter(Boolean).length > 1) {
    usage(opts, "Use only one of <path>, --list and --install");
  }

  // =========================================================================
  // Modes
  // =========================================================================

  if (list) {
    const files = SKILL_FILES.map((file) => file.path);
    output(opts.json ? { files } : files.join("\n"), opts);
    return;
  }

  if (typeof install === "string") {
    await runInstall(install, opts);
    return;
  }

  const file = link === undefined ? SKILL_FILES[0] : findSkillFile(link);
  if (!file) {
    const available = SKILL_FILES.map((entry) => entry.path);
    const headline = `Unknown skill file: ${link}`;
    // Text mode prints only the message, so the list has to be part of it.
    const message = opts.json
      ? headline
      : `${headline}\nAvailable files:\n${available.map((path) => `  ${path}`).join("\n")}`;
    fail(opts, 1, ERROR_CODES.USAGE, message, { path: link, available });
  }
  if (opts.json) {
    output({ path: file.path, content: file.content }, opts);
    return;
  }
  process.stdout.write(file.content);
}

function usage(opts: OutputOptions, message: string): never {
  return fail(opts, 1, ERROR_CODES.USAGE, message);
}

async function runInstall(skillsRoot: string, opts: OutputOptions): Promise<void> {
  let result: SkillInstallResult;
  try {
    result = await installSkill(skillsRoot);
  } catch (error) {
    if (!(error instanceof SkillInstallError)) throw error;
    fail(opts, 1, ERROR_CODES.IO, error.message, { path: error.path });
  }
  if (opts.json) {
    output(result, opts);
    return;
  }
  const lines = [`Installed the atlcli skill into ${result.directory} (${result.files.length} files).`];
  if (result.extra.length > 0) {
    lines.push("Left in place, not part of this skill:", ...result.extra.map((path) => `  ${path}`));
  }
  output(lines.join("\n"), opts);
}

// =========================================================================
// Installation
// =========================================================================

export interface SkillInstallResult {
  /** Absolute path of `<skills-root>/atlcli`. */
  directory: string;
  /** The skill's files, relative to `directory`. */
  files: string[];
  /** Other files found in `directory`, relative to it, sorted. */
  extra: string[];
}

export class SkillInstallError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Writes the skill to `<skillsRoot>/atlcli/`, overwriting the skill's files and
 * leaving every other file in place.
 *
 * Nothing is written through a symbolic link: a developer may have linked
 * `atlcli/`, `references/` or a single file to a checkout of the repository,
 * and writing through the link would replace the checkout with this binary's
 * copy. All targets are checked before the first write, so a refusal leaves
 * the directory untouched. A failure during the writes leaves the files
 * already written; running the install again overwrites them.
 */
export async function installSkill(skillsRoot: string): Promise<SkillInstallResult> {
  const directory = resolve(skillsRoot, "atlcli");
  const references = join(directory, "references");

  await expectAbsentOr(directory, "directory");
  await expectAbsentOr(references, "directory");
  for (const file of SKILL_FILES) await expectAbsentOr(join(directory, file.path), "file");

  for (const dir of [directory, references]) {
    try {
      await mkdir(dir, { recursive: true });
    } catch (error) {
      throw new SkillInstallError(dir, `Cannot create ${dir}: ${errorMessage(error)}`);
    }
  }

  const written = new Set<string>();
  for (const file of SKILL_FILES) {
    const target = join(directory, file.path);
    try {
      await writeFile(target, file.content);
    } catch (error) {
      throw new SkillInstallError(target, `Cannot write ${target}: ${errorMessage(error)}`);
    }
    const identity = fileIdentity(await lstat(target, { bigint: true }));
    if (identity) written.add(identity);
  }

  return {
    directory,
    files: SKILL_FILES.map((file) => file.path),
    extra: await filesOutsideSkill(directory, written),
  };
}

async function expectAbsentOr(path: string, kind: "directory" | "file"): Promise<void> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new SkillInstallError(path, `Cannot inspect ${path}: ${errorMessage(error)}`);
  }
  if (stats.isSymbolicLink()) {
    throw new SkillInstallError(path, `${path} is a symbolic link; remove it or install elsewhere`);
  }
  if (kind === "directory" && !stats.isDirectory()) {
    throw new SkillInstallError(path, `${path} is not a directory`);
  }
  if (kind === "file" && !stats.isFile()) {
    throw new SkillInstallError(path, `${path} is not a regular file`);
  }
}

/**
 * Device and inode of a file, or `undefined` where the filesystem reports no
 * inode (FAT and some network mounts report 0). BigInt stats keep NTFS file
 * ids, which exceed 2^53, exact.
 */
function fileIdentity(stats: BigIntStats): string | undefined {
  return stats.ino === 0n ? undefined : `${stats.dev}:${stats.ino}`;
}

/**
 * Files in `directory` that are not the files just written, as sorted POSIX
 * paths relative to it.
 *
 * A file counts as part of the skill when it is the same file as one just
 * written, compared by device and inode rather than by name: on a
 * case-insensitive filesystem an existing `skill.md` is the `SKILL.md` that was
 * overwritten, while on a case-sensitive one it is a separate file. A hard
 * link to a skill file therefore also counts as part of the skill. Where the
 * filesystem reports no inode, the path is compared instead. Symbolic links are
 * listed, never followed.
 */
async function filesOutsideSkill(directory: string, written: Set<string>): Promise<string[]> {
  const skillPaths = new Set(SKILL_FILES.map((file) => file.path));
  const extra: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const path = relative(directory, full).split(sep).join("/");
      const identity = fileIdentity(await lstat(full, { bigint: true }));
      const partOfSkill = identity ? written.has(identity) : skillPaths.has(path);
      if (!partOfSkill) extra.push(path);
    }
  };
  await walk(directory);
  return extra.sort();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function skillHelp(): string {
  return `atlcli skill [<path>] [--list] [--install <skills-root>]

Print the agent skill built into this atlcli binary.

Usage:
  atlcli skill                     Print SKILL.md
  atlcli skill <path>              Print one file, by the path a link in the skill uses
  atlcli skill --list              List the files of the skill
  atlcli skill --install <root>    Write the skill to <root>/atlcli/

Options:
  --list               List the files
  --install <root>     Skills directory to install into, such as .claude/skills
  --json               JSON output

Examples:
  atlcli skill references/safety.md
  atlcli skill --install ~/.claude/skills
`;
}
