#!/usr/bin/env node
/**
 * Plumbline — mcp/server.ts
 * The fix. GLOSSARY.md, compiled into tools.
 *
 * Three design rules, and every one maps to something the baseline got wrong:
 *
 *  1. NO RAW SQL. There is no query tool. A caller cannot reach a legacy field,
 *     because no tool exposes one.
 *  2. EVERY ANSWER SHIPS ITS DEFINITION. Each tool returns definition_used and
 *     assumptions, so a stated assumption is a property of the system rather
 *     than something the model has to remember to mention.
 *  3. AMBIGUOUS PARAMETERS HAVE NO DEFAULT. get_churn cannot run without being
 *     told logo or revenue. The tool refuses; the model has to ask.
 *
 * Run standalone:  npx tsx mcp/server.ts
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema, ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client } from "pg";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

/**
 * As-of date. The benchmark is anchored to a fixed reporting date so results
 * are reproducible: with current_date, a contract expiring overnight silently
 * changes the customer count and every number derived from it.
 * Override with REPORT_DATE=2026-10-01 to run an as-of report for another day.
 */
const AS_OF = process.env.REPORT_DATE ?? "2026-09-11";
const TODAY = `date '${AS_OF}'`;

const db = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("127.0.0.1") ? undefined : { rejectUnauthorized: false },
});

// ===========================================================================
// The glossary, as SQL. Written once, enforced everywhere.
// ===========================================================================
const CLEAN = `
  clean_acc as (
    select a.* from accounts a
    left join accounts p on p.id = a.parent_account_id
    where a.is_deleted = false and a.type <> 'Test'
      and a.name not like '%DO NOT USE%'
      and coalesce(p.is_deleted, false) = false
  )`;

const ACTIVE = `
  active_contract as (
    select c.*, coalesce(a.parent_account_id, a.id) as customer_id, a.id as acct_id
    from contracts c join clean_acc a on a.id = c.account_id
    where c.status not in ('Draft','Cancelled')
      and ${TODAY} between c.start_date and c.end_date
  )`;

const USD = `
  usd_contract as (
    select ac.*, ac.arr / fx.conversion_rate as arr_usd
    from active_contract ac
    join dated_conversion_rates fx on fx.iso_code = ac.currency_iso_code
      and ${TODAY} >= fx.start_date and ${TODAY} < fx.next_start_date
  )`;

const WON = `
  won_opp as (
    select o.*, o.arr__c / fx.conversion_rate as arr_usd
    from opportunities o
    join clean_acc a on a.id = o.account_id
    join dated_conversion_rates fx on fx.iso_code = o.currency_iso_code
      and o.close_date >= fx.start_date and o.close_date < fx.next_start_date
    where o.is_won = true and o.is_deleted = false
  )`;

const OPEN = `
  open_opp as (
    select o.*, o.arr__c / fx.conversion_rate as arr_usd
    from opportunities o
    join clean_acc a on a.id = o.account_id
    join dated_conversion_rates fx on fx.iso_code = o.currency_iso_code
      and o.close_date >= fx.start_date and o.close_date < fx.next_start_date
    where o.is_closed = false and o.is_deleted = false
  )`;

const W = (...parts: string[]) => `with ${parts.join(",\n")}\n`;
const NEW_TYPES = `('New Business','Expansion','Upsell')`;

// --- fiscal calendar. FY starts Feb 1; FY named for the year it ends. -------
function resolvePeriod(p: string): { start: string; end: string; label: string } {
  const s = p.trim().toUpperCase();
  const m = s.match(/^FY(\d{2})(?:-Q([1-4]))?$/);
  if (!m) throw new Error(
    `Unrecognised period "${p}". Use FY27-Q3 or FY26. Parcelwise's fiscal year starts Feb 1 ` +
    `and is named for the year it ends, so FY27 runs 2026-02-01 to 2027-01-31.`);
  const endYear = 2000 + parseInt(m[1]);
  if (!m[2]) return {
    start: `${endYear - 1}-02-01`, end: `${endYear}-01-31`, label: `FY${m[1]}`,
  };
  const qi = parseInt(m[2]);
  const st = new Date(Date.UTC(endYear - 1, 1 + (qi - 1) * 3, 1));
  const en = new Date(Date.UTC(endYear - 1, 1 + qi * 3, 1) - 864e5);
  return {
    start: st.toISOString().slice(0, 10),
    end: en.toISOString().slice(0, 10),
    label: `FY${m[1]}-Q${qi}`,
  };
}

