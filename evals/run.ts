/**
 * Plumbline — run.ts
 * Gives Claude the 31 questions and grades the answers.
 *
 *   npx tsx evals/run.ts --condition baseline --model claude-sonnet-5
 *
 * BASELINE  = raw schema in the prompt + a run_sql tool. What most teams ship.
 * MCP       = scoped tools built from the glossary. Added in step 6.
 *
 * Tracks accuracy, tokens and cost. Writes results/<condition>-<model>.json
 */

import Anthropic from "@anthropic-ai/sdk";
import { Client } from "pg";
import * as dotenv from "dotenv";
import * as fs from "fs";
import { QUESTIONS, Question } from "./questions";
dotenv.config({ path: ".env.local" });

// ------------------------------------------------------------------ config
const args = process.argv.slice(2);
const arg = (k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const CONDITION = arg("condition", "baseline");
const MODEL = arg("model", "claude-sonnet-5");
const ONLY = arg("only", "");          // e.g. --only D1  to debug one question
const MAX_TURNS = 14;

// $ per million tokens. Verified from Anthropic's pricing page, Sept 2026.
const PRICES: Record<string, { in: number; out: number }> = {
  "claude-opus-5": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
};

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ------------------------------------------------------------------- db
const db = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("127.0.0.1") ? undefined : { rejectUnauthorized: false },
});

/**
 * Builds the schema dump the baseline sees: every table, every column, every
 * field label. This is what "pointing Claude at the database" actually means,
 * and it is where the context cost comes from.
 */
async function schemaDump(): Promise<string> {
  const r = await db.query(`
    select c.table_name, c.column_name, c.data_type,
           col_description(('public.' || c.table_name)::regclass, c.ordinal_position) as label
    from information_schema.columns c
    where c.table_schema = 'public'
    order by c.table_name, c.ordinal_position`);
  const tables: Record<string, string[]> = {};
  for (const row of r.rows) {
    (tables[row.table_name] ||= []).push(
      `  ${row.column_name} ${row.data_type}${row.label ? `   -- label: "${row.label}"` : ""}`);
  }
  return Object.entries(tables)
    .map(([t, cols]) => `TABLE ${t} (\n${cols.join("\n")}\n)`)
    .join("\n\n");
}

// --------------------------------------------------------------- prompts
const BASELINE_SYSTEM = (schema: string) => `You are a RevOps analyst at Parcelwise, a B2B logistics SaaS company. You answer business questions by querying the company's Salesforce-synced Postgres database.

Today's date is 2026-09-11.

Here is the complete database schema:

${schema}

Use the run_sql tool to query the database. You may run as many queries as you need.
When you have an answer, call submit_answer. Always call submit_answer exactly once at the end.`;

// Tools available in the baseline condition.
const RUN_SQL_TOOL: Anthropic.Tool = {
  name: "run_sql",
  description: "Run a read-only SQL query against the Postgres database. Returns up to 50 rows.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string", description: "A single SELECT statement." } },
    required: ["query"],
  },
};

const SUBMIT_TOOL: Anthropic.Tool = {
  name: "submit_answer",
  description: "Submit your final answer. Call this exactly once, at the end.",
  input_schema: {
    type: "object",
    properties: {
      value: {
        type: "number",
        description: "The numeric answer. Omit if you are asking a clarifying question instead.",
      },
      assumptions: {
        type: "array", items: { type: "string" },
        description: "Every definition or assumption this answer depends on.",
      },
      needs_clarification: {
        type: "boolean",
        description: "True if the question is genuinely ambiguous and cannot be answered as asked.",
      },
      clarifying_question: {
        type: "string",
        description: "The question you need answered first. Required if needs_clarification is true.",
      },
    },
    required: ["assumptions", "needs_clarification"],
  },
};

// ------------------------------------------------------------ sql executor
async function runSql(query: string): Promise<string> {
  const q = query.trim().replace(/;+\s*$/, "");
  if (/\b(insert|update|delete|drop|alter|create|truncate|grant)\b/i.test(q))
    return "ERROR: only SELECT statements are allowed.";
  try {
    await db.query("begin transaction read only");
    const r = await db.query(q);
    await db.query("rollback");
    if (r.rows.length === 0) return "(0 rows)";
    const rows = r.rows.slice(0, 50);
    return JSON.stringify(rows) + (r.rows.length > 50 ? `\n(+${r.rows.length - 50} more rows)` : "");
  } catch (e: any) {
    await db.query("rollback").catch(() => {});
    return `ERROR: ${e.message}`;
  }
}

