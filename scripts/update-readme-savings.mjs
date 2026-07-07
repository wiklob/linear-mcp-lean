// Splice probe-vs-hosted output into README.md between the savings markers.
// Usage: node scripts/update-readme-savings.mjs <probe-output.txt>
// Run BY HAND when the numbers meaningfully change (the weekly workflow only
// measures and alarms — it deliberately commits nothing; see its header).
// The probe's stdout goes in verbatim as a fenced code block — no parsing, so
// a probe format change can never silently corrupt the committed numbers.
import { readFile, writeFile } from "node:fs/promises";

const BEGIN = "<!-- savings:begin -->";
const END = "<!-- savings:end -->";

const [, , outputPath] = process.argv;
if (!outputPath) {
  console.error("usage: node scripts/update-readme-savings.mjs <probe-output.txt>");
  process.exit(2);
}

const table = (await readFile(outputPath, "utf8")).trimEnd();
if (!table) {
  console.error("FAIL: probe output is empty — refusing to blank the README table");
  process.exit(2);
}

const readme = await readFile("README.md", "utf8");
const start = readme.indexOf(BEGIN);
const end = readme.indexOf(END);
if (start === -1 || end === -1 || end < start) {
  console.error(`FAIL: README savings markers not found (${BEGIN} … ${END})`);
  process.exit(2);
}

const stamp = new Date().toISOString().slice(0, 10);
const block = `${BEGIN}
Measured ${stamp} against a live deploy — identical requests to this wrapper and to the hosted Linear MCP, response bytes compared per call (per row for lists). The [probe-vs-hosted workflow](.github/workflows/probe-vs-hosted.yml) re-measures weekly and fails on regression:

\`\`\`text
${table}
\`\`\`
${END}`;

await writeFile("README.md", readme.slice(0, start) + block + readme.slice(end + END.length));
console.log("README savings block updated");
