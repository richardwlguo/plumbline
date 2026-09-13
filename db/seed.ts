/**
 * Plumbline — seed.ts
 * Fills the Parcelwise database with fake-but-realistic CRM data.
 *
 * Every trap in the glossary is planted here on purpose, at a known size.
 * Deterministic: same seed => same database => reproducible experiment.
 *
 * Run:  npx tsx db/seed.ts
 */

import { Client } from "pg";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

// ---------------------------------------------------------------- constants
const TODAY = new Date("2026-09-11");
const MIGRATION = new Date("2025-03-01"); // Chargebee -> Stripe. Legacy fields freeze here.

// ------------------------------------------------------- deterministic RNG
let _s = 20260911;
function rnd() {
  _s |= 0; _s = (_s + 0x6d2b79f5) | 0;
  let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const chance = (p: number) => rnd() < p;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 864e5);
const addMonths = (d: Date, n: number) => {
  const x = new Date(d); x.setMonth(x.getMonth() + n); return x;
};

// ------------------------------------------------------------- name pieces
const A = ["North", "Cedar", "Iron", "Blue", "Summit", "Harbor", "Vector", "Bright", "Stone", "Nova",
  "Pioneer", "Copper", "Silver", "Granite", "Falcon", "Orchard", "Maple", "Atlas", "Delta", "Beacon",
  "Crescent", "Lattice", "Union", "Prairie", "Quarry", "Redwood", "Sable", "Tundra", "Vantage", "Whitfield"];
const B = ["Logistics", "Freight", "Supply", "Distribution", "Foods", "Retail Group", "Industries",
  "Manufacturing", "Wholesale", "Brands", "Labs", "Systems", "Partners", "Holdings", "Trading"];
const SUF = ["Inc", "LLC", "Corp", "Co", "Group", "Ltd"];
const INDUSTRIES = ["Retail", "Manufacturing", "Food & Beverage", "3PL", "Wholesale", "E-commerce",
  "Healthcare", "Automotive", "Apparel", "Consumer Goods"];

const usedNames = new Set<string>();
function companyName(country: string) {
  for (;;) {
    const n = `${pick(A)} ${pick(B)}${chance(0.5) ? " " + pick(SUF) : ""}`;
    if (!usedNames.has(n)) { usedNames.add(n); return n; }
  }
}

// ------------------------------------------------------------ fiscal logic
// FY starts Feb 1; FY is named for the year it ENDS. FY27 = 2026-02-01 .. 2027-01-31
function fyQuarter(label: string) {
  const [fy, q] = label.split("-"); // "FY27-Q3"
  const endYear = 2000 + parseInt(fy.slice(2));
  const qi = parseInt(q.slice(1));
  const start = new Date(Date.UTC(endYear - 1, 1 + (qi - 1) * 3, 1));
  const end = addDays(new Date(Date.UTC(endYear - 1, 1 + qi * 3, 1)), -1);
  return { start, end };
}