const one = async (sql: string, params: any[] = []) => {
  const r = await db.query(sql, params);
  const v = Object.values(r.rows[0])[0];
  return v === null ? 0 : parseFloat(String(v));
};

// ===========================================================================
// Tools
// ===========================================================================
const TOOLS = [
  {
    name: "count_customers",
    description:
      "Count current customers. A customer is a company with a contract that is not Draft or " +
      "Cancelled and that covers today. Subsidiaries are always rolled up into their parent. " +
      "Test accounts and soft-deleted duplicates are excluded.",
    inputSchema: {
      type: "object",
      properties: {
        segment: { type: "string", enum: ["Commercial", "Mid-Market", "Enterprise"],
          description: "Optional. Segment is by contracted ARR band, as of today." },
        billing_country: { type: "string", description: "Optional ISO country, e.g. GB." },
        product_usage: { type: "string", enum: ["any", "zero_last_month"],
          description: "Optional. 'zero_last_month' returns customers who are paying but had no active users last month." },
      },
    },
  },
  {
    name: "get_arr",
    description:
      "Total or average ARR across current customers, always converted to USD at the dated " +
      "corporate rate. ARR comes from contracts, never from account rollup fields or opportunity amounts.",
    inputSchema: {
      type: "object",
      properties: {
        aggregate: { type: "string", enum: ["total", "average_per_customer"], default: "total" },
        segment: { type: "string", enum: ["Commercial", "Mid-Market", "Enterprise"] },
        region: { type: "string", enum: ["all", "us_only", "non_us"], default: "all" },
      },
    },
  },
  {
    name: "get_new_arr",
    description:
      "New ARR won in a fiscal period, in USD. Includes New Business, Expansion and Upsell " +
      "('Upsell' is a legacy synonym for Expansion). Renewals are excluded because a renewal is " +
      "not new revenue. Won status comes from is_won, so legacy stage names are still counted.",
    inputSchema: {
      type: "object",
      properties: {
        period: { type: "string", description: "Fiscal period, e.g. FY27-Q2 or FY26." },
        expansion_only: { type: "boolean", default: false,
          description: "If true, count only Expansion/Upsell and exclude New Business." },
        to_date: { type: "boolean", default: false,
          description: "If true, stop at the reporting date rather than the end of the period." },
      },
      required: ["period"],
    },
  },
  {
    name: "get_pipeline",
    description:
      "Open pipeline ARR for a fiscal period, in USD. Counts only deals that are still open, " +
      "excludes anything forecast as Omitted, and excludes renewals unless asked for.",
    inputSchema: {
      type: "object",
      properties: {
        period: { type: "string", description: "Optional fiscal period, e.g. FY27-Q4. Omit for all open pipeline regardless of close date." },
        owner_status: { type: "string", enum: ["all", "inactive_owner"], default: "all",
          description: "'inactive_owner' returns only pipeline owned by reps who have left." },
      },
    },
  },
  {
    name: "get_renewals",
    description: "Count active contracts expiring within a fiscal period.",
    inputSchema: {
      type: "object",
      properties: { period: { type: "string", description: "Fiscal period, e.g. FY27-Q4." } },
      required: ["period"],
    },
  },
  {
    name: "get_churn",
    description:
      "Customers lost over a trailing window. 'Churn' has two distinct meanings at Parcelwise " +
      "and this tool will not guess between them: you must pass basis='logo' for a customer " +
      "count or basis='revenue' for lost ARR in USD. A contract gap of 60 days or less does not " +
      "count as churn. If the user did not specify which basis they meant, ask them first.",
    inputSchema: {
      type: "object",
      properties: {
        basis: { type: "string", enum: ["logo", "revenue"],
          description: "REQUIRED. No default exists. Ask the user if they did not say." },
        trailing_months: { type: "number", default: 12 },
      },
      required: ["basis"],
    },
  },
  {
    name: "get_segment_breakdown",
    description:
      "Customers by segment. 'How big is a segment' is ambiguous at Parcelwise, so you must pass " +
      "metric='customer_count' or metric='arr'. Segment always comes from the current ARR-band " +
      "field, never the retired employee-count field. If the user did not specify, ask first.",
    inputSchema: {
      type: "object",
      properties: {
        metric: { type: "string", enum: ["customer_count", "arr"],
          description: "REQUIRED. No default exists." },
      },
      required: ["metric"],
    },
  },
  {
    name: "get_won_deal_totals",
    description:
      "Total value of won deals. 'Bookings' is ambiguous at Parcelwise: basis='arr' gives " +
      "annualized value, basis='tcv' gives total contract value across the full multi-year term. " +
      "These differ substantially on multi-year deals. You must pass one; if the user did not " +
      "specify, ask first.",
    inputSchema: {
      type: "object",
      properties: {
        basis: { type: "string", enum: ["arr", "tcv"], description: "REQUIRED. No default exists." },
        period: { type: "string", description: "Optional fiscal period. Omit for all time." },
      },
      required: ["basis"],
    },
  },
  {
    name: "count_accounts",
    description:
      "Count accounts in the CRM, excluding test accounts and soft-deleted duplicates. This is " +
      "an account-hygiene tool and is NOT the customer count — use count_customers for customers.",
    inputSchema: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          enum: ["all_real", "product_active_without_contract", "health_score_below"],
          default: "all_real",
        },
        billing_country: { type: "string" },
        threshold: { type: "number", description: "Used with health_score_below." },
      },
    },
  },
  {
    name: "count_opportunities",
    description: "Count opportunities by open/closed state.",
    inputSchema: {
      type: "object",
      properties: { state: { type: "string", enum: ["open", "won", "lost"], default: "open" } },
    },
  },
  {
    name: "count_users",
    description: "Count employees by role and active status.",
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string", enum: ["AE", "SDR", "CSM", "Manager"] },
        active_only: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "get_contract_facts",
    description:
      "Facts about the contract book: in_force_count (contracts covering today, excluding Draft " +
      "and Cancelled), auto_renew_count, or max_arr (largest single contract, in its own currency).",
    inputSchema: {
      type: "object",
      properties: {
        metric: { type: "string", enum: ["in_force_count", "auto_renew_count", "max_arr"] },
      },
      required: ["metric"],
    },
  },
];

