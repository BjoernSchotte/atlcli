/**
 * WP0.2 spike: does just-bash 3.4.2 drive an async, remote-backed
 * IFileSystem under Bun, with `defenseInDepth: false`?
 *
 * Run: bun spikes/vfs-just-bash/spike.ts
 */
import { Bash, MountableFs } from "just-bash";
import { FakeRemoteFs } from "./fake-fs.ts";

const fakeFs = new FakeRemoteFs({
  "/_index.md": "# DOCSY\n\nSpace home page.\n",
  "/getting-started-623869001.md":
    "---\natlcli:\n  id: \"623869001\"\n---\n\n# Getting started\n\nInstall with Kubernetes.\n",
  "/architecture-623869955/_index.md":
    "---\natlcli:\n  id: \"623869955\"\n---\n\n# Architecture\n\nRuns on Kubernetes clusters.\n",
  "/architecture-623869955/deployment-623870112.md":
    "---\natlcli:\n  id: \"623870112\"\n---\n\n# Deployment\n\nNo container platform here.\n",
});

function makeBash(): Bash {
  return new Bash({
    defenseInDepth: false,
    cwd: "/DOCSY",
    fs: new MountableFs({
      mounts: [{ mountPoint: "/DOCSY", filesystem: fakeFs }],
    }),
  });
}

interface Case {
  name: string;
  script: string;
  expect: (r: { stdout: string; stderr: string; exitCode: number }) => boolean;
}

const cases: Case[] = [
  { name: "ls", script: "ls", expect: (r) => r.stdout.includes("getting-started-623869001.md") },
  { name: "ls -R", script: "ls -R", expect: (r) => r.stdout.includes("deployment-623870112.md") },
  { name: "ls -la", script: "ls -la", expect: (r) => r.exitCode === 0 && r.stdout.length > 0 },
  {
    name: "cat",
    script: 'cat "getting-started-623869001.md"',
    expect: (r) => r.stdout.includes("# Getting started"),
  },
  {
    name: "grep -rn",
    script: 'grep -rn "Kubernetes" .',
    expect: (r) => r.stdout.includes("architecture-623869955/_index.md"),
  },
  {
    name: "grep -rl",
    script: 'grep -rl "Kubernetes" .',
    expect: (r) => r.stdout.split("\n").filter(Boolean).length === 2,
  },
  {
    name: "find -name",
    script: 'find . -name "*.md" | sort',
    expect: (r) => r.stdout.includes("./architecture-623869955/_index.md"),
  },
  {
    name: "sed",
    script: 'cat "getting-started-623869001.md" | sed "s/Kubernetes/K8s/"',
    expect: (r) => r.stdout.includes("Install with K8s."),
  },
  {
    name: "sed -i",
    script: 'sed -i "s/Getting started/Getting Started/" "getting-started-623869001.md" && grep -c "Getting Started" "getting-started-623869001.md"',
    expect: (r) => r.stdout.trim() === "1",
  },
  {
    name: "awk",
    script: 'awk "NR==1" "_index.md"',
    expect: (r) => r.stdout.trim() === "# DOCSY",
  },
  {
    name: "jq",
    script: `echo '{"id":"623869955"}' | jq -r .id`,
    expect: (r) => r.stdout.trim() === "623869955",
  },
  {
    name: "echo > file",
    script: 'echo "# New page" > new-page.md && cat new-page.md',
    expect: (r) => r.stdout.includes("# New page"),
  },
  {
    name: "glob",
    script: "ls *.md | wc -l",
    expect: (r) => Number(r.stdout.trim()) >= 2,
  },
  {
    name: "tree",
    script: "tree",
    expect: (r) => r.exitCode === 0 && r.stdout.includes("architecture-623869955"),
  },
  {
    name: "pipeline head",
    script: 'grep -rl "Kubernetes" . | head -1',
    expect: (r) => r.stdout.trim().length > 0,
  },
];

const results: { name: string; ok: boolean; note: string }[] = [];

for (const testCase of cases) {
  const bash = makeBash();
  const before = fakeFs.calls.length;
  try {
    const result = await bash.exec(testCase.script);
    const ok = testCase.expect(result);
    results.push({
      name: testCase.name,
      ok,
      note: ok
        ? `${fakeFs.calls.length - before} backend calls`
        : `exit=${result.exitCode} stdout=${JSON.stringify(result.stdout.slice(0, 120))} stderr=${JSON.stringify(result.stderr.slice(0, 160))}`,
    });
  } catch (error) {
    results.push({ name: testCase.name, ok: false, note: `threw: ${String(error).slice(0, 200)}` });
  }
}

const methods = new Map<string, number>();
for (const call of fakeFs.calls) methods.set(call.method, (methods.get(call.method) ?? 0) + 1);

console.log(`Bun ${Bun.version}, just-bash 3.4.2, defenseInDepth: false\n`);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(16)} ${r.note}`);
}
console.log("\nBackend methods just-bash actually called:");
for (const [method, count] of [...methods].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${method.padEnd(24)} ${count}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
