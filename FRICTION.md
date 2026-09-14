# FRICTION.md

The benchmark result (29% → 93.5%) is the easy half. This file is the other half,
documenting how big the scope is, where things broke down and where thigns stop 
scaling. 

Format per entry: what happened, why it matters, what a platform would need to do.

---

## 1. No as-of date — answers drifted overnight

**What happened.** SQL's `current_date` created issues with sourcing truth. The tool
suite passed 29/29 against the answer key on Sept 11 however, on a re-run on Sept 13
wiht no code change, it failed 3 checks: customers 117 → 116, contracts in force 129 →
128, total ARR down ~$196k since contract's `end_date` had passed overnight.

**Why it matters.** Nothing in the output indicated the number had moved. A
report run Friday and re-run Monday returns different figures with no flag and
no explanation. This is why finance freezes a reporting date before
close but I rebuilt the problem without noticing.

**Fix I applied.** Pinned a module-level `AS_OF` constant, overridable by env var.
Roughly 20 lines touched across 6 queries.

**Why the fix is not enough.** The as-of date is now a constant in a file. It
should be a first-class parameter attached to every answer, so that six months
from now you can ask "what did this report say on the day we made the call" and
get a real answer. My version can't reconstruct that since nothing is recorded.

---

## 2. Changing one definition means a redeploy

**What happened.** Segment thresholds (Commercial <$50k / Mid-Market $50–250k /
Enterprise >$250k) are written into SQL inside `server.ts`. Changing a threshold
means editing TypeScript, restarting the server process, and re-running the entire
tool test suite, which scaled is an expensive process.

**Why it matters.** The people who own these definitions are RevOps and Finance,
not engineers. In this architecture, every definition change is an engineering
ticket. In a large corperation it would be an issue because the real definition
moves in a Google Sheet, the enforced definition stays whatever was last deployed,
and nobody notices until a number looks wrong.

**What a platform needs.** Definitions editable by their owners, versioned, with
the deploy step removed from the loop. This would be hard in practice as it would
require either a middle layer for owners to directly edit, or people to become 
more technical and solve tickets themselves.

---

## 3. No record of which definition produced which answer

**What happened.** Each tool returns `definition_used` in its response, which
gets passed through into the model's stated assumptions. That's good for the
person reading the answer in the moment. But nothing is persisted. Once the
conversation ends, there's no record that the number rested on a particular
reading of "customer." This issue grows as more definitions for the same word
pops up in different scopes with different teams.

**Why it matters.** If the definition changes in three months, every number
produced before the change is now unreproducible and un-auditable. You cannot
answer "was this report built on the old definition or the new one." For any
metric that reaches a board deck, that's disqualifying.

**What a platform needs.** Definition version stamped on every answer, retained,
queryable, optimally a definition could travel with the place it is used.

---

## 4. No permissions

**What happened.** The server answers identically regardless of who asks. Total
ARR, churn, and segment breakdown are available to any caller.

**Why it matters.** A CSM asking about their own accounts should not receive the
company revenue picture. Adding per-user scoping here means threading identity
through 12 tools and 6 shared SQL fragments, by hand, with no way to test that
the rules hold except writing more tests (which would interfere with the results 
achieved in this test).

---

## 5. Scoping moved the failure rather than removing it (D5)

**What happened.** Question D5 asks for expansion ARR in FY27 to date. The
baseline got it right. The governed version failed, it hit the turn limit
without submitting an answer, the only regression in the run.

**Why it matters.** This is the honest counterweight to the headline number.
Removing raw SQL removes "picked the wrong field," but it introduces a new
ceiling, if the question needs a combination the tool doesn't expose cleanly,
the model can no longer fall back to expressing it another way. 

**The tradeoff, stated plainly.** Scoped tools trade expressiveness for
correctness. That's the right trade for a known workflow. It's the wrong trade
if you expect the tool suite to answer questions nobody anticipated, and it
means tool coverage becomes an ongoing maintenance surface, not a one-time build.

---

## 6. I built this for a singular workflow

**What happened.** 12 tools, ~600 lines, roughly a day of work, covering one
persona (RevOps analyst) against one system (a Salesforce-shaped CRM).

**Why it matters.** The next workflow, support, finance close, CS health,
starts near zero. Shared definitions would be copy-pasted, then diverge. Six
workflows in, there is no single place where "customer" is defined, which is the
exact condition that produced the 29% baseline in the first place.

**What a platform needs.** The definition layer built once and reused across
workflows, with per-workflow scoping on top rather than per-workflow rebuilds.

---

## 7.  Harness scored formatting instead of content 

**What happened.** Answers were collected through a submit answer tool that also 
had the stated assumptions and a needs clarification tag. A model that finished 
reasoning just wrote the answer instead of having it within a sentence. The conversation
loop ended up breaking and even though it would get the right answer it would 
come back as no answer submitted.

**Why it matters.** The error was not possible to see from the results since they
only wrote "no answer submitted." From an outside perspective this wouldn't seem 
like an issue but it broke my expectations which is why I further investigated it.

---

## Open question I could not resolve

Two of the five ambiguous questions ("how many active accounts," "which quarter
was our best") are caught only by an instruction in the system prompt, not by
tool structure. The other three are enforced structurally: the tool refuses to
run without a required parameter. Structural enforcement held at 100%;
instruction-based enforcement happened to hold here but is not guaranteed.

I don't know how to make "active" structurally ambiguous without either
duplicating every tool or pushing the choice back to the model. That's the piece
I'd most want to ask someone who has deployed this at scale.