// -------------------------------------------------------------------- main
async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes("localhost") ||
         process.env.DATABASE_URL?.includes("127.0.0.1")
      ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();

  console.log("Clearing old data...");
  await client.query(`truncate product_usage_monthly, contracts, opportunities,
                      accounts, users, dated_conversion_rates restart identity cascade`);

  // ---------------------------------------------------------------- FX
  const FX: Record<string, [string, string, number][]> = {
    USD: [["2024-02-01", "2027-02-01", 1.0]],
    CAD: [["2024-02-01", "2025-02-01", 1.35], ["2025-02-01", "2026-02-01", 1.38], ["2026-02-01", "2027-02-01", 1.36]],
    GBP: [["2024-02-01", "2025-02-01", 0.79], ["2025-02-01", "2026-02-01", 0.78], ["2026-02-01", "2027-02-01", 0.75]],
  };
  for (const [code, rows] of Object.entries(FX))
    for (const [s, e, r] of rows)
      await client.query(
        `insert into dated_conversion_rates values ($1,$2,$3,$4)`, [code, s, e, r]);
  const rateAt = (code: string, d: Date) => {
    const row = FX[code].find(([s, e]) => iso(d) >= s && iso(d) < e);
    return row ? row[2] : FX[code][FX[code].length - 1][2];
  };
  const toUSD = (amt: number, code: string, d: Date) => amt / rateAt(code, d);

  // -------------------------------------------------------------- users
  const users: any[] = [];
  const FIRST = ["Priya", "Marcus", "Dana", "Tobias", "Elena", "Ryan", "Noor", "Caleb", "Imani",
    "Sofia", "Hugh", "Lena", "Omar", "Grace", "Devon", "Rosa"];
  const LAST = ["Raman", "Okafor", "Bell", "Lindqvist", "Moreau", "Tran", "Haddad", "Wright",
    "Boyd", "Ferrari", "Castillo", "Nakamura", "Osei", "Doyle", "Petrov", "Quinn"];
  for (let i = 0; i < 16; i++) {
    const name = `${FIRST[i]} ${LAST[i]}`;
    const role = i < 9 ? "AE" : i < 12 ? "SDR" : i < 15 ? "CSM" : "Manager";
    users.push({
      id: `005${String(i).padStart(3, "0")}`,
      name,
      email: name.toLowerCase().replace(" ", ".") + "@parcelwise.com",
      role,
      // TRAP: team is current-only. Reps 3 and 6 moved Commercial -> Enterprise in FY26,
      // so their FY25 deals sit under the wrong team if you join on users.team.
      team: i === 3 || i === 6 ? "Enterprise" : pick(["Commercial", "Mid-Market", "Enterprise"]),
      region: i % 5 === 0 ? "UK" : "NA",
      // TRAP: 2 departed reps still own open pipeline
      is_active: !(i === 5 || i === 10),
    });
  }
  for (const u of users)
    await client.query(
      `insert into users (id,name,email,role,team,region,is_active) values ($1,$2,$3,$4,$5,$6,$7)`,
      [u.id, u.name, u.email, u.role, u.team, u.region, u.is_active]);
  const aes = users.filter(u => u.role === "AE");

  // ----------------------------------------------------------- accounts
  type Acct = {
    id: string; name: string; type: string; parent: string | null; country: string;
    cur: string; employees: number; ownerId: string; industry: string;
    plan: "customer" | "churned" | "prospect" | "pilot" | "test" | "dupe";
    arrUSD: number; arrLocal: number; startDate?: Date; endDate?: Date;
    firstWonDate?: Date; expansions: { date: Date; arrLocal: number }[];
    renewals: { date: Date; arrLocal: number }[]; wasCustomerAtMigration: boolean;
  };
  const accounts: Acct[] = [];
  let accSeq = 0;
  const newId = () => `001${String(accSeq++).padStart(4, "0")}`;

  function makeAccount(plan: Acct["plan"], parent: string | null = null): Acct {
    const country = chance(0.6) ? "US" : chance(0.25) ? "CA" : "GB";
    const cur = country === "US" ? "USD" : country === "CA" ? "CAD" : "GBP";
    const employees = chance(0.45) ? int(15, 200) : chance(0.6) ? int(200, 1200) : int(1200, 9000);
    return {
      id: newId(), name: companyName(country), type: "Customer", parent, country, cur,
      employees, ownerId: pick(aes).id, industry: pick(INDUSTRIES), plan,
      arrUSD: 0, arrLocal: 0, expansions: [], renewals: [], wasCustomerAtMigration: false,
    };
  }

  // 120 current customers, 22 churned, 30 prospects, 10 pilots (usage, no contract)
  const counts = { customer: 117, churned: 22, prospect: 30, pilot: 10 } as const;
  for (const [plan, n] of Object.entries(counts))
    for (let i = 0; i < n; i++) accounts.push(makeAccount(plan as Acct["plan"]));

  // 12 subsidiaries of existing customers (TRAP: must roll up to parent)
  const parents = accounts.filter(a => a.plan === "customer").slice(0, 12);
  for (const p of parents) {
    const sub = makeAccount("customer", p.id);
    sub.name = `${p.name.split(" ").slice(0, 2).join(" ")} ${pick(["UK", "Canada", "West", "Europe"])}`;
    sub.cur = p.cur; sub.country = p.country;
    accounts.push(sub);
  }
  // 6 test accounts + 8 soft-deleted duplicates (TRAP: hygiene)
  for (let i = 0; i < 6; i++) {
    const t = makeAccount("test");
    t.type = "Test";
    t.name = chance(0.5) ? `ZZ Sandbox ${i}` : `${t.name} DO NOT USE`;
    accounts.push(t);
  }
  const dupeSources = accounts.filter(a => a.plan === "customer").slice(20, 28);
  for (const s of dupeSources) {
    const d = makeAccount("dupe");
    d.name = s.name; d.cur = s.cur; d.country = s.country;
    accounts.push(d);
  }

  // ---- assign contract economics
  for (const a of accounts) {
    if (a.plan === "customer" || a.plan === "churned") {
      // ARR band, chosen independently of employee count so legacy segment disagrees
      const band = chance(0.5) ? int(8000, 49000) : chance(0.62) ? int(50000, 249000) : int(250000, 900000);
      a.arrUSD = band;
      a.arrLocal = Math.round(band * rateAt(a.cur, TODAY) / 100) * 100;
      const firstWon = addDays(new Date("2024-03-01"), int(0, 800));
      a.firstWonDate = firstWon;
      const termMonths = chance(0.75) ? 12 : chance(0.6) ? 24 : 36;

      if (a.plan === "customer") {
        // walk terms forward until the contract covers today
        let start = firstWon;
        let end = addDays(addMonths(start, termMonths), -1);
        while (end < TODAY) {
          const renewalDate = addDays(end, 1);
          a.renewals.push({ date: renewalDate, arrLocal: a.arrLocal });
          start = renewalDate;
          end = addDays(addMonths(start, 12), -1);
        }
        a.startDate = start; a.endDate = end;
        if (chance(0.3)) {
          const d = addDays(firstWon, int(120, 500));
          if (d < TODAY) a.expansions.push({ date: d, arrLocal: Math.round(a.arrLocal * 0.25 / 100) * 100 });
        }
      } else {
        // churned: contract ended before today, no renewal
        const end = addDays(TODAY, -int(20, 400));
        a.endDate = end;
        a.startDate = addMonths(end, -termMonths);
        a.firstWonDate = a.startDate;
      }
      a.wasCustomerAtMigration = a.firstWonDate! < MIGRATION &&
        (a.plan === "customer" || a.endDate! > MIGRATION);
    }
  }

  // ---- write accounts, with legacy fields frozen at migration date
  const segByEmployees = (n: number) => (n < 250 ? "SMB" : n < 2000 ? "MM" : "ENT");
  const segByArr = (usd: number) => (usd < 50000 ? "Commercial" : usd <= 250000 ? "Mid-Market" : "Enterprise");

  for (const a of accounts) {
    const isCustomerNow = a.plan === "customer";
    const type = a.type === "Test" ? "Test"
      : isCustomerNow || a.plan === "churned" ? "Customer"
      : a.plan === "dupe" ? "Customer" : "Prospect";

    // TRAP: customer_status__c is hand-typed and ~15% wrong
    let status = isCustomerNow ? "Active" : a.plan === "churned" ? "Churned" : "Prospect";
    if (chance(0.15)) status = pick(["Active", "At Risk", "Churned", "Prospect"]);

    // TRAP: is_active__c and total_arr__c froze at the migration
    const legacyActive = a.wasCustomerAtMigration;
    const legacyArr = a.wasCustomerAtMigration ? a.arrLocal : null; // local currency, unconverted

    // TRAP: sales_segment__c (ARR bands) vs segment__c (employee bands)
    const salesSeg = a.arrUSD > 0 ? segByArr(a.arrUSD) : segByArr(a.employees * 120);

    await client.query(
      `insert into accounts (id,name,type,parent_account_id,industry,employee_count,billing_country,
        owner_id,segment__c,sales_segment__c,customer_status__c,is_active__c,total_arr__c,
        csm_health_score__c,created_date,is_deleted,website,annual_revenue,account_source,rating,
        chargebee_customer_id__c,stripe_customer_id__c,nps_score__c,last_qbr_date__c)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [a.id, a.name, type, a.parent, a.industry, a.employees, a.country, a.ownerId,
       segByEmployees(a.employees), salesSeg, status, legacyActive, legacyArr,
       int(30, 95), iso(a.firstWonDate ?? addDays(TODAY, -int(60, 900))),
       a.plan === "dupe",
       `www.${a.name.toLowerCase().replace(/[^a-z]/g, "")}.com`, a.employees * 140000,
       pick(["Inbound", "Outbound", "Partner", "Event"]), pick(["Hot", "Warm", "Cold"]),
       `cb_${a.id}`, a.wasCustomerAtMigration ? null : `cus_${a.id}`, int(3, 10),
       iso(addDays(TODAY, -int(10, 200)))]);
  }

  // ------------------------------------------------ opportunities + contracts
  let oppSeq = 0, conSeq = 0;
  const newOppId = () => `006${String(oppSeq++).padStart(4, "0")}`;
  const newConId = () => `800${String(conSeq++).padStart(4, "0")}`;

  async function writeOpp(a: Acct, o: {
    type: string; won: boolean | null; arrLocal: number; closeDate: Date; term: number;
    forecast?: string;
  }) {
    const id = newOppId();
    const closed = o.won !== null;
    const legacyStage = closed && o.closeDate < new Date("2025-09-01") && chance(0.55);
    const stage = !closed
      ? pick(["Discovery", "Demo", "Proposal", "Negotiation"])
      : o.won ? (legacyStage ? "Closed - Won (Legacy)" : "Closed Won")
              : (legacyStage ? "Closed - Lost (Legacy)" : "Closed Lost");
    // TRAP: amount is TCV (full multi-year term); arr__c is annualized
    const amount = Math.round(o.arrLocal * (o.term / 12));
    await client.query(
      `insert into opportunities (id,account_id,name,type,stage_name,is_closed,is_won,amount,arr__c,
        currency_iso_code,term_months,close_date,forecast_category,owner_id,created_date,is_deleted,
        lead_source,probability,competitor__c,legacy_booking_amount__c,gong_deal_score__c,next_step)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [id, a.id, `${a.name} - ${o.type}`, o.type, stage, closed, closed ? o.won : false,
       amount, o.arrLocal, a.cur, o.term, iso(o.closeDate),
       closed ? "Closed" : (o.forecast ?? pick(["Pipeline", "Best Case", "Commit"])),
       a.ownerId, iso(addDays(o.closeDate, -int(30, 120))), false,
       pick(["Inbound", "Outbound", "Partner", "Event"]), closed ? (o.won ? 100 : 0) : int(20, 80),
       pick(["Flexport", "Project44", "In-house", "None"]),
       o.closeDate < MIGRATION ? amount : null, int(40, 95),
       closed ? null : "Follow up"]);
    return id;
  }

  for (const a of accounts) {
    if (a.type === "Test" || a.plan === "dupe") continue;

    if (a.plan === "customer" || a.plan === "churned") {
      const termMonths = Math.max(12,
        Math.round((a.endDate!.getTime() - a.startDate!.getTime()) / 864e5 / 30));
      // initial land
      const landOpp = await writeOpp(a, {
        type: "New Business", won: true, arrLocal: a.arrLocal,
        closeDate: a.firstWonDate!, term: a.renewals.length ? 12 : Math.min(termMonths, 36),
      });
      // expansions (TRAP: 'Upsell' is a legacy synonym for 'Expansion')
      for (const e of a.expansions)
        await writeOpp(a, {
          type: chance(0.35) ? "Upsell" : "Expansion", won: true,
          arrLocal: e.arrLocal, closeDate: e.date, term: 12,
        });
      // renewals (TRAP: arr__c carries the FULL renewed amount)
      for (const r of a.renewals)
        await writeOpp(a, { type: "Renewal", won: true, arrLocal: r.arrLocal, closeDate: r.date, term: 12 });

      // contract: source of truth. Only for current customers.
      if (a.plan === "customer") {
        const total = a.arrLocal + a.expansions.reduce((s, e) => s + e.arrLocal, 0);
        await client.query(
          `insert into contracts (id,account_id,opportunity_id,status,start_date,end_date,arr,
            currency_iso_code,auto_renew) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [newConId(), a.id, landOpp, "Activated", iso(a.startDate!), iso(a.endDate!),
           total, a.cur, chance(0.7)]);
      } else {
        await client.query(
          `insert into contracts (id,account_id,opportunity_id,status,start_date,end_date,arr,
            currency_iso_code,auto_renew) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [newConId(), a.id, landOpp, "Expired", iso(a.startDate!), iso(a.endDate!),
           a.arrLocal, a.cur, false]);
      }
      // TRAP: a few Draft / Cancelled contracts that must NOT count
      if (chance(0.12)) {
        const s = addDays(TODAY, int(10, 60));
        await client.query(
          `insert into contracts (id,account_id,opportunity_id,status,start_date,end_date,arr,
            currency_iso_code,auto_renew) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [newConId(), a.id, null, chance(0.5) ? "Draft" : "Cancelled", iso(s),
           iso(addMonths(s, 12)), Math.round(a.arrLocal * 0.4), a.cur, false]);
      }
    }

    // open pipeline for prospects, pilots and some customers
    const openCount = a.plan === "prospect" ? int(1, 2) : a.plan === "pilot" ? 1 : chance(0.35) ? 1 : 0;
    for (let i = 0; i < openCount; i++) {
      const cd = addDays(TODAY, int(-25, 150));
      const base = a.arrUSD || int(12000, 300000);
      await writeOpp(a, {
        type: a.plan === "customer" ? pick(["Expansion", "Upsell"]) : "New Business",
        won: null,
        arrLocal: Math.round(base * rateAt(a.cur, cd) / 500) * 500,
        closeDate: cd, term: chance(0.8) ? 12 : 24,
        forecast: chance(0.08) ? "Omitted" : pick(["Pipeline", "Pipeline", "Best Case", "Commit"]),
      });
    }
    // lost deals for realism
    if (chance(0.4))
      await writeOpp(a, {
        type: "New Business", won: false,
        arrLocal: int(10000, 200000), closeDate: addDays(TODAY, -int(30, 700)), term: 12,
      });
  }

  // -------------------------------------------------------------- usage
  for (const a of accounts) {
    if (a.type === "Test" || a.plan === "dupe" || a.plan === "prospect") continue;
    const seats = a.arrUSD > 0 ? Math.max(5, Math.round(a.arrUSD / 1800)) : int(3, 25);
    for (let m = 11; m >= 0; m--) {
      const month = new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth() - m, 1));
      let active: number;
      if (a.plan === "pilot") active = int(2, 20);                       // TRAP: usage, no contract
      else if (a.plan === "churned") active = month < a.endDate! ? int(1, seats) : 0;
      else active = chance(0.12) ? 0 : int(Math.ceil(seats * 0.2), seats); // TRAP: paying, no usage
      await client.query(
        `insert into product_usage_monthly values ($1,$2,$3,$4)`,
        [a.id, iso(month), active, seats]);
    }
  }

  // ------------------------------------------------------- ANSWER KEY
  const fxJoin = `
    left join lateral (
      select conversion_rate from dated_conversion_rates r
      where r.iso_code = $CUR and $DATE >= r.start_date and $DATE < r.next_start_date
      limit 1
    ) fx on true`;

  const q = async (label: string, sql: string, params: any[] = []) => {
    const r = await client.query(sql, params);
    const v = Object.values(r.rows[0])[0];
    const n = typeof v === "string" ? parseFloat(v) : v;
    console.log(`  ${label.padEnd(52)} ${typeof n === "number" ? Math.round(n).toLocaleString() : n}`);
    return n as number;
  };

  const CUSTOMER_BASE = `
    from contracts c
    join accounts a on a.id = c.account_id
    left join accounts p on p.id = a.parent_account_id
    where c.status not in ('Draft','Cancelled')
      and current_date between c.start_date and c.end_date
      and a.is_deleted = false and a.type <> 'Test' and a.name not like '%DO NOT USE%'
      and coalesce(p.is_deleted,false) = false`;

  console.log("\n================= ANSWER KEY (verified against the DB) =================");
  console.log("\n-- Customers --");
  await q("CORRECT: customers (parent-level, active contract)",
    `select count(distinct coalesce(a.parent_account_id, a.id)) ${CUSTOMER_BASE}`);
  await q("  wrong if you don't roll subsidiaries to parent",
    `select count(distinct a.id) ${CUSTOMER_BASE}`);
  await q("  wrong via is_active__c (frozen Mar 2025)",
    `select count(*) from accounts where is_active__c = true`);
  await q("  wrong via customer_status__c (hand-typed)",
    `select count(*) from accounts where customer_status__c = 'Active'`);
  await q("  wrong via product usage (CS definition)",
    `select count(*) from product_usage_monthly u where u.month =
       date_trunc('month', current_date - interval '1 month')::date and u.active_users > 0`);

  console.log("\n-- ARR --");
  await q("CORRECT: total ARR, USD",
    `select sum(c.arr / fx.conversion_rate) ${CUSTOMER_BASE.replace("from contracts c",
      `from contracts c ${fxJoin.replace("$CUR", "c.currency_iso_code").replace(/\$DATE/g, "current_date")}`)}`);
  await q("  wrong: ignoring currency conversion",
    `select sum(c.arr) ${CUSTOMER_BASE}`);
  await q("  wrong: legacy accounts.total_arr__c rollup",
    `select sum(total_arr__c) from accounts where is_deleted = false`);
  await q("  wrong: summing opportunities.amount (TCV)",
    `select sum(amount) from opportunities where is_won = true`);

  console.log("\n-- New ARR, FY27 Q2 (May 1 - Jul 31 2026) --");
  const { start: q2s, end: q2e } = fyQuarter("FY27-Q2");
  const NEWARR = (s: Date, e: Date) => ({
    sql: `select sum(o.arr__c / fx.conversion_rate)
          from opportunities o
          join accounts a on a.id = o.account_id
          ${fxJoin.replace("$CUR", "o.currency_iso_code").replace(/\$DATE/g, "o.close_date")}
          where o.is_won = true and o.is_deleted = false
            and o.type in ('New Business','Expansion','Upsell')
            and o.close_date between $1 and $2
            and a.is_deleted = false and a.type <> 'Test' and a.name not like '%DO NOT USE%'`,
    p: [iso(s), iso(e)],
  });
  const na = NEWARR(q2s, q2e);
  await q("CORRECT: new ARR (USD, excl. renewals)", na.sql, na.p);
  await q("  wrong: including Renewal deals",
    na.sql.replace("o.type in ('New Business','Expansion','Upsell')",
      "o.type in ('New Business','Expansion','Upsell','Renewal')"), na.p);
  await q("  wrong: calendar Q2 (Apr-Jun) instead of fiscal",
    na.sql, ["2026-04-01", "2026-06-30"]);
  await q("  wrong: filtering stage_name = 'Closed Won'",
    na.sql.replace("o.is_won = true", "o.stage_name = 'Closed Won'"), na.p);

  console.log("\n-- New ARR, FY26 full year (Feb 2025 - Jan 2026) --");
  const fy26 = { s: new Date("2025-02-01"), e: new Date("2026-01-31") };
  const na26 = NEWARR(fy26.s, fy26.e);
  await q("CORRECT: FY26 new ARR (USD)", na26.sql, na26.p);
  await q("  wrong: filtering stage_name = 'Closed Won'",
    na26.sql.replace("o.is_won = true", "o.stage_name = 'Closed Won'"), na26.p);

  console.log("\n-- Renewals & churn --");
  await q("CORRECT: contracts expiring FY27-Q4",
    `select count(*) ${CUSTOMER_BASE} and c.end_date between $1 and $2`,
    [iso(fyQuarter("FY27-Q4").start), iso(fyQuarter("FY27-Q4").end)]);
  await q("CORRECT: logo churn, trailing 12 months",
    `select count(distinct coalesce(a.parent_account_id, a.id))
     from contracts c join accounts a on a.id = c.account_id
     where c.status = 'Expired' and c.end_date between current_date - 365 and current_date
       and a.is_deleted = false and a.type <> 'Test'
       and not exists (select 1 from contracts c2 where c2.account_id = c.account_id
         and c2.status not in ('Draft','Cancelled') and c2.end_date > c.end_date + 60)`);
  await q("CORRECT: revenue churn, trailing 12 months (USD)",
    `select coalesce(sum(c.arr / fx.conversion_rate),0)
     from contracts c join accounts a on a.id = c.account_id
     ${fxJoin.replace("$CUR","c.currency_iso_code").replace(/\$DATE/g,"c.end_date")}
     where c.status = 'Expired' and c.end_date between current_date - 365 and current_date
       and a.is_deleted = false and a.type <> 'Test'
       and not exists (select 1 from contracts c2 where c2.account_id = c.account_id
         and c2.status not in ('Draft','Cancelled') and c2.end_date > c.end_date + 60)`);

  console.log("\n-- Pipeline, FY27 Q4 (Nov 1 2026 - Jan 31 2027) --");
  const { start: q4s, end: q4e } = fyQuarter("FY27-Q4");
  await q("CORRECT: open pipeline ARR (USD, excl. Omitted)",
    `select coalesce(sum(o.arr__c / fx.conversion_rate),0)
     from opportunities o join accounts a on a.id = o.account_id
     ${fxJoin.replace("$CUR", "o.currency_iso_code").replace(/\$DATE/g, "o.close_date")}
     where o.is_closed = false and o.forecast_category <> 'Omitted'
       and o.type in ('New Business','Expansion','Upsell')
       and o.close_date between $1 and $2
       and a.is_deleted = false and a.type <> 'Test'`, [iso(q4s), iso(q4e)]);

  console.log("\n-- Segments (current customers) --");
  const segs = await client.query(
    `select seg, count(*) n from (
       select distinct coalesce(a.parent_account_id, a.id) pid,
              coalesce(p.sales_segment__c, a.sales_segment__c) seg
       ${CUSTOMER_BASE}) t group by 1 order by 1`);
  for (const r of segs.rows) console.log(`  ${("CORRECT: " + r.seg).padEnd(52)} ${r.n}`);
  const legacy = await client.query(
    `select seg, count(*) n from (
       select distinct coalesce(a.parent_account_id, a.id) pid,
              coalesce(p.segment__c, a.segment__c) seg
       ${CUSTOMER_BASE}) t group by 1 order by 1`);
  for (const r of legacy.rows) console.log(`  ${("  legacy segment__c: " + r.seg).padEnd(52)} ${r.n}`);

  console.log("\n-- Hygiene --");
  await q("test accounts planted", `select count(*) from accounts where type='Test' or name like '%DO NOT USE%'`);
  await q("soft-deleted duplicates planted", `select count(*) from accounts where is_deleted = true`);
  await q("subsidiaries planted", `select count(*) from accounts where parent_account_id is not null`);
  await q("Draft/Cancelled contracts planted", `select count(*) from contracts where status in ('Draft','Cancelled')`);
  await q("legacy stage-name deals planted", `select count(*) from opportunities where stage_name like '%Legacy%'`);

  console.log("\n-- Row counts --");
  for (const t of ["users", "accounts", "opportunities", "contracts", "product_usage_monthly"])
    await q(t, `select count(*) from ${t}`);

  console.log("\n=======================================================================\n");
  await client.end();
}

main().catch(e => { console.error(e); process.exit(1); });
