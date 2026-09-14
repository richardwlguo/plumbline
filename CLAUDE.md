# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

Plumbline benchmarks whether wrapping a messy CRM database in a small set of
governed MCP tools (built from a business glossary) produces more accurate
answers from an LLM than giving it raw SQL access and a schema dump. It seeds
a deliberately trap-laden Salesforce-shaped Postgres database (Parcelwise, a
fictional B2B logistics company), asks the same 31 business questions against
two conditions — **baseline** (raw `run_sql` + schema) and **MCP** (12 scoped
tools) — and grades the answers against a ground-truth key.

Read `GLOSSARY.md` before touching `mcp/server.ts` or `db/schema.sql` — it is
the single source of truth for every business definition (customer, ARR,
churn, segment, etc.) and *why* certain fields are wrong to use. Read
`FRICTION.md` for the honest limitations of the current approach (as-of date
handling, no permissions, no definition versioning, the one known regression).

## Commands

No test runner is wired into `package.json` (`npm test` is a stub). Everything
runs via `tsx` directly:

```bash
# One-time / after changing db/schema.sql or db/seed.ts
npx tsx db/seed.ts              # rebuilds the Parcelwise database (deterministic RNG, same seed => same data)
npx tsx evals/verify.ts         # runs ground-truth SQL for all questions, writes evals/answer-key.json

# Run the benchmark
npx tsx evals/run.ts --condition baseline --model claude-sonnet-5
npx tsx evals/run.ts --condition mcp --model claude-sonnet-5
npx tsx evals/run.ts --condition mcp --model claude-sonnet-5 --only D5   # debug a single question by id

# Compare two saved runs (reads results/*.json, no API calls)
npx tsx evals/compare.ts baseline-claude-sonnet-5 mcp-claude-sonnet-5

# Sanity-check the MCP tool dispatch logic directly against the DB (no LLM involved)
npx tsx mcp/test-tools.ts

# Run the MCP server standalone (e.g. to point Claude Desktop at it)
npx tsx mcp/server.ts
```

Requires `.env.local` with `DATABASE_URL` (Postgres) and `ANTHROPIC_API_KEY`.
`REPORT_DATE` (e.g. `REPORT_DATE=2026-10-01`) overrides the MCP server's
as-of date for a different reporting day — see the note on `AS_OF` below.

There is no lint/build/typecheck script configured; TypeScript files are run
directly by `tsx` (no compiled output, no `tsconfig.json`).

## Architecture

**Two independent codepaths answer the same 31 questions, sharing only the
Postgres database and the answer key:**

- **Baseline condition** (`evals/run.ts`): dumps the full information_schema
  (including SFDC-style field labels) into the system prompt and gives the
  model a generic `run_sql` tool. This is "point an LLM at your warehouse."
- **MCP condition** (`mcp/server.ts` + `evals/mcp-client.ts`): the model only
  sees 12 domain tools (`count_customers`, `get_arr`, `get_churn`, etc.). Each
  tool's SQL hard-codes one glossary definition, so the model cannot reach a
  legacy/trap field because no tool exposes it. `evals/mcp-client.ts` spawns
  `mcp/server.ts` as a real child process over stdio and discovers tools at
  runtime via the MCP protocol (not hardcoded), so the same server also works
  unmodified in Claude Desktop.

Both conditions go through the same harness loop in `evals/run.ts::ask()`
(shared grading, token/cost accounting, turn limit of 14, and a shared "nudge
to call submit_answer" fallback for models that answer in prose) — this is
what makes the two conditions comparable.

**`mcp/server.ts` — the three rules that encode the fix, each mapped to a
baseline failure mode:**
1. No `run_sql`-equivalent tool exists — a caller structurally cannot reach a
   legacy/frozen field (e.g. `accounts.total_arr__c`).
2. Every tool return value carries `definition_used` and `assumptions` — a
   stated definition is a property of the response, not something the model
   has to remember to say.
3. Genuinely ambiguous parameters (`get_churn`'s `basis`, `get_segment_breakdown`'s
   `metric`, `get_won_deal_totals`'s `basis`) have **no default** and throw if
   omitted, forcing the model to ask the user rather than guess.

Shared SQL fragments (`CLEAN`, `ACTIVE`, `USD`, `WON`, `OPEN` — CTEs for
"exclude test/deleted accounts," "contract in force today," "converted to
USD," "won opportunities," "open opportunities") are defined once at the top
of `mcp/server.ts` and composed via the `W(...)` helper into every tool's
query, so a glossary rule lives in exactly one place. `resolvePeriod()` is the
one function that understands Parcelwise's fiscal calendar (FY starts Feb 1,
named for the year it ends — FY27 = Feb 2026–Jan 2027).

**`AS_OF` (mcp/server.ts) vs `current_date` (db/seed.ts, evals/questions.ts's
`PRELUDE`, evals/run.ts's baseline prompt):** the MCP server pins reporting
date to a constant (default `2026-09-11`, override via `REPORT_DATE`) so a
contract expiring overnight doesn't silently change results between runs. The
baseline condition and the ground-truth queries in `evals/questions.ts` use
Postgres's `current_date` (i.e. wall-clock today), and the baseline's system
prompt in `evals/run.ts` hardcodes `2026-09-11` as "today" in English but does
not pin it in SQL — this is a known, intentional asymmetry documented in
`FRICTION.md` §1, not a bug to silently reconcile.

**`db/schema.sql` and `db/seed.ts` plant traps on purpose** (legacy fields
frozen since the 2025-03-01 Chargebee→Stripe migration, a pre-FY26 employee-
count segment field left populated alongside the current ARR-band field,
subsidiary accounts that must roll up to their parent, soft-deleted/test
accounts, opportunities using stale `stage_name` strings where only `is_won`
is reliable, "Upsell" as a legacy synonym for "Expansion"). Do not "clean up"
these fields or comments — they are the object under test. If you add a new
trap or tool, it must be reflected consistently in `db/schema.sql` (the trap),
`GLOSSARY.md` (the official definition), `mcp/server.ts` (the enforcing tool),
and `evals/questions.ts` + `evals/verify.ts` (a ground-truth query proving the
tool gets it right).

**`evals/questions.ts` is a frozen exam** — per its own header comment,
nothing in it changes once the first baseline run has happened; editing traps
after seeing results would make the benchmark dishonest. Each question is
tagged with a `category` (control / definition / fiscal / multi-hop /
ambiguous / hygiene) used for the breakdown in `run.ts`'s summary and
`compare.ts`'s side-by-side table, and a `trap` string naming the specific
mistake it's designed to catch (or `null` for a clean control question).
Questions of `type: "clarify"` are graded on whether the model *asks* rather
than guesses; all others are graded numerically against `evals/answer-key.json`
(generated by `evals/verify.ts`, exact match or within `tolerance` if set).

**Results** land in `results/<condition>-<model>.json` (full per-question
transcripts, tokens, cost) and are archived in `results/final/` and
`results/v1-unnudged/` as point-in-time snapshots — don't overwrite those when
re-running the benchmark for new experiments; write to the default `results/`
path and archive separately if you want to preserve a comparison.
