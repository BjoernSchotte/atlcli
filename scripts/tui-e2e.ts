/**
 * Live end-to-end test of `atlcli tui`: starts it in a detached tmux session,
 * drives it with keys and SGR mouse events, and checks the screen.
 *
 *   bun scripts/tui-e2e.ts --profile <name> [--project KEY] [--space KEY] [--write] [--only jira-read,wiki-read]
 *
 * Read scenarios touch nothing. `--write` also creates, edits and deletes
 * test issues in `--project` and a test page in `--space` (use test
 * containers only); everything it creates is deleted again, also on failure.
 * Needs tmux. Not part of `bun run test`: it needs a live site.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "@atlcli/core";

const ROOT = join(import.meta.dir, "..");
const SESSION = `atlcli-tui-e2e-${process.pid}`;

/** An SGR mouse press or wheel event (1-based cell coordinates), as a terminal sends it. */
export function sgrMouse(kind: "click" | "wheel-down" | "wheel-up", x: number, y: number): string {
  if (kind === "click") return `\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`;
  return `\x1b[<${kind === "wheel-up" ? 64 : 65};${x};${y}M`;
}

function tmux(...args: string[]): string {
  const res = Bun.spawnSync(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0 && args[0] !== "kill-session") throw new Error(`tmux ${args[0]}: ${res.stderr.toString().trim()}`);
  return res.stdout.toString();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Screen {
  constructor(private readonly profile: string, private readonly editor: string) {}

  async start(args: string[], size = { width: 160, height: 40 }): Promise<void> {
    tmux("kill-session", "-t", SESSION);
    const quoted = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    const cmd = `cd '${ROOT}' && env EDITOR='${this.editor}' VISUAL= bun --conditions=development apps/cli/src/index.ts tui ${quoted} --profile '${this.profile}'; echo EXITED $?; sleep 30`;
    tmux("new-session", "-d", "-s", SESSION, "-x", String(size.width), "-y", String(size.height), cmd);
  }

  text(): string {
    return tmux("capture-pane", "-p", "-t", SESSION);
  }

  async keys(...keys: string[]): Promise<void> {
    for (const key of keys) {
      tmux("send-keys", "-t", SESSION, key);
      // Separate presses: ESC followed at once by a letter reads as Alt+letter.
      await sleep(key === "Escape" ? 300 : 120);
    }
  }

  async type(text: string): Promise<void> {
    tmux("send-keys", "-t", SESSION, "-l", "--", text);
    await sleep(200);
  }

  async mouse(kind: Parameters<typeof sgrMouse>[0], x: number, y: number): Promise<void> {
    tmux("send-keys", "-t", SESSION, "-l", "--", sgrMouse(kind, x, y));
    await sleep(300);
  }

  resize(width: number, height: number): void {
    tmux("resize-window", "-t", SESSION, "-x", String(width), "-y", String(height));
  }

  /** Waits until the screen matches; throws with the screen when it does not. */
  async waitFor(pattern: RegExp | string, timeoutMs = 15_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const screen = this.text();
      if (typeof pattern === "string" ? screen.includes(pattern) : pattern.test(screen)) return screen;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${pattern}.\n--- screen ---\n${mask(screen)}`);
      await sleep(250);
    }
  }

  /** Finds the 1-based cell of a text on screen. */
  find(text: string): { x: number; y: number } {
    const lines = this.text().split("\n");
    const y = lines.findIndex((l) => l.includes(text));
    if (y < 0) throw new Error(`"${text}" is not on screen.`);
    return { x: lines[y]!.indexOf(text) + 1, y: y + 1 };
  }

  stop(): void {
    tmux("kill-session", "-t", SESSION);
  }
}

const mask = (text: string) => text.replace(/https?:\/\/[a-z0-9.-]+\.atlassian\.net/g, "<site>");

async function cli(profile: string, ...args: string[]): Promise<unknown> {
  const proc = Bun.spawn(["bun", "--conditions=development", "apps/cli/src/index.ts", ...args, "--json", "--profile", profile], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`atlcli ${args.join(" ")}: ${out}`);
  return JSON.parse(out);
}

type Scenario = (s: Screen, o: { profile: string; project: string; space: string; cleanup: Array<() => Promise<unknown>> }) => Promise<void>;

const scenarios: Record<string, Scenario> = {
  async "jira-read"(s, o) {
    await s.start(["--project", o.project]);
    await s.waitFor(/My open issues \(\d+\+?\)/);
    await s.keys("?");
    await s.waitFor("Keys · esc closes");
    await s.keys("Escape");
    await s.keys(":");
    await s.type("sort");
    await s.waitFor("Sort the list");
    await s.keys("Escape");
    await s.keys("h", "j", "j", "j", "Enter");
    await s.waitFor(/▾ Boards/);
    await s.keys("/", "C-u");
    await s.type(`--project ${o.project}`);
    await s.keys("Enter");
    await s.waitFor(`project = ${o.project}`);
    s.resize(90, 30);
    await s.waitFor(/Search \(\d+\+?\)/);
    await s.keys("q");
    await s.waitFor("EXITED 0");
  },

  async "jira-write"(s, o) {
    await s.start(["--project", o.project, "--jql", `project = ${o.project} ORDER BY created DESC`]);
    await s.waitFor(/Search \(\d+\+?\)/);
    await s.keys("n");
    await s.waitFor("New issue: project");
    await s.keys("Enter");
    await s.waitFor(/New .* issue: type/);
    await s.keys("Enter");
    await s.waitFor("summary");
    await s.type("atlcli tui e2e issue");
    await s.keys("Enter");
    await s.waitFor("Create this");
    await s.keys("y");
    const created = /([A-Z][A-Z0-9_]+-\d+) created/.exec(await s.waitFor(/[A-Z][A-Z0-9_]+-\d+ created/))![1]!;
    o.cleanup.push(() => cli(o.profile, "jira", "issue", "delete", created, "--confirm"));
    await s.keys("t");
    await s.waitFor(`Transition ${created}`);
    await s.keys("Down", "Enter");
    await s.waitFor("Transition to");
    await s.keys("y");
    await s.waitFor(`${created} updated`);
    await s.keys("c");
    await s.waitFor(`Comment on ${created}`);
    await s.type("e2e comment with **bold**");
    await s.keys("C-s");
    await s.waitFor("Add this comment");
    await s.keys("y");
    await s.waitFor(`Comment added to ${created}`);
    await s.keys("L");
    await s.type("atlcli-tui-e2e");
    await s.keys("Enter");
    await s.waitFor("Change the labels");
    await s.keys("y");
    await s.waitFor("labels updated");
    const issue = (await cli(o.profile, "jira", "issue", "get", created)) as { issue: { labels: string[] } };
    if (!issue.issue.labels.includes("atlcli-tui-e2e")) throw new Error(`label missing on ${created}`);
    await s.keys("q");
  },

  async "wiki-read"(s, o) {
    await s.start(["--area", "wiki", "--space", o.space]);
    await s.waitFor(`Recently updated (${o.space})`);
    await s.waitFor(new RegExp(`\\(${o.space}\\)[^\\n]*\\n[^\\n]*▸`));
    await s.keys("h", "j", "Enter");
    await s.waitFor(/page\s+info/);
    await s.keys("Tab", ".");
    await s.waitFor("Editable");
    await s.keys("q");
    await s.waitFor("EXITED 0");
  },

  async "wiki-write"(s, o) {
    await s.start(["--area", "wiki", "--space", o.space]);
    // The space is selected and expanded once its root pages are in; j then picks the first one.
    await s.waitFor(new RegExp(`\\(${o.space}\\)[^\\n]*\\n[^\\n]*▸`));
    await s.keys("h", "j", "Enter");
    await s.waitFor(/page\s+info/);
    await s.keys("n");
    await s.waitFor("New page");
    await s.type("atlcli tui e2e page");
    await s.keys("Enter");
    await s.waitFor('Create "atlcli tui e2e page"');
    await s.keys("y");
    await s.waitFor('Created "atlcli tui e2e page"');
    // The search index lags behind a new page: retry, so the cleanup always finds it.
    let id: string | undefined;
    for (let i = 0; i < 40 && !id; i++) {
      const found = (await cli(o.profile, "wiki", "search", "--cql", `space = ${o.space} AND title = "atlcli tui e2e page"`)) as { results: Array<{ id: string }> };
      id = found.results[0]?.id;
      if (!id) await sleep(1500);
    }
    if (!id) throw new Error("The new page never showed up in search; delete it by hand.");
    const pageId = id;
    o.cleanup.push(() => cli(o.profile, "wiki", "page", "delete", "--id", pageId, "--confirm"));
    await s.keys("e");
    await s.waitFor(/Save "atlcli tui e2e page" \(v1 → v2\)/);
    // Someone else saves meanwhile: the TUI must not overwrite.
    const dir = mkdtempSync(join(tmpdir(), "atlcli-tui-e2e-"));
    writeFileSync(join(dir, "remote.md"), "# atlcli tui e2e page\n\nChanged elsewhere.\n");
    await cli(o.profile, "wiki", "page", "update", "--id", id, "--body", join(dir, "remote.md"));
    rmSync(dir, { recursive: true, force: true });
    await s.keys("y");
    await s.waitFor("changed in Confluence (v1 → v2); not saved");
    await s.keys("Escape", "q");
  },
};

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  const one = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);
  const profile = one("profile");
  if (!profile) throw new Error("--profile is required.");
  const write = flags.write === true;
  const names = (one("only")?.split(",") ?? Object.keys(scenarios)).filter((n) => write || !n.endsWith("-write"));
  const dir = mkdtempSync(join(tmpdir(), "atlcli-tui-editor-"));
  const editorScript = join(dir, "editor.sh");
  writeFileSync(editorScript, `printf '\\nEdited by scripts/tui-e2e.ts\\n' >> "$1"\n`);
  const screen = new Screen(profile, `bash ${editorScript}`);
  let failed = 0;
  for (const name of names) {
    const cleanup: Array<() => Promise<unknown>> = [];
    const started = Date.now();
    try {
      await scenarios[name]!(screen, { profile, project: one("project") ?? "ATLCLI", space: one("space") ?? "DOCSY", cleanup });
      console.log(`ok    ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    } catch (err) {
      failed++;
      console.log(`FAIL  ${name}: ${mask(err instanceof Error ? err.message : String(err))}`);
    } finally {
      screen.stop();
      for (const undo of cleanup.reverse()) await undo().catch((err) => console.log(`      cleanup failed: ${err instanceof Error ? err.message : err}`));
    }
  }
  rmSync(dir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

if (import.meta.main) await main();
