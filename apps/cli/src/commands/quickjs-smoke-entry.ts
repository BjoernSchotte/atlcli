/**
 * Standalone smoke entry for the QuickJS runtime the CLI embeds. Jinja
 * templates and scripts both run in QuickJS; a source run, a Bun bundle and a
 * compiled executable, each launched from a foreign working directory, must
 * print the same line, which proves the WASM travels inside the build.
 */
import { initJinja, renderJinja } from "@atlcli/jinja";
import { runScript } from "@atlcli/script-runtime";
import "../quickjs-wasm.js";

await initJinja();
const { text } = renderJinja("{{ a }}+{{ b }}", { a: 1, b: 2 });
const script = await runScript("export default () => 6 * 7;");
process.stdout.write(`QUICKJS_OK ${text} ${JSON.stringify(script.value)}\n`);