// ---------------------------------------------------------------- grading
type Result = {
  id: string; category: string; trap: string | null;
  correct: boolean; expected: number | string; got: any;
  askedClarification: boolean; assumptions: string[];
  inputTokens: number; outputTokens: number; cost: number; turns: number;
  sqlQueries: string[]; note: string;
};

function grade(q: Question, key: any, answer: any): { correct: boolean; note: string } {
  if (!answer) return { correct: false, note: "no answer submitted" };

  if (q.type === "clarify") {
    return answer.needs_clarification === true
      ? { correct: true, note: "asked, as required" }
      : { correct: false, note: `answered ${answer.value} instead of asking` };
  }
  if (answer.needs_clarification === true)
    return { correct: false, note: "asked for clarification on an answerable question" };
  if (typeof answer.value !== "number")
    return { correct: false, note: "no numeric value" };

  const exp = key.expected as number;
  const tol = key.tolerance ?? 0;
  const ok = tol > 0
    ? Math.abs(answer.value - exp) <= Math.abs(exp) * tol
    : Math.round(answer.value) === Math.round(exp);
  const off = exp === 0 ? 0 : ((answer.value - exp) / exp) * 100;
  return { correct: ok, note: ok ? "" : `off by ${off > 0 ? "+" : ""}${off.toFixed(1)}%` };
}

// -------------------------------------------------------------- one question
async function ask(q: Question, system: string, tools: Anthropic.Tool[]): Promise<{
  answer: any; inTok: number; outTok: number; turns: number; sql: string[];
}> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: q.question }];
  let inTok = 0, outTok = 0, turns = 0;
  const sql: string[] = [];

  for (let t = 0; t < MAX_TURNS; t++) {
    turns++;
    const res = await anthropic.messages.create({
      model: MODEL, max_tokens: 2000, system, tools, messages,
    });
    inTok += res.usage.input_tokens;
    outTok += res.usage.output_tokens;
    messages.push({ role: "assistant", content: res.content });

    const calls = res.content.filter(c => c.type === "tool_use") as Anthropic.ToolUseBlock[];
    if (calls.length === 0) break;

    const results: Anthropic.ToolResultBlockParam[] = [];
    let done = false;
    let answer: any = null;

    for (const call of calls) {
      if (call.name === "submit_answer") {
        answer = call.input; done = true;
        results.push({ type: "tool_result", tool_use_id: call.id, content: "recorded" });
      } else if (call.name === "run_sql") {
        const query = (call.input as any).query;
        sql.push(query);
        results.push({ type: "tool_result", tool_use_id: call.id, content: await runSql(query) });
      } else {
        // MCP tools (step 6) are dispatched here.
        const { callMcpTool } = await import("./mcp-client");
        results.push({
          type: "tool_result", tool_use_id: call.id,
          content: await callMcpTool(call.name, call.input),
        });
      }
    }
    if (done) return { answer, inTok, outTok, turns, sql };
    messages.push({ role: "user", content: results });
  }
  return { answer: null, inTok, outTok, turns, sql };
}

