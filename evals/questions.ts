/**
 * Plumbline — questions.ts
 * The 31-question exam. Both the baseline and the fixed version answer these.
 *
 * Each question has:
 *   trap   — the specific mistake it is designed to catch (null = clean control)
 *   type   — "number" (graded on the value) or "clarify" (graded on whether it ASKS)
 *   sql    — the ground-truth query. Null for ambiguous questions.
 *
 * NOTHING IN THIS FILE CHANGES ONCE THE FIRST BASELINE RUN HAPPENS.
 * Editing traps after seeing results is how benchmarks become dishonest.
 */

export type Question = {
  id: string;
  question: string;
  category: string;
  trap: string | null;
  type: "number" | "clarify";
  sql: string | null;
  tolerance?: number;   // fractional, e.g. 0.005 = 0.5%
  expected?: number | string;
};

// Reusable building blocks, pasted into each query so every query is self-contained.
const PRELUDE = `
with clean_acc as (
  select a.*
  from accounts a
  left join accounts p on p.id = a.parent_account_id
  where a.is_deleted = false
    and a.type <> 'Test'
    and a.name not like '%DO NOT USE%'
    and coalesce(p.is_deleted, false) = false
),
active_contract as (
  select c.*, coalesce(a.parent_account_id, a.id) as customer_id, a.id as acct_id
  from contracts c
  join clean_acc a on a.id = c.account_id
  where c.status not in ('Draft','Cancelled')
    and current_date between c.start_date and c.end_date
),
usd_contract as (
  select ac.*, ac.arr / fx.conversion_rate as arr_usd
  from active_contract ac
  join dated_conversion_rates fx
    on fx.iso_code = ac.currency_iso_code
   and current_date >= fx.start_date and current_date < fx.next_start_date
),
won_opp as (
  select o.*, coalesce(a.parent_account_id, a.id) as customer_id,
         o.arr__c / fx.conversion_rate as arr_usd
  from opportunities o
  join clean_acc a on a.id = o.account_id
  join dated_conversion_rates fx
    on fx.iso_code = o.currency_iso_code
   and o.close_date >= fx.start_date and o.close_date < fx.next_start_date
  where o.is_won = true and o.is_deleted = false
),
open_opp as (
  select o.*, coalesce(a.parent_account_id, a.id) as customer_id,
         o.arr__c / fx.conversion_rate as arr_usd
  from opportunities o
  join clean_acc a on a.id = o.account_id
  join dated_conversion_rates fx
    on fx.iso_code = o.currency_iso_code
   and o.close_date >= fx.start_date and o.close_date < fx.next_start_date
  where o.is_closed = false and o.is_deleted = false
)
`;

const NEW_TYPES = `('New Business','Expansion','Upsell')`;

// FY27: Feb 1 2026 - Jan 31 2027.  Q1 Feb-Apr | Q2 May-Jul | Q3 Aug-Oct | Q4 Nov-Jan
const FY27_Q1 = ["2026-02-01", "2026-04-30"];
const FY27_Q2 = ["2026-05-01", "2026-07-31"];
const FY27_Q3 = ["2026-08-01", "2026-10-31"];
const FY27_Q4 = ["2026-11-01", "2027-01-31"];
const FY26 = ["2025-02-01", "2026-01-31"];

