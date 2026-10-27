import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutputOptions } from "@atlcli/core";
import { SKILL_FILES } from "../skill-files.js";

/** What `fail()` was called with; the mock throws it so the handler stops as it would on `process.exit`. */
class FailCalled extends Error {
  constructor(
    readonly exitCode: number,
    readonly errCode: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const outputMock = mock<(data: unknown, opts: OutputOptions) => void>(() => {});
const failMock = mock(
  (_opts: OutputOptions, exitCode: number, errCode: string, message: string, details?: Record<string, unknown>) => {
    throw new FailCalled(exitCode, errCode, message, details);
  },
);

// Spread the real barrel rather than replacing it: when `@atlcli/core` has not
// been evaluated yet, Bun treats the factory result as the COMPLETE export set.
const actualCore = { ...(await import("@atlcli/core")) };
mock.module("@atlcli/core", () => ({ ...actualCore, output: outputMock, fail: failMock }));

// `mock.module` is process-wide; restore the genuine barrel for later test files.
afterAll(() => {
  mock.module("@atlcli/core", () => actualCore);
});

const { handleSkill, skillHelp } = await import("./skill.js");

const SKILL_MD = SKILL_FILES[0]!.content;
const ALL_PATHS = SKILL_FILES.map((file) => file.path);
const canTestPermissions = process.platform !== "win32" && process.getuid?.() !== 0;

let stdout: string[];
let writeSpy: ReturnType<typeof spyOn>;
let tempDirs: string[];

beforeEach(() => {
  outputMock.mockClear();
  failMock.mockClear();
  stdout = [];
  tempDirs = [];
  writeSpy = spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
});

afterEach(() => {
  writeSpy.mockRestore();
  for (const dir of tempDirs) {
    // A permissions test may leave a read-only directory behind on failure.
    for (const entry of [dir, join(dir, "atlcli"), join(dir, "atlcli", "references")]) {
      if (existsSync(entry) && !lstatSync(entry).isSymbolicLink()) chmodSync(entry, 0o700);
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "atlcli-skill-"));
  tempDirs.push(dir);
  return dir;
}

async function run(
  args: string[],
  flags: Record<string, string | boolean | string[]> = {},
  json = false,
): Promise<{ stdout: string; outputs: unknown[]; failure?: FailCalled }> {
  let failure: FailCalled | undefined;
  try {
    await handleSkill(args, flags, { json });
  } catch (error) {
    if (!(error instanceof FailCalled)) throw error;
    failure = error;
  }
  return { stdout: stdout.join(""), outputs: outputMock.mock.calls.map((call) => call[0]), failure };
}

describe("atlcli skill: printing", () => {
  it("prints SKILL.md byte for byte without arguments", async () => {
    expect((await run([])).stdout).toBe(SKILL_MD);
  });

  it("prints a reference by the path SKILL.md links it with", async () => {
    const safety = SKILL_FILES.find((file) => file.path === "references/safety.md")!.content;
    expect((await run(["references/safety.md"])).stdout).toBe(safety);
  });

  it("prints the file of a link with an anchor", async () => {
    const invocation = SKILL_FILES.find((file) => file.path === "references/invocation.md")!.content;
    expect((await run(["references/invocation.md#flag-grammar"])).stdout).toBe(invocation);
  });

  it("prints a reference by a sibling link from another reference", async () => {
    const safety = SKILL_FILES.find((file) => file.path === "references/safety.md")!.content;
    expect((await run(["safety.md"])).stdout).toBe(safety);
  });

  it("lists the files one per line, SKILL.md first", async () => {
    expect((await run([], { list: true })).outputs).toEqual([ALL_PATHS.join("\n")]);
  });

  it("prints a file as JSON", async () => {
    expect((await run(["SKILL.md"], {}, true)).outputs).toEqual([{ path: "SKILL.md", content: SKILL_MD }]);
  });

  it("lists the files as JSON", async () => {
    expect((await run([], { list: true }, true)).outputs).toEqual([{ files: ALL_PATHS }]);
  });
});

describe("atlcli skill: unknown paths", () => {
  it("names every available file in the text error", async () => {
    const { failure } = await run(["references/nope.md"]);
    expect(failure?.errCode).toBe("ATLCLI_ERR_USAGE");
    expect(failure?.message).toBe(
      `Unknown skill file: references/nope.md\nAvailable files:\n${ALL_PATHS.map((path) => `  ${path}`).join("\n")}`,
    );
  });

  it("puts the available files into the JSON error details", async () => {
    const { failure } = await run(["references/nope.md"], {}, true);
    expect(failure?.details).toEqual({ path: "references/nope.md", available: ALL_PATHS });
  });

  it("keeps the JSON error message to one line", async () => {
    const { failure } = await run(["references/nope.md"], {}, true);
    expect(failure?.message).toBe("Unknown skill file: references/nope.md");
  });
});

describe("atlcli skill: usage errors", () => {
  async function usageError(args: string[], flags: Record<string, string | boolean | string[]>): Promise<string> {
    const { failure, stdout } = await run(args, flags);
    expect(stdout).toBe("");
    expect(failure?.errCode).toBe("ATLCLI_ERR_USAGE");
    expect(failure?.exitCode).toBe(1);
    return failure!.message;
  }

  it("rejects more than one path", async () => {
    expect(await usageError(["SKILL.md", "references/safety.md"], {})).toBe("atlcli skill takes at most one path");
  });

  it("rejects --install without a directory", async () => {
    expect(await usageError([], { install: true })).toBe("--install needs a skills directory, such as .claude/skills");
  });

  it("rejects --install with an empty directory", async () => {
    expect(await usageError([], { install: "" })).toBe("--install needs a skills directory, such as .claude/skills");
  });

  it("rejects a repeated --install", async () => {
    expect(await usageError([], { install: ["a", "b"] })).toBe("--install takes one directory");
  });

  it("rejects --list with a value", async () => {
    expect(await usageError([], { list: "references/safety.md" })).toBe("--list takes no value");
  });

  it("rejects a repeated --list with values", async () => {
    expect(await usageError([], { list: ["a", "b"] })).toBe("--list takes no value");
  });

  it("rejects a path together with --list", async () => {
    expect(await usageError(["SKILL.md"], { list: true })).toBe("Use only one of <path>, --list and --install");
  });

  it("rejects --list together with --install", async () => {
    expect(await usageError([], { list: true, install: "skills" })).toBe(
      "Use only one of <path>, --list and --install",
    );
  });
});

describe("atlcli skill: help", () => {
  it("prints the help for --help", async () => {
    const { outputs, stdout } = await run([], { help: true });
    expect(outputs).toEqual([skillHelp()]);
    expect(stdout).toBe("");
  });

  it("prints the help for -h", async () => {
    expect((await run([], { h: true })).outputs).toEqual([skillHelp()]);
  });

  it("prints the help instead of a file named alongside --help", async () => {
    const { outputs, stdout } = await run(["references/safety.md"], { help: true });
    expect(outputs).toEqual([skillHelp()]);
    expect(stdout).toBe("");
  });

  it("documents the command", () => {
    expect(skillHelp()).toContain("atlcli skill [<path>] [--list] [--install <skills-root>]");
  });
});

describe("atlcli skill --install", () => {
  it("writes every file of the skill with its embedded content", async () => {
    const root = tempDir();
    await run([], { install: root });
    for (const file of SKILL_FILES) {
      expect(readFileSync(join(root, "atlcli", file.path), "utf8")).toBe(file.content);
    }
  });

  it("reports the installed directory and file count", async () => {
    const root = tempDir();
    const { outputs } = await run([], { install: root });
    expect(outputs).toEqual([`Installed the atlcli skill into ${join(root, "atlcli")} (${SKILL_FILES.length} files).`]);
  });

  it("reports the installation as JSON", async () => {
    const root = tempDir();
    const { outputs } = await run([], { install: root }, true);
    expect(outputs).toEqual([{ directory: join(root, "atlcli"), files: ALL_PATHS, extra: [] }]);
  });

  it("overwrites an older copy of a skill file", async () => {
    const root = tempDir();
    mkdirSync(join(root, "atlcli"), { recursive: true });
    writeFileSync(join(root, "atlcli", "SKILL.md"), "an older skill\n");
    await run([], { install: root });
    expect(readFileSync(join(root, "atlcli", "SKILL.md"), "utf8")).toBe(SKILL_MD);
  });

  it("keeps and reports files that are not part of the skill", async () => {
    const root = tempDir();
    mkdirSync(join(root, "atlcli", "references"), { recursive: true });
    writeFileSync(join(root, "atlcli", "notes.md"), "mine\n");
    writeFileSync(join(root, "atlcli", "references", "removed.md"), "from an older version\n");
    const { outputs } = await run([], { install: root });
    expect(readFileSync(join(root, "atlcli", "notes.md"), "utf8")).toBe("mine\n");
    expect(outputs).toEqual([
      `Installed the atlcli skill into ${join(root, "atlcli")} (${SKILL_FILES.length} files).\n` +
        "Left in place, not part of this skill:\n  notes.md\n  references/removed.md",
    ]);
  });

  it("does not report an existing file that the filesystem treats as SKILL.md", async () => {
    const root = tempDir();
    mkdirSync(join(root, "atlcli"), { recursive: true });
    writeFileSync(join(root, "atlcli", "skill.md"), "an older skill\n");
    const { outputs } = await run([], { install: root }, true);
    // On a case-insensitive filesystem `skill.md` is SKILL.md and was just
    // overwritten; on a case-sensitive one it is a separate file.
    const sameFile =
      lstatSync(join(root, "atlcli", "skill.md")).ino === lstatSync(join(root, "atlcli", "SKILL.md")).ino;
    expect((outputs[0] as { extra: string[] }).extra).toEqual(sameFile ? [] : ["skill.md"]);
  });

  it("refuses a symbolic link in place of the skill directory", async () => {
    const root = tempDir();
    const checkout = tempDir();
    writeFileSync(join(checkout, "SKILL.md"), "the checkout\n");
    symlinkSync(checkout, join(root, "atlcli"));
    const { failure } = await run([], { install: root });
    expect(failure?.errCode).toBe("ATLCLI_ERR_IO");
    expect(failure?.message).toContain(join(root, "atlcli"));
    expect(readdirSync(checkout)).toEqual(["SKILL.md"]);
    expect(readFileSync(join(checkout, "SKILL.md"), "utf8")).toBe("the checkout\n");
  });

  it("refuses a symbolic link in place of references/ and writes nothing", async () => {
    const root = tempDir();
    const checkout = tempDir();
    mkdirSync(join(root, "atlcli"));
    symlinkSync(checkout, join(root, "atlcli", "references"));
    const { failure } = await run([], { install: root });
    expect(failure?.errCode).toBe("ATLCLI_ERR_IO");
    expect(failure?.message).toContain(join(root, "atlcli", "references"));
    expect(readdirSync(checkout)).toEqual([]);
    expect(existsSync(join(root, "atlcli", "SKILL.md"))).toBe(false);
  });

  it("refuses a symbolic link in place of SKILL.md", async () => {
    const root = tempDir();
    const checkout = tempDir();
    writeFileSync(join(checkout, "SKILL.md"), "the checkout\n");
    mkdirSync(join(root, "atlcli"));
    symlinkSync(join(checkout, "SKILL.md"), join(root, "atlcli", "SKILL.md"));
    const { failure } = await run([], { install: root });
    expect(failure?.errCode).toBe("ATLCLI_ERR_IO");
    expect(failure?.message).toContain(join(root, "atlcli", "SKILL.md"));
    expect(readFileSync(join(checkout, "SKILL.md"), "utf8")).toBe("the checkout\n");
  });

  it("refuses a file in place of the skill directory", async () => {
    const root = tempDir();
    writeFileSync(join(root, "atlcli"), "a file\n");
    const { failure } = await run([], { install: root });
    expect(failure?.errCode).toBe("ATLCLI_ERR_IO");
    expect(failure?.message).toBe(`${join(root, "atlcli")} is not a directory`);
  });

  it.skipIf(!canTestPermissions)("names the skill directory when it cannot be created", async () => {
    const root = tempDir();
    chmodSync(root, 0o500);
    try {
      const { failure } = await run([], { install: root });
      expect(failure?.errCode).toBe("ATLCLI_ERR_IO");
      expect(failure?.message).toStartWith(`Cannot create ${join(root, "atlcli")}:`);
    } finally {
      chmodSync(root, 0o700);
    }
  });

  it.skipIf(!canTestPermissions)("names the file it failed to write and keeps what it wrote", async () => {
    const root = tempDir();
    const references = join(root, "atlcli", "references");
    mkdirSync(references, { recursive: true });
    chmodSync(references, 0o500);
    try {
      const { failure } = await run([], { install: root });
      expect(failure?.errCode).toBe("ATLCLI_ERR_IO");
      // The first reference file in write order fails.
      expect(failure?.message).toStartWith(`Cannot write ${references}`);
      expect(failure?.message).toMatch(/\/references\/[a-z-]+\.md: /);
      expect(readFileSync(join(root, "atlcli", "SKILL.md"), "utf8")).toBe(SKILL_MD);
      expect(readdirSync(references)).toEqual([]);
    } finally {
      chmodSync(references, 0o700);
    }
  });
});
