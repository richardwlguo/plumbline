/**
 * Plumbline — verify.ts
 * Runs every ground-truth query and prints the answer key.
 * Also writes evals/answer-key.json, which the grader uses later.
 *
 * Run:  npx tsx evals/verify.ts
 */
import { Client } from "pg";
import * as dotenv from "dotenv";
import * as fs from "fs";
import { QUESTIONS } from "./questions";
dotenv.config({ path: ".env.local" });

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes("127.0.0.1") ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();

  const key: Record<string, any> = {};
  let failures = 0;

  for (const q of QUESTIONS) {
    if (q.type === "clarify") {
      key[q.id] = { expected: "CLARIFY", type: "clarify" };
      console.log(`${q.id.padEnd(4)} ${"MUST ASK".padStart(16)}   ${q.question.slice(0, 62)}`);
      continue;
    }
    try {
      const r = await client.query(q.sql!);
      const raw = Object.values(r.rows[0])[0];
      const val = raw === null ? null : parseFloat(String(raw));
      if (val === null || Number.isNaN(val)) {
        console.log(`${q.id.padEnd(4)} ${"NULL RESULT".padStart(16)}   ${q.question.slice(0, 62)}`);
        failures++;
        continue;
      }
      key[q.id] = { expected: val, type: "number", tolerance: q.tolerance ?? 0 };
      const shown = Math.abs(val) > 10000
        ? Math.round(val).toLocaleString()
        : String(Math.round(val * 100) / 100);
      console.log(`${q.id.padEnd(4)} ${shown.padStart(16)}   ${q.question.slice(0, 62)}`);
    } catch (e: any) {
      console.log(`${q.id.padEnd(4)} ${"SQL ERROR".padStart(16)}   ${e.message.slice(0, 80)}`);
      failures++;
    }
  }

  fs.mkdirSync("evals", { recursive: true });
  fs.writeFileSync("evals/answer-key.json", JSON.stringify(key, null, 2));
  console.log(`\n${Object.keys(key).length}/${QUESTIONS.length} questions have answers.`);
  if (failures) console.log(`${failures} FAILED — fix the SQL before running the benchmark.`);
  else console.log("Answer key written to evals/answer-key.json");
  await client.end();
}
main().catch(e => { console.error(e); process.exit(1); });