// -------------------------------------------------------------------- main
async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY missing from .env.local"); process.exit(1);
  }
  await db.connect();
  const key = JSON.parse(fs.readFileSync("evals/answer-key.json", "utf8"));

  let system: string, tools: Anthropic.Tool[];
  if (CONDITION === "baseline") {
    const schema = await schemaDump();
    system = BASELINE_SYSTEM(schema);
    tools = [RUN_SQL_TOOL, SUBMIT_TOOL];
    console.log(`Schema dump: ${schema.length} characters (~${Math.round(schema.length / 3.7)} tokens)`);
  } else {
    const { buildMcpCondition } = await import("./mcp-client");
    ({ system, tools } = await buildMcpCondition());
    tools = [...tools, SUBMIT_TOOL];
  }

  const price = PRICES[MODEL];
  if (!price) { console.error(`No price on file for ${MODEL}`); process.exit(1); }

  const list = ONLY ? QUESTIONS.filter(q => q.id === ONLY) : QUESTIONS;
  const results: Result[] = [];

  console.log(`\ncondition=${CONDITION}  model=${MODEL}  questions=${list.length}\n`);
  console.log("id    ok   answer            expected          note");
  console.log("-".repeat(86));

  for (const q of list) {
    let r;
    try {
      r = await ask(q, system, tools);
    } catch (e: any) {
      console.log(`${q.id.padEnd(5)} ERR  ${e.message.slice(0, 60)}`);
      continue;
    }
    const { correct, note } = grade(q, key[q.id], r.answer);
    const cost = (r.inTok / 1e6) * price.in + (r.outTok / 1e6) * price.out;

    const fmt = (v: any) =>
      typeof v === "number" ? Math.round(v).toLocaleString() : String(v ?? "-");
    const got = r.answer?.needs_clarification ? "ASKED" : fmt(r.answer?.value);

    results.push({
      id: q.id, category: q.category, trap: q.trap, correct,
      expected: key[q.id].expected, got: r.answer?.value ?? null,
      askedClarification: !!r.answer?.needs_clarification,
      assumptions: r.answer?.assumptions ?? [],
      inputTokens: r.inTok, outputTokens: r.outTok, cost, turns: r.turns,
      sqlQueries: r.sql, note,
    });

    console.log(
      `${q.id.padEnd(5)} ${correct ? " ✓ " : " ✗ "}  ${got.padStart(16)}  ` +
      `${fmt(key[q.id].expected).padStart(16)}  ${note}`);
  }

  // ---- summary
  const n = results.length;
  const hit = results.filter(r => r.correct).length;
  const tot = (f: (r: Result) => number) => results.reduce((s, r) => s + f(r), 0);
  const byCat = (c: string) => {
    const g = results.filter(r => r.category === c);
    return g.length ? `${g.filter(r => r.correct).length}/${g.length}` : "-";
  };

  console.log("\n" + "=".repeat(86));
  console.log(`ACCURACY            ${hit}/${n}  (${((hit / n) * 100).toFixed(1)}%)`);
  console.log(`  controls          ${byCat("control")}`);
  console.log(`  definition traps  ${byCat("definition")}`);
  console.log(`  fiscal traps      ${byCat("fiscal")}`);
  console.log(`  multi-hop         ${byCat("multi-hop")}`);
  console.log(`  ambiguous (ask)   ${byCat("ambiguous")}`);
  console.log(`  hygiene           ${byCat("hygiene")}`);
  console.log(`TOKENS / QUESTION   ${Math.round(tot(r => r.inputTokens + r.outputTokens) / n).toLocaleString()}`);
  console.log(`  input             ${Math.round(tot(r => r.inputTokens) / n).toLocaleString()}`);
  console.log(`  output            ${Math.round(tot(r => r.outputTokens) / n).toLocaleString()}`);
  console.log(`SQL QUERIES / Q     ${(tot(r => r.sqlQueries.length) / n).toFixed(1)}`);
  console.log(`COST / QUESTION     $${(tot(r => r.cost) / n).toFixed(4)}`);
  console.log(`TOTAL RUN COST      $${tot(r => r.cost).toFixed(2)}`);
  console.log("=".repeat(86));

  const missed = results.filter(r => !r.correct && r.trap);
  if (missed.length) {
    console.log("\nTRAPS THAT CAUGHT IT:");
    for (const m of missed) console.log(`  ${m.id}  ${m.trap}`);
  }

  fs.mkdirSync("results", { recursive: true });
  const out = `results/${CONDITION}-${MODEL}.json`;
  fs.writeFileSync(out, JSON.stringify({
    condition: CONDITION, model: MODEL, ranAt: new Date().toISOString(),
    accuracy: hit / n, correct: hit, total: n,
    avgTokens: tot(r => r.inputTokens + r.outputTokens) / n,
    avgCost: tot(r => r.cost) / n, totalCost: tot(r => r.cost),
    results,
  }, null, 2));
  console.log(`\nFull transcript saved to ${out}`);
  await db.end();
}

main().catch(e => { console.error(e); process.exit(1); });
