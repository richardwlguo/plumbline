# Parcelwise Cheat Sheet

The official meaning of every business word at Parcelwise.
If a question uses one of these words, this is what it means. No exceptions.

Each definition has two parts:
- **Plain English:** what a person would say
- **In the database:** exactly where the answer lives (used later when we write code)

---

## Background facts

- **Today's date:** September 11, 2026
- **Reporting currency:** US dollars. All money answers are in USD.
- **Our year doesn't start in January.** Parcelwise's fiscal year starts **February 1** and is named after the year it ends:

| Period | Dates |
|---|---|
| FY27 (this year) | Feb 1, 2026 – Jan 31, 2027 |
| FY27 Q1 | Feb 1 – Apr 30, 2026 |
| FY27 Q2 | May 1 – Jul 31, 2026 |
| **FY27 Q3 (this quarter)** | **Aug 1 – Oct 31, 2026** |
| FY27 Q4 | Nov 1, 2026 – Jan 31, 2027 |

- **We switched billing systems** (Chargebee to Stripe) on March 1, 2025. Some old fields stopped updating that day.

---

## 1. Customer

**Plain English:** A company that is paying us right now under a signed contract.
Subsidiaries (e.g. "Acme UK" under "Acme Inc") count as **one** customer, the parent.

**In the database:** A parent account with at least one contract where:
- status is **not** `Draft` or `Cancelled`, and
- today falls between `start_date` and `end_date`.

Subsidiary contracts roll up to the parent. Apply the "Always ignore" rules below.

**Default:** If someone just says "customers" or "active customers," use this definition, and say so in the answer.

## 2. Product-active account

**Plain English:** A company whose people actually used the product last month. This is the Customer Success team's view. **It is not the same as a customer.** Some paying customers never log in, and some free pilots log in but don't pay.

**In the database:** `product_usage_monthly.active_users > 0` for the most recent full month (August 2026).

**Only use this** when the question specifically says "using the product," "logging in," or "engaged."

## 3. ARR (Annual Recurring Revenue)

**Plain English:** How much money per year our current contracts are worth.

**In the database:** Add up `contracts.arr` for every contract that counts toward "Customer" (see #1), converted to USD.

**Never** use `accounts.total_arr__c` (frozen since March 2025) or `opportunities.amount` (multi-year totals, not yearly).

## 4. New ARR

**Plain English:** New yearly revenue we won in a period, from brand-new customers plus existing customers buying more. **Renewals are not new ARR.** A renewal just keeps money we already had.

**In the database:** Won deals (`is_won = true`) that closed in the period, where type is `New Business`, `Expansion`, or `Upsell`. Use `arr__c`, converted to USD.
(`Upsell` is an old name for `Expansion`. They mean the same thing.)

## 5. Renewals

**Plain English:** Existing customers signing up for another term.

**In the database:** Deals where type is `Renewal`. Their `arr__c` is the **full** renewed amount, not the extra amount. Never add it to New ARR.

## 6. Pipeline

**Plain English:** Deals we're still working on that are expected to close in a period, measured in yearly value.

**In the database:** Deals that are **not closed**, with `close_date` in the period, forecast category **not** `Omitted`, type `New Business`, `Expansion`, or `Upsell`. Sum `arr__c` in USD.

Renewal deals are **not** pipeline unless the question says "renewal pipeline."

## 7. Segment

**Plain English:** How big a customer is, based on how much they pay us per year:

| Segment | ARR |
|---|---|
| Commercial | under $50k |
| Mid-Market | $50k – $250k |
| Enterprise | over $250k |

**In the database:** Use `sales_segment__c`. **Never** use `segment__c`. That's the old system based on employee count, which we stopped using in FY26.

## 8. Won deal

**Plain English:** A deal we closed successfully.

**In the database:** `is_won = true`. **Do not** go by `stage_name`, because old deals use outdated stage names like "Closed - Won (Legacy)."

## 9. Churn: always ask which kind

**Plain English:** Customers we lost. There are two versions, and they give different answers:
- **Logo churn:** *how many* customers we lost (a count).
- **Revenue churn:** *how much ARR* we lost (dollars).

**Rule:** If a question says "churn" without saying which, **ask**. Don't guess.

**In the database:** For a period, take everyone who was a Customer on the first day and isn't one on the last day.
- Logo churn counts them.
- Revenue churn adds up their ARR from the first day.

---

## Always ignore (in every answer)

- Accounts where `is_deleted = true` (duplicates)
- Accounts where type is `Test`, or the name contains "DO NOT USE"
- Deals where `is_deleted = true`

## Fields that look official but are wrong. Never use them.

| Field | Why it's wrong |
|---|---|
| `accounts.total_arr__c` ("Total ARR") | Stopped updating March 2025 |
| `accounts.is_active__c` ("Active") | Stopped updating March 2025 |
| `accounts.customer_status__c` ("Customer Status") | Typed in by hand, often wrong |
| `accounts.segment__c` ("Segment") | Old segment system |
| `opportunities.amount` ("Amount") | Total over all contract years, not yearly |
| `opportunities.legacy_booking_amount__c` ("Booking Amount") | From the old billing system |

## When to ask vs. when to assume

- **The cheat sheet answers it** → answer, and state which definition you used.
  *Example: "117 customers (companies with an active contract, counted at parent level)."*
- **The question could mean two different things, and the cheat sheet doesn't decide** → ask one short question.
  *Examples: "How much churn did we have?" (count or dollars?) · "How big is Enterprise?" (number of customers or ARR?)*
