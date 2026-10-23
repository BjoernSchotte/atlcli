/**
 * Standalone smoke entry for the embedded agent skill. A source run, a Bun
 * bundle and a compiled executable, each launched from a foreign working
 * directory, must print the same file count and digest as the files under
 * `skills/atlcli/`, which proves the content travels inside the build rather
 * than being read from the repository at run time.
 */
import { createHash } from "node:crypto";
import { SKILL_FILES } from "../skill-files.js";

const digest = createHash("sha256");
for (const file of SKILL_FILES) digest.update(`${file.path}\0${file.content}\0`);
process.stdout.write(`SKILL_OK ${SKILL_FILES.length} ${digest.digest("hex")}\n`);