// ===========================================================================
// Dispatch
// ===========================================================================
type Out = { value: number; definition_used: string; assumptions: string[]; unit?: string };

async function dispatch(name: string, a: any): Promise<Out> {
  switch (name) {

    case "count_customers": {
      const cond: string[] = [], p: any[] = [];
      let join = "";
      if (a.segment) {
        join += ` join accounts acc on acc.id = ac.acct_id
                  left join accounts par on par.id = acc.parent_account_id`;
        p.push(a.segment);
        cond.push(`coalesce(par.sales_segment__c, acc.sales_segment__c) = $${p.length}`);
      }
      if (a.billing_country) {
        if (!a.segment) join += ` join accounts acc on acc.id = ac.acct_id`;
        p.push(a.billing_country);
        cond.push(`acc.billing_country = $${p.length}`);
      }
      if (a.product_usage === "zero_last_month") {
        join += ` join product_usage_monthly u on u.account_id = ac.acct_id
                  and u.month = date_trunc('month', ${TODAY} - interval '1 month')::date`;
        cond.push(`u.active_users = 0`);
      }
      const value = await one(
        `${W(CLEAN, ACTIVE)} select count(distinct ac.customer_id) from active_contract ac${join}
         ${cond.length ? "where " + cond.join(" and ") : ""}`, p);
      return {
        value,
        definition_used: "Customer = company with a non-Draft, non-Cancelled contract covering today; subsidiaries rolled up to parent.",
        assumptions: [
          "Test accounts and soft-deleted duplicates excluded.",
          ...(a.segment ? ["Segment taken from the current ARR-band field, as of today."] : []),
          ...(a.product_usage === "zero_last_month" ? ["Product usage measured over the last full calendar month."] : []),
        ],
        unit: "customers",
      };
    }

    case "get_arr": {
      const cond: string[] = [], p: any[] = [];
      let join = ` join accounts acc on acc.id = uc.acct_id
                   left join accounts par on par.id = acc.parent_account_id`;
      if (a.segment) { p.push(a.segment); cond.push(`coalesce(par.sales_segment__c, acc.sales_segment__c) = $${p.length}`); }
      if (a.region === "us_only") cond.push(`acc.billing_country = 'US'`);
      if (a.region === "non_us") cond.push(`acc.billing_country <> 'US'`);
      const where = cond.length ? "where " + cond.join(" and ") : "";
      const agg = a.aggregate === "average_per_customer"
        ? `sum(uc.arr_usd) / nullif(count(distinct uc.customer_id),0)`
        : `sum(uc.arr_usd)`;
      const value = await one(
        `${W(CLEAN, ACTIVE, USD)} select ${agg} from usd_contract uc${join} ${where}`, p);
      return {
        value,
        definition_used: "ARR = sum of contracts.arr for contracts in force today, converted to USD at the dated corporate rate.",
        assumptions: [
          "Legacy account ARR rollup and opportunity amounts were not used.",
          "Currency converted at the rate in effect today.",
          ...(a.aggregate === "average_per_customer" ? ["Averaged per parent-level customer."] : []),
        ],
        unit: "USD",
      };
    }

    case "get_new_arr": {
      const { start, end, label } = resolvePeriod(a.period);
      const endDate = a.to_date ? TODAY : `$2`;
      const types = a.expansion_only ? `('Expansion','Upsell')` : NEW_TYPES;
      const params = a.to_date ? [start] : [start, end];
      const value = await one(
        `${W(CLEAN, WON)} select coalesce(sum(arr_usd),0) from won_opp
         where type in ${types} and close_date between $1 and ${endDate}`, params);
      return {
        value,
        definition_used: `New ARR for ${label} (${start} to ${a.to_date ? "today" : end}). Renewals excluded. 'Upsell' counted as Expansion. Won status from is_won, so legacy stage names are included.`,
        assumptions: [
          "Parcelwise's fiscal year starts February 1; FY is named for the year it ends.",
          "Deal ARR converted to USD at the rate in effect on the close date.",
          ...(a.expansion_only ? ["New Business excluded; expansion and upsell only."] : []),
        ],
        unit: "USD",
      };
    }

    case "get_pipeline": {
      const per = a.period ? resolvePeriod(a.period) : null;
      const ownerJoin = a.owner_status === "inactive_owner"
        ? ` join users u on u.id = oo.owner_id and u.is_active = false` : "";
      const value = await one(
        `${W(CLEAN, OPEN)} select coalesce(sum(oo.arr_usd),0) from open_opp oo${ownerJoin}
         where oo.type in ${NEW_TYPES} and oo.forecast_category <> 'Omitted'
           ${per ? "and oo.close_date between $1 and $2" : ""}`,
        per ? [per.start, per.end] : []);
      return {
        value,
        definition_used: `Open new-business and expansion pipeline${per ? ` for ${per.label} (${per.start} to ${per.end})` : ", all close dates"}, excluding Omitted.`,
        assumptions: [
          "Renewal opportunities are not counted as pipeline.",
          "Measured in annualized value, not total contract value.",
          ...(a.owner_status === "inactive_owner" ? ["Restricted to deals owned by departed reps."] : []),
        ],
        unit: "USD",
      };
    }

    case "get_renewals": {
      const { start, end, label } = resolvePeriod(a.period);
      const value = await one(
        `${W(CLEAN, ACTIVE)} select count(*) from active_contract
         where end_date between $1 and $2`, [start, end]);
      return {
        value,
        definition_used: `Contracts in force today that expire during ${label} (${start} to ${end}).`,
        assumptions: ["Draft and cancelled contracts excluded."],
        unit: "contracts",
      };
    }

    case "get_churn": {
      if (!a.basis) throw new Error(
        "get_churn requires basis. 'Churn' means two different things at Parcelwise: " +
        "basis='logo' counts customers lost, basis='revenue' sums the ARR lost. " +
        "Ask the user which one they mean before calling this tool again.");
      const months = a.trailing_months ?? 12;
      const base = `
        from contracts c join accounts a on a.id = c.account_id
        where c.status = 'Expired'
          and c.end_date between ${TODAY} - ($1 || ' months')::interval and ${TODAY}
          and a.is_deleted = false and a.type <> 'Test'
          and not exists (select 1 from contracts c2 where c2.account_id = c.account_id
            and c2.status not in ('Draft','Cancelled') and c2.end_date > c.end_date + 60)`;
      const value = a.basis === "logo"
        ? await one(`select count(distinct coalesce(a.parent_account_id, a.id)) ${base}`, [months])
        : await one(`select coalesce(sum(c.arr / fx.conversion_rate),0) ${base.replace(
            "from contracts c join accounts a on a.id = c.account_id",
            `from contracts c join accounts a on a.id = c.account_id
             join dated_conversion_rates fx on fx.iso_code = c.currency_iso_code
               and c.end_date >= fx.start_date and c.end_date < fx.next_start_date`)}`, [months]);
      return {
        value,
        definition_used: a.basis === "logo"
          ? `Logo churn: distinct customers whose contract expired in the last ${months} months with no replacement.`
          : `Revenue churn: ARR lost from contracts that expired in the last ${months} months with no replacement.`,
        assumptions: [
          "A contract gap of 60 days or less is treated as a renewal delay, not churn.",
          "Counted at the parent-company level.",
        ],
        unit: a.basis === "logo" ? "customers" : "USD",
      };
    }

    case "get_segment_breakdown": {
      if (!a.metric) throw new Error(
        "get_segment_breakdown requires metric. 'How big is a segment' could mean customer_count " +
        "or arr. Ask the user which they mean.");
      const r = await db.query(
        a.metric === "customer_count"
          ? `${W(CLEAN, ACTIVE)} select seg, count(*)::numeric v from (
               select distinct ac.customer_id, coalesce(par.sales_segment__c, acc.sales_segment__c) seg
               from active_contract ac join accounts acc on acc.id = ac.acct_id
               left join accounts par on par.id = acc.parent_account_id) t group by 1 order by 1`
          : `${W(CLEAN, ACTIVE, USD)} select coalesce(par.sales_segment__c, acc.sales_segment__c) seg,
               sum(uc.arr_usd) v from usd_contract uc join accounts acc on acc.id = uc.acct_id
               left join accounts par on par.id = acc.parent_account_id group by 1 order by 1`);
      const rows = r.rows.map(x => `${x.seg}: ${Math.round(parseFloat(x.v)).toLocaleString()}`);
      return {
        value: rows.length,
        definition_used: `Segment breakdown by ${a.metric}. Segment from the current ARR-band field (Commercial <$50k, Mid-Market $50k-250k, Enterprise >$250k).`,
        assumptions: [`Breakdown — ${rows.join(" | ")}`, "Retired employee-count segment field not used."],
        unit: a.metric,
      };
    }

    case "get_won_deal_totals": {
      if (!a.basis) throw new Error(
        "get_won_deal_totals requires basis: 'arr' for annualized value or 'tcv' for total " +
        "contract value. These differ on multi-year deals. Ask the user which they mean.");
      const col = a.basis === "arr" ? "arr__c" : "amount";
      let sql = `select coalesce(sum(${col}),0) from opportunities o
                 where o.is_won = true and o.is_deleted = false`;
      const p: any[] = [];
      if (a.period) {
        const { start, end } = resolvePeriod(a.period);
        p.push(start, end); sql += ` and o.close_date between $1 and $2`;
      }
      return {
        value: await one(sql, p),
        definition_used: a.basis === "arr"
          ? "Annualized recurring value of won deals."
          : "Total contract value of won deals, across the full multi-year term.",
        assumptions: [
          a.basis === "tcv"
            ? "Multi-year deals counted at full term value, so this exceeds ARR."
            : "Multi-year deals counted at annual value, not full term value.",
        ],
        unit: "deal currency",
      };
    }

    case "count_accounts": {
      const f = a.filter ?? "all_real";
      if (f === "product_active_without_contract") {
        return {
          value: await one(`${W(CLEAN, ACTIVE)}
            select count(*) from product_usage_monthly u join clean_acc a on a.id = u.account_id
            where u.month = date_trunc('month', ${TODAY} - interval '1 month')::date
              and u.active_users > 0
              and u.account_id not in (select acct_id from active_contract)`),
          definition_used: "Accounts with product usage last month but no contract in force (pilots and trials).",
          assumptions: ["These are not customers."],
          unit: "accounts",
        };
      }
      if (f === "health_score_below") {
        return {
          value: await one(`${W(CLEAN)} select count(*) from clean_acc where csm_health_score__c < $1`,
            [a.threshold ?? 50]),
          definition_used: `Real accounts with CSM health score below ${a.threshold ?? 50}.`,
          assumptions: ["Test accounts and soft-deleted duplicates excluded."],
          unit: "accounts",
        };
      }
      const p: any[] = [];
      let where = "";
      if (a.billing_country) { p.push(a.billing_country); where = `where billing_country = $1`; }
      return {
        value: await one(`${W(CLEAN)} select count(*) from clean_acc ${where}`, p),
        definition_used: "Real accounts in the CRM.",
        assumptions: ["Test accounts and soft-deleted duplicates excluded.",
          "This is an account count, not a customer count."],
        unit: "accounts",
      };
    }

    case "count_opportunities": {
      const st = a.state ?? "open";
      const w = st === "open" ? "is_closed = false"
        : st === "won" ? "is_won = true" : "is_closed = true and is_won = false";
      return {
        value: await one(`select count(*) from opportunities where ${w} and is_deleted = false`),
        definition_used: `Opportunities in state '${st}'. Won/lost taken from is_won, not stage name.`,
        assumptions: ["Deleted opportunities excluded."],
        unit: "opportunities",
      };
    }

    case "count_users": {
      const p: any[] = [], cond: string[] = [];
      if (a.role) { p.push(a.role); cond.push(`role = $${p.length}`); }
      if (a.active_only) cond.push(`is_active = true`);
      return {
        value: await one(`select count(*) from users ${cond.length ? "where " + cond.join(" and ") : ""}`, p),
        definition_used: `Employee count${a.role ? ` with role ${a.role}` : ""}${a.active_only ? ", active only" : ""}.`,
        assumptions: a.active_only ? [] : ["Includes departed employees unless active_only was set."],
        unit: "people",
      };
    }

    case "get_contract_facts": {
      if (a.metric === "max_arr")
        return { value: await one(`select max(arr) from contracts`),
          definition_used: "Largest single contract ARR, in its own currency.",
          assumptions: ["Not currency-converted."], unit: "contract currency" };
      if (a.metric === "auto_renew_count")
        return { value: await one(`select count(*) from contracts where auto_renew = true`),
          definition_used: "Contracts with auto-renew enabled.", assumptions: [], unit: "contracts" };
      return {
        value: await one(`${W(CLEAN, ACTIVE)} select count(*) from active_contract`),
        definition_used: "Contracts in force today, excluding Draft and Cancelled.",
        assumptions: ["Counted per contract, not per customer."], unit: "contracts",
      };
    }
  }
  throw new Error(`Unknown tool: ${name}`);
}