export const QUESTIONS: Question[] = [

  // ---------------------------------------------------------- CLEAN CONTROLS
  // The baseline SHOULD get these. If it fails them all, the test is unfair.
  {
    id: "C1", category: "control", trap: null, type: "number",
    question: "How many opportunities are currently open (not closed)?",
    sql: `select count(*) from opportunities where is_closed = false and is_deleted = false`,
  },
  {
    id: "C2", category: "control", trap: null, type: "number",
    question: "How many sales reps have the role 'AE'?",
    sql: `select count(*) from users where role = 'AE'`,
  },
  {
    id: "C3", category: "control", trap: null, type: "number",
    question: "How many accounts are based in the United Kingdom (billing country GB)?",
    sql: `${PRELUDE} select count(*) from clean_acc where billing_country = 'GB'`,
  },
  {
    id: "C4", category: "control", trap: null, type: "number",
    question: "What is the largest single contract ARR on record, in its own currency?",
    sql: `select max(arr) from contracts`,
  },
  {
    id: "C5", category: "control", trap: null, type: "number",
    question: "How many accounts have a CSM health score below 50?",
    sql: `${PRELUDE} select count(*) from clean_acc where csm_health_score__c < 50`,
  },
  {
    id: "C6", category: "control", trap: null, type: "number",
    question: "How many contracts have auto-renew turned on?",
    sql: `select count(*) from contracts where auto_renew = true`,
  },

  // ------------------------------------------------------ DEFINITION TRAPS
  {
    id: "D1", category: "definition", type: "number",
    trap: "is_active__c / customer_status__c / usage instead of contracts; subsidiaries not rolled up",
    question: "How many customers do we have right now?",
    sql: `${PRELUDE} select count(distinct customer_id) from active_contract`,
  },
  {
    id: "D2", category: "definition", type: "number",
    trap: "accounts.total_arr__c (frozen) or opportunities.amount (TCV) instead of contracts",
    question: "What is our total ARR today, in USD?",
    sql: `${PRELUDE} select sum(arr_usd) from usd_contract`,
    tolerance: 0.005,
  },
  {
    id: "D3", category: "definition", type: "number",
    trap: "counting subsidiaries as separate customers",
    question: "How many customers do we have if subsidiaries are rolled up into their parent company?",
    sql: `${PRELUDE} select count(distinct customer_id) from active_contract`,
  },
  {
    id: "D4", category: "definition", type: "number",
    trap: "including Renewal deals in new ARR",
    question: "How much new ARR did we close in FY27 Q2, in USD? New ARR excludes renewals.",
    sql: `${PRELUDE} select sum(arr_usd) from won_opp
          where type in ${NEW_TYPES} and close_date between '${FY27_Q2[0]}' and '${FY27_Q2[1]}'`,
    tolerance: 0.005,
  },
  {
    id: "D5", category: "definition", type: "number",
    trap: "treating 'Upsell' as separate from 'Expansion' and dropping it",
    question: "How much expansion ARR (including deals typed as 'Upsell') did we close in FY27 so far, in USD?",
    sql: `${PRELUDE} select sum(arr_usd) from won_opp
          where type in ('Expansion','Upsell') and close_date between '2026-02-01' and current_date`,
    tolerance: 0.005,
  },
  {
    id: "D6", category: "definition", type: "number",
    trap: "stage_name = 'Closed Won' misses legacy stage names",
    question: "How much new ARR did we close in all of FY26, in USD?",
    sql: `${PRELUDE} select sum(arr_usd) from won_opp
          where type in ${NEW_TYPES} and close_date between '${FY26[0]}' and '${FY26[1]}'`,
    tolerance: 0.005,
  },
  {
    id: "D7", category: "definition", type: "number",
    trap: "legacy segment__c (employee bands) instead of sales_segment__c (ARR bands)",
    question: "How many of our current customers are in the Enterprise segment?",
    sql: `${PRELUDE}
          select count(*) from (
            select distinct ac.customer_id,
                   coalesce(p.sales_segment__c, a.sales_segment__c) seg
            from active_contract ac
            join accounts a on a.id = ac.acct_id
            left join accounts p on p.id = a.parent_account_id
          ) t where seg = 'Enterprise'`,
  },
  {
    id: "D8", category: "definition", type: "number",
    trap: "opportunities.amount is TCV across the full multi-year term, not annual",
    question: "Across all won deals, what is the total annualized value (ARR), not total contract value?",
    sql: `select sum(arr__c) from opportunities where is_won = true and is_deleted = false`,
    tolerance: 0.005,
  },
  {
    id: "D9", category: "definition", type: "number",
    trap: "summing mixed USD/CAD/GBP without conversion",
    question: "What is total ARR for customers billed outside the US, converted to USD?",
    sql: `${PRELUDE}
          select sum(uc.arr_usd) from usd_contract uc
          join accounts a on a.id = uc.acct_id
          where a.billing_country <> 'US'`,
    tolerance: 0.005,
  },
  {
    id: "D10", category: "definition", type: "number",
    trap: "counting product-active accounts as customers",
    question: "How many accounts logged into the product last month but have no active contract?",
    sql: `${PRELUDE}
          select count(*) from (
            select u.account_id from product_usage_monthly u
            join clean_acc a on a.id = u.account_id
            where u.month = date_trunc('month', current_date - interval '1 month')::date
              and u.active_users > 0
              and u.account_id not in (select acct_id from active_contract)
          ) t`,
  },
  {
    id: "D11", category: "hygiene", type: "number",
    trap: "including soft-deleted duplicates and Test accounts",
    question: "How many real (non-test, non-duplicate) accounts are in the system?",
    sql: `${PRELUDE} select count(*) from clean_acc`,
  },
  {
    id: "D12", category: "definition", type: "number",
    trap: "counting Draft and Cancelled contracts as real",
    question: "How many contracts are currently in force? Draft and cancelled contracts do not count.",
    sql: `${PRELUDE} select count(*) from active_contract`,
  },

  // -------------------------------------------------------- FISCAL CALENDAR
  {
    id: "F1", category: "fiscal", type: "number",
    trap: "calendar quarter instead of fiscal (FY starts Feb 1)",
    question: "How much new ARR have we closed this quarter to date, in USD? Our fiscal year starts February 1.",
    sql: `${PRELUDE} select sum(arr_usd) from won_opp
          where type in ${NEW_TYPES} and close_date between '${FY27_Q3[0]}' and current_date`,
    tolerance: 0.005,
  },
  {
    id: "F2", category: "fiscal", type: "number",
    trap: "reading FY27 as calendar 2027",
    question: "How much new ARR did we close in FY27 Q1, in USD?",
    sql: `${PRELUDE} select sum(arr_usd) from won_opp
          where type in ${NEW_TYPES} and close_date between '${FY27_Q1[0]}' and '${FY27_Q1[1]}'`,
    tolerance: 0.005,
  },
  {
    id: "F3", category: "fiscal", type: "number",
    trap: "wrong quarter boundaries for renewals",
    question: "How many active contracts are set to expire during FY27 Q4?",
    sql: `${PRELUDE} select count(*) from active_contract
          where end_date between '${FY27_Q4[0]}' and '${FY27_Q4[1]}'`,
  },
  {
    id: "F4", category: "fiscal", type: "number",
    trap: "including renewals and Omitted deals in pipeline; wrong quarter dates",
    question: "What is our open new-business and expansion pipeline for FY27 Q4, in USD ARR? Exclude anything forecast as Omitted.",
    sql: `${PRELUDE} select sum(arr_usd) from open_opp
          where type in ${NEW_TYPES} and forecast_category <> 'Omitted'
            and close_date between '${FY27_Q4[0]}' and '${FY27_Q4[1]}'`,
    tolerance: 0.005,
  },

  // -------------------------------------------------------------- MULTI-HOP
  {
    id: "M1", category: "multi-hop", type: "number",
    trap: "combines segment definition + contract-based ARR",
    question: "What is the average ARR per customer in the Mid-Market segment, in USD?",
    sql: `${PRELUDE}
          select sum(arr_usd) / count(distinct customer_id) from (
            select uc.*, coalesce(p.sales_segment__c, a.sales_segment__c) seg
            from usd_contract uc
            join accounts a on a.id = uc.acct_id
            left join accounts p on p.id = a.parent_account_id
          ) t where seg = 'Mid-Market'`,
    tolerance: 0.005,
  },
  {
    id: "M2", category: "multi-hop", type: "number",
    trap: "paying customers with zero product usage",
    question: "How many current customers had zero active users last month?",
    sql: `${PRELUDE}
          select count(distinct ac.customer_id)
          from active_contract ac
          join product_usage_monthly u on u.account_id = ac.acct_id
          where u.month = date_trunc('month', current_date - interval '1 month')::date
            and u.active_users = 0`,
  },
  {
    id: "M3", category: "multi-hop", type: "number",
    trap: "departed reps still own open pipeline",
    question: "How much open pipeline ARR is owned by reps who are no longer active employees, in USD?",
    sql: `${PRELUDE}
          select coalesce(sum(oo.arr_usd),0) from open_opp oo
          join users u on u.id = oo.owner_id
          where u.is_active = false`,
    tolerance: 0.005,
  },
  {
    id: "M4", category: "multi-hop", type: "number",
    trap: "churn definition + 60-day grace period",
    question: "How many customers have we lost in the last 12 months, counting logos? A gap of 60 days or less before a new contract does not count as churn.",
    sql: `select count(distinct coalesce(a.parent_account_id, a.id))
          from contracts c
          join accounts a on a.id = c.account_id
          where c.status = 'Expired'
            and c.end_date between current_date - 365 and current_date
            and a.is_deleted = false and a.type <> 'Test'
            and not exists (
              select 1 from contracts c2 where c2.account_id = c.account_id
                and c2.status not in ('Draft','Cancelled')
                and c2.end_date > c.end_date + 60)`,
  },

  // ------------------------------------------------------------- AMBIGUOUS
  // Correct behaviour is to ASK, not to answer. Answering = wrong, however good the number.
  {
    id: "A1", category: "ambiguous", type: "clarify", sql: null,
    trap: "churn: logo count vs revenue dollars",
    question: "How much churn did we have last quarter?",
  },
  {
    id: "A2", category: "ambiguous", type: "clarify", sql: null,
    trap: "'how big' = customer count or ARR",
    question: "How big is our Enterprise segment?",
  },
  {
    id: "A3", category: "ambiguous", type: "clarify", sql: null,
    trap: "'active' = contracted (finance) or product-using (CS)",
    question: "How many active accounts do we have?",
  },
  {
    id: "A4", category: "ambiguous", type: "clarify", sql: null,
    trap: "'bookings' = ARR or TCV",
    question: "What were our bookings in FY27 Q2?",
  },
  {
    id: "A5", category: "ambiguous", type: "clarify", sql: null,
    trap: "'best quarter' = new ARR, total ARR, or deal count",
    question: "Which quarter was our best this year?",
  },
];
