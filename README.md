# Plumbline

**A RevOps benchmark on deliberately messy CRM data. Claude scored 38.7% with raw
database access and 96.8% behind a scoped MCP server that enforces written
definitions. Same model, same 31 questions, same data.**

Claude Haiku 4.5 on the governed layer also scored 96.8% — matching Sonnet 5 at
one-seventh the cost per question of Sonnet on raw access. The bottleneck was
never model capability.

| | raw access | governed (Sonnet 5) | governed (Haiku 4.5) |
|---|---|---|---|
| **accuracy** | 12/31 · 38.7% | **30/31 · 96.8%** | **30/31 · 96.8%** |
| controls | 4/6 | 6/6 | 6/6 |
| definition traps | 5/11 | 11/11 | 11/11 |
| fiscal-calendar traps | 0/4 | 4/4 | 4/4 |
| multi-hop | 1/4 | 3/4 | 3/4 |
| ambiguous (must ask) | 2/5 | 5/5 | 5/5 |
| tokens / question | 19,535 | 7,466 | 7,011 |
| SQL queries / question | 5.1 | 0 | 0 |
| cost / question | $0.0542 | $0.0179 | $0.0081 |

---

## The failure that motivated this

The simplest question in the set: *how many customers do we have right now?*
The answer is 117.

With raw access, Claude ran six queries. It checked the field labeled "Active."
It cross-tabbed that against "Customer Status," noticed the two contradicted each
other, and discarded the unreliable one — with a stated reason. That is good
analyst work.

Then it picked the other wrong field and answered 128.

Its own stated assumption:

> "customer status c was used as the source of truth for determining current customer status."

It knew the `contracts` table existed and chose not to use it, because nothing in
the schema says contracts are the source of truth. It also never found
`parent_account_id`, so subsidiaries were counted as separate customers. Both
rules are real, both are written down in [GLOSSARY.md](GLOSSARY.md), and neither
is discoverable from the database.

**This is not a reasoning failure. The correct answer was unreachable from the
information available.** A better model explores more thoroughly and still picks
between four undifferentiated candidates. That is why the fix is a definition
layer, not a better prompt or more capable LLM.

---

## The dataset

`Parcelwise`, a fictional Series B logistics SaaS at ~$21M ARR. Three facts about
the company generate most of the mess, and each is something that happens at real
companies:

- the fiscal year starts **February 1** (FY27 = Feb 2026 – Jan 2027)
- billing **migrated from Chargebee to Stripe on 2025-03-01**, freezing several
  legacy fields that still look authoritative
- customers were **resegmented in FY26**, leaving two live segment fields

Traps planted, each at a known size:

| trap | what it produces | correct |
|---|---|---|
| four sources for "active customer" | 128 / 63 / 130 | **117** |
| `total_arr__c`, labeled "Total ARR", frozen since the migration | $7.67M | **$21.45M** |
| `amount` is TCV across the full multi-year term | $32.3M | **$31.0M** |
| mixed USD/CAD/GBP summed without conversion | $3.83M | **$12.13M** |
| retired employee-count segment field still populated | 19 Enterprise | **15** |
| legacy stage names after a picklist rename | misses 94 won deals | use `is_won` |
| subsidiaries, soft-deleted duplicates, test accounts | inflates every count | filter |

Five questions are **genuinely ambiguous** and have no correct number. "How much
churn did we have last quarter" could mean 17 customers or $1.68M. On those, any
number is scored wrong; the only passing response is a clarifying question.

The data is synthetic on purpose: the script that generates it also computes the
answer key, so every claim of "wrong" is provable. Field names and object shapes
follow Salesforce conventions.

---

## The fix

`mcp/server.ts` is an MCP server exposing 12 scoped tools and **no SQL access**.
Three mechanisms, doing different jobs:

**Removal.** There is no query tool, so `total_arr__c` is unreachable rather than
discouraged. This is the only hard guarantee in the system — a prompt saying
"don't use that field" is a request; deleting the path is a property.

**Encoding.** Glossary rules are compiled into each tool's SQL. The fiscal
calendar lives in one function, so `FY27-Q2` resolves identically everywhere.
Fiscal accuracy went 0/4 → 4/4 without the model getting better at fiscal
reasoning; it stopped having to do any.

**Refusal.** Ambiguous parameters have no default. `get_churn` cannot run without
`basis`; it errors and tells the caller to ask which was meant. This took
ambiguous questions from 2/5 to 5/5.

Every tool returns `definition_used` alongside its value, so stated assumptions
are a property of the system rather than something the model has to remember.

**Tool Coverage.** The tool coverage was designed with the question set in view.
The 12 tools were built to serve this ReveOps workflow, and 31 questions define 
that workflow, so coverage is inherently going to be good. This was meant to measure
how much a well scoped governed layer helps, no thow one handles questions that 
nobody anticipated. A fair extension would be a set of questions written after the 
tool was created.

---

## Reproduce it

```bash
npm install
# put DATABASE_URL and ANTHROPIC_API_KEY in .env.local
psql "$DATABASE_URL" -f db/schema.sql
npx tsx db/seed.ts            # deterministic — same DB every time
npx tsx evals/verify.ts       # ground-truth answer key
npx tsx mcp/test-tools.ts     # 29 tool assertions, no API calls
npx tsx evals/run.ts --condition baseline --model claude-sonnet-5
npx tsx evals/run.ts --condition mcp --model claude-sonnet-5
npx tsx evals/compare.ts baseline-claude-sonnet-5 mcp-claude-sonnet-5
```

Total API cost for a full cycle: about $2.50.

---

## Method notes, including what I got wrong

Honest reporting matters more here than a clean number, so:

- **The questions were frozen before the first run.** Commit history shows
  `evals/questions.ts` committed before any results existed.
- **M3 is scored as a failure but the server was right.** My ground-truth query
  for that question used a looser definition of pipeline than my own glossary.
  The governed server followed the glossary and was marked wrong. I left it
  rather than edit an answer key after seeing results.
- **C3 and C5 are mislabeled as controls.** Their ground truth quietly applies a
  hygiene filter, so they are really hygiene traps. Genuine controls were 4/4.
- **The harness initially scored formatting, not content.** Models that reasoned
  correctly but answered in prose instead of calling the answer tool were graded
  as failures — that was 14 of Haiku's 15 original misses. Fixed by nudging once
  for a structured answer, applied identically in every condition. Pre-fix
  results are kept in `results/v1-unnudged/`.
- **One run per condition.** There is visible run-to-run variance (the baseline's
  customer-count answer moved between runs). Treat small differences as noise and
  the ~58-point gap as signal.
- **The context reduction here is 62%, not the ~87% Credal reports.** This schema
  is small (95 columns). Most of the savings come from eliminating exploratory
  queries, not from compressing a schema dump.

---

## What building this by hand taught me

The benchmark is the easy half. [FRICTION.md](FRICTION.md) is the other half:
where the hand-built governed layer broke down — no as-of date, definitions
requiring a redeploy, no record of which definition produced which answer, two
teams needing two meanings of "active," and the one question that got *worse*
because scoped tools trade expressiveness for correctness.
