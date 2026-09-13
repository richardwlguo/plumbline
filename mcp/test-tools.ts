import { dispatch, db } from "../mcp/server";

const CASES: [string, string, any, number | null][] = [
  ["C1", "count_opportunities", { state: "open" }, 101],
  ["C2", "count_users", { role: "AE" }, 9],
  ["C3", "count_accounts", { billing_country: "GB" }, 61],
  ["C4", "get_contract_facts", { metric: "max_arr" }, 1160000],
  ["C5", "count_accounts", { filter: "health_score_below", threshold: 50 }, 66],
  ["C6", "get_contract_facts", { metric: "auto_renew_count" }, 97],
  ["D1", "count_customers", {}, 117],
  ["D2", "get_arr", { aggregate: "total" }, 21449906],
  ["D3", "count_customers", {}, 117],
  ["D4", "get_new_arr", { period: "FY27-Q2" }, 1071295],
  ["D5", "get_new_arr", { period: "FY27", expansion_only: true, to_date: true }, 583742],
  ["D6", "get_new_arr", { period: "FY26" }, 12756361],
  ["D7", "count_customers", { segment: "Enterprise" }, 15],
  ["D8", "get_won_deal_totals", { basis: "arr" }, 30999400],
  ["D9", "get_arr", { region: "non_us" }, 12127706],
  ["D10", "count_accounts", { filter: "product_active_without_contract" }, 12],
  ["D11", "count_accounts", { filter: "all_real" }, 191],
  ["D12", "get_contract_facts", { metric: "in_force_count" }, 129],
  ["F1", "get_new_arr", { period: "FY27-Q3", to_date: true }, 231186],
  ["F2", "get_new_arr", { period: "FY27-Q1" }, 2234100],
  ["F3", "get_renewals", { period: "FY27-Q4" }, 26],
  ["F4", "get_pipeline", { period: "FY27-Q4" }, 6755583],
  ["M1", "get_arr", { aggregate: "average_per_customer", segment: "Mid-Market" }, 205847],
  ["M2", "count_customers", { product_usage: "zero_last_month" }, 11],
  ["M3", "get_pipeline", { period: "FY27-Q4", owner_status: "inactive_owner" }, null],
  ["M4", "get_churn", { basis: "logo" }, 17],
  ["A1-refuse", "get_churn", {}, null],
  ["A2-refuse", "get_segment_breakdown", {}, null],
  ["A4-refuse", "get_won_deal_totals", {}, null],
  ["bad-period", "get_new_arr", { period: "Q2 2026" }, null],
];

(async () => {
  await db.connect();
  let pass = 0, fail = 0;
  for (const [id, tool, args, expected] of CASES) {
    try {
      const out = await dispatch(tool, args);
      const v = Math.round(out.value);
      if (expected === null) {
        console.log(`${id.padEnd(12)} ran (no expectation) -> ${v}`);
      } else if (Math.abs(v - expected) <= Math.max(1, Math.abs(expected) * 0.0001)) {
        console.log(`${id.padEnd(12)} ✓ ${v.toLocaleString()}`); pass++;
      } else {
        console.log(`${id.padEnd(12)} ✗ got ${v.toLocaleString()} want ${expected.toLocaleString()}`); fail++;
      }
    } catch (e: any) {
      if (expected === null && (id.includes("refuse") || id.includes("bad"))) {
        console.log(`${id.padEnd(12)} ✓ refused: ${e.message.slice(0, 60)}...`); pass++;
      } else {
        console.log(`${id.padEnd(12)} ✗ threw: ${e.message.slice(0, 90)}`); fail++;
      }
    }
  }
  console.log(`\n${pass} pass, ${fail} fail`);
  await db.end();
})();
