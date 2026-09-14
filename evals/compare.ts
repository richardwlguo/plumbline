/**
 * Plumbline — compare.ts
 * Merges result files into the side-by-side readout.
 *
 *   npx tsx evals/compare.ts baseline-claude-sonnet-5 mcp-claude-sonnet-5
 *
 * Costs nothing — it only reads files you already have.
 */
import * as fs from "fs";

const names = process.argv.slice(2);
if (names.length < 2) {
  console.error("usage: npx tsx evals/compare.ts <baseline-file> <mcp-file> [more...]");
  console.error("  (names without the .json, as they appear in results/)");
  process.exit(1);
}

const runs = names.map(n => {
  const path = `results/${n.replace(/\.json$/, "")}.json`;
  if (!fs.existsSync(path)) { console.error(`missing: ${path}`); process.exit(1); }
  return { name: n, ...JSON.parse(fs.readFileSync(path, "utf8")) };
});

const CATS = ["control", "definition", "fiscal", "multi-hop", "ambiguous", "hygiene"];
const LABEL: Record<string, string> = {
  control: "controls", definition: "definition traps", fiscal: "fiscal traps",
  "multi-hop": "multi-hop", ambiguous: "ambiguous (must ask)", hygiene: "hygiene",
};

const col = (s: string, w = 14) => String(s).padStart(w);
const row = (label: string, vals: string[]) => console.log(label.padEnd(24) + vals.map(v => col(v)).join(""));
const cat = (r: any, c: string) => {
  const g = r.results.filter((x: any) => x.category === c);
  return g.length ? `${g.filter((x: any) => x.correct).length}/${g.length}` : "-";
};
const pct = (r: any) => `${(r.accuracy * 100).toFixed(1)}%`;

console.log("\n" + "=".repeat(24 + 14 * runs.length));
console.log("PLUMBLINE — RevOps benchmark, Parcelwise dataset (31 questions)");
console.log("=".repeat(24 + 14 * runs.length));

row("", runs.map(r => r.condition.toUpperCase()));
row("model", runs.map(r => r.model.replace("claude-", "")));
console.log("-".repeat(24 + 14 * runs.length));
row("ACCURACY", runs.map(r => `${r.correct}/${r.total}`));
row("", runs.map(pct));
console.log("-".repeat(24 + 14 * runs.length));
for (const c of CATS) row("  " + LABEL[c], runs.map(r => cat(r, c)));
console.log("-".repeat(24 + 14 * runs.length));
row("tokens / question", runs.map(r => Math.round(r.avgTokens).toLocaleString()));
row("sql queries / question", runs.map(r =>
  (r.results.reduce((s: number, x: any) => s + x.sqlQueries.length, 0) / r.total).toFixed(1)));
row("cost / question", runs.map(r => `$${r.avgCost.toFixed(4)}`));
row("total run cost", runs.map(r => `$${r.totalCost.toFixed(2)}`));
console.log("=".repeat(24 + 14 * runs.length));

// deltas against the first run
if (runs.length >= 2) {
  const [b, m] = runs;
  const d = (a: number, z: number) => `${z > a ? "+" : ""}${(((z - a) / a) * 100).toFixed(0)}%`;
  console.log(`\naccuracy   ${pct(b)} -> ${pct(m)}   (${d(b.accuracy, m.accuracy)})`);
  console.log(`context    ${Math.round(b.avgTokens).toLocaleString()} -> ` +
    `${Math.round(m.avgTokens).toLocaleString()} tokens/question   (${d(b.avgTokens, m.avgTokens)})`);
  console.log(`cost       $${b.avgCost.toFixed(4)} -> $${m.avgCost.toFixed(4)} per question   ` +
    `(${d(b.avgCost, m.avgCost)})`);

  // per-question movement
  const fixed: string[] = [], broke: string[] = [];
  for (const bq of b.results) {
    const mq = m.results.find((x: any) => x.id === bq.id);
    if (!mq) continue;
    if (!bq.correct && mq.correct) fixed.push(bq.id);
    if (bq.correct && !mq.correct) broke.push(bq.id);
  }
  console.log(`\nfixed by the governed layer (${fixed.length}): ${fixed.join(", ") || "none"}`);
  if (broke.length) console.log(`regressed (${broke.length}): ${broke.join(", ")}`);

  const stillWrong = m.results.filter((x: any) => !x.correct);
  if (stillWrong.length) {
    console.log(`\nstill failing (${stillWrong.length}):`);
    for (const q of stillWrong)
      console.log(`  ${q.id}  ${q.note || "no answer"}  —  ${q.trap ?? "no trap"}`);
  }
}
console.log("");
