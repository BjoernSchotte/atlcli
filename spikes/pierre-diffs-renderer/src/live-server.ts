import index from "../index.html";
import { resolve } from "node:path";
import { toPierreReviewPayload } from "./review-payload.js";

const pageDiffArgs = Bun.argv.slice(2);
if (pageDiffArgs.length === 0) {
  throw new Error("Pass wiki page diff flags after `bun run live --`. No page data is stored.");
}
for (const forbidden of ["--format", "--json", "--word-diff"]) {
  if (pageDiffArgs.some((argument) => argument === forbidden || argument.startsWith(`${forbidden}=`))) {
    throw new Error(`${forbidden} is owned by the live renderer.`);
  }
}

const repositoryRoot = resolve(import.meta.dir, "../../..");
const cli = Bun.spawn([
  "bun",
  "--conditions=development",
  "run",
  "--cwd",
  "apps/cli",
  "src/index.ts",
  "wiki",
  "page",
  "diff",
  ...pageDiffArgs,
  "--format",
  "review",
  "--json",
  "--no-log",
], {
  cwd: repositoryRoot,
  stdout: "pipe",
  stderr: "pipe",
  env: process.env,
});

const [stdout, stderr, exitCode] = await Promise.all([
  new Response(cli.stdout).text(),
  new Response(cli.stderr).text(),
  cli.exited,
]);
if (exitCode !== 0) {
  throw new Error(`atlcli review failed (${exitCode}): ${stderr.trim() || "no diagnostic"}`);
}

const payload = toPierreReviewPayload(JSON.parse(stdout));

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  routes: {
    "/": index,
    "/api/review": () => Response.json(payload, {
      headers: { "Cache-Control": "no-store" },
    }),
  },
});

console.log(`Pierre live renderer: http://${server.hostname}:${server.port}`);
console.log("Live page data is held in memory only. Press Ctrl-C to stop.");