// ===========================================================================
// Wire up MCP
// ===========================================================================
export const SERVER_INSTRUCTIONS = `You are a RevOps analyst at Parcelwise, a B2B logistics SaaS company. Today is ${AS_OF}.

You answer business questions using the tools below. You do NOT have raw database access, and you do not need it: every tool already enforces Parcelwise's official definitions.

Parcelwise's fiscal year starts February 1 and is named for the year it ends. FY27 runs 2026-02-01 to 2027-01-31. FY27 Q3 (the current quarter) is 2026-08-01 to 2026-10-31. Pass periods as FY27-Q3 or FY26.

Some questions cannot be answered as asked because a key term has more than one official meaning at Parcelwise. The ambiguous terms are: "churn" (customers lost vs ARR lost), "bookings" (annualized vs total contract value), "active" (under contract vs using the product), "how big" a segment is (customer count vs ARR), and "best" quarter (no single agreed metric). When a question turns on one of these and the user has not said which they mean, do not pick one — submit a clarifying question instead.

Every tool returns the definition it used. Pass those through in your assumptions so the person reading your answer knows what it rests on.`;

const server = new Server(
  { name: "parcelwise-revops", version: "1.0.0" },
  { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const out = await dispatch(req.params.name, req.params.arguments ?? {});
    return { content: [{ type: "text", text: JSON.stringify(out) }] };
  } catch (e: any) {
    return { content: [{ type: "text", text: `ERROR: ${e.message}` }], isError: true };
  }
});

export { dispatch, TOOLS, db };

export async function startStdio() {
  await db.connect();
  await server.connect(new StdioServerTransport());
  console.error("parcelwise-revops MCP server running on stdio");
}

if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  startStdio().catch(e => { console.error(e); process.exit(1); });
}
