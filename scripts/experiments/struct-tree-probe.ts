import { readFile } from "node:fs/promises";
import { readDocStructTree, correlateDocStructTree } from "../../packages/import-pdf/src/struct-tree.js";
import { createNodePdfiumFactsAdapterV2 } from "../../packages/import-pdf/src/node.js";
const adapter = await createNodePdfiumFactsAdapterV2();
const label = (path: string) => process.env.PROBE_LABELS === "index" ? `K${process.argv.slice(2).indexOf(path) + 1}` : path.split("/").pop();
for (const path of process.argv.slice(2)) {
 try {
  const bytes = new Uint8Array(await readFile(path));
  const t0 = performance.now();
  const tree = readDocStructTree(bytes);
  const ms = performance.now() - t0;
  const { facts } = await adapter.analyze(bytes);
  const pdfiumUnresolved = facts.pages.reduce((n, p) => { let c = 0; const w = (x: any) => { for (const k of x.kids) { if (k.kind === "unresolved") c++; else if (k.kind === "element") w(k.node); } }; p.structures.forEach(w); return n + c; }, 0);
  if (!tree) { console.log(label(path), "no StructTreeRoot", { pdfiumUnresolved }); continue; }
  const c = correlateDocStructTree(tree, facts.pages);
  const { tables, ...rest } = c;
  console.log(label(path), JSON.stringify({ pages: tree.pageCount, scan: tree.recoveredByScan, ms: Math.round(ms), pdfiumUnresolved, ...rest }));
  for (const t of tables) console.log("   table", JSON.stringify(t));
 } catch (e) { console.log(label(path), "error", (e as Error).name, (e as any).code ?? ""); }
}
