#!/usr/bin/env bun
/**
 * PTY acceptance probe for a synthetic mounted Markdown directory.
 *
 *   bun scripts/bench/glow-probe.ts <glow-binary> <directory> <marker> [expected-documents]
 *
 * Starts Glow in a pseudo-terminal, waits until it lists `_index.md` (and, with
 * an expected count, until it reports that many documents), selects the entry
 * and waits for `marker` in the rendered view. Prints
 * `{ listingMs, renderMs[, scanMs, documents] }` as JSON.
 */
const [binary, directory, marker, expectedArg] = process.argv.slice(2);
if (!binary || !directory || !marker) {
  console.error("usage: glow-probe.ts <glow-binary> <directory> <marker> [expected-documents]");
  process.exit(2);
}
const expectedCount = expectedArg === undefined ? null : Number(expectedArg);

const started = performance.now();
const deadline = started + (expectedCount ? 60_000 : 15_000);
const encoder = new TextEncoder();
const decoder = new TextDecoder("latin1");
let output = "";
let listed: number | null = null;
let selected: number | null = null;
let scanned: number | null = null;
let rendered: number | null = null;
const counts = new Set<number>();
let width = 120;
let nextResize = started + 500;
let wake: () => void = () => {};

const child = Bun.spawn([binary, "-t", "-s", "dark", directory], {
  env: { ...process.env, TERM: "xterm-256color" },
  terminal: {
    cols: width,
    rows: 30,
    data(terminal, bytes) {
      const chunk = decoder.decode(bytes);
      // Answer the terminal queries Glow's renderer waits on.
      if (chunk.includes("\x1b[6n")) terminal.write(encoder.encode("\x1b[1;1R"));
      if (chunk.includes("\x1b]11;?")) terminal.write(encoder.encode("\x1b]11;rgb:0000/0000/0000\x1b\\"));
      output = (output + chunk).slice(-65_536);
      const plain = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "");
      for (const match of plain.matchAll(/(\d[\d,]*) documents/gu)) counts.add(Number(match[1]!.replaceAll(",", "")));
      if (listed === null && plain.includes("_index.md")) listed = performance.now();
      if (listed !== null && selected === null) {
        const complete = expectedCount === null || new RegExp(`\\b${expectedCount} documents\\b`, "u").test(plain);
        if (complete) {
          scanned = performance.now();
          output = "";
          selected = performance.now();
          terminal.write(encoder.encode("\r"));
        }
      } else if (selected !== null && plain.includes(marker)) {
        rendered = performance.now();
      }
      wake();
    },
  },
});

try {
  while (performance.now() < deadline && rendered === null && child.exitCode === null) {
    // TUI renderers can update only changed digits. A resize requests a full
    // frame, so a byte-stream probe need not emulate a terminal.
    if (expectedCount && selected === null && performance.now() >= nextResize) {
      width = width === 120 ? 119 : 120;
      child.terminal!.resize(width, 30);
      nextResize = performance.now() + 500;
    }
    await new Promise<void>((resolve) => {
      wake = resolve;
      setTimeout(resolve, 100);
    });
  }
  if (listed === null) throw new Error("Glow did not list _index.md before deadline");
  if (selected === null) {
    throw new Error(`Glow expected ${expectedCount} documents; largest observed counts: ${[...counts].sort((a, b) => a - b).slice(-5)}`);
  }
  if (rendered === null) throw new Error("Glow did not render the selected fixture before deadline");
  console.log(JSON.stringify({
    listingMs: listed - started,
    renderMs: rendered - selected,
    ...(expectedCount !== null ? { scanMs: scanned! - started, documents: expectedCount } : {}),
  }));
} finally {
  // Only the child started above is signalled; always reap it before exiting.
  child.kill("SIGTERM");
  const reaped = await Promise.race([child.exited.then(() => true), Bun.sleep(2_000).then(() => false)]);
  if (!reaped) {
    child.kill("SIGKILL");
    await child.exited;
  }
  child.terminal?.close();
}

export {};
