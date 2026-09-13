-- =====================================================================
-- Mini-Checkr: Parcelwise RevOps sandbox (Salesforce-shaped, deliberately messy)
-- Trap notes live in "--" comments. STRIP THESE before showing the schema
-- to the baseline. The baseline only sees table/column names + the
-- COMMENT ON labels at the bottom (which mimic real SFDC field labels).
-- Fiscal year starts Feb 1. FY is named by the year it ENDS (FY27 = Feb 2026–Jan 2027).
-- Billing migrated Chargebee -> Stripe on 2025-03-01. Resegmentation effective FY26.
-- =====================================================================

create table users (
  id            text primary key,
  name          text not null,
  email         text,
  role          text,        -- 'AE','SDR','CSM','Manager'
  team          text,        -- CURRENT team only, no history. TRAP: 2 reps moved Commercial -> Enterprise mid-FY26
  region        text,        -- 'NA','UK'
  is_active     boolean default true   -- TRAP: departed reps still own open opps
);

create table accounts (
  id                   text primary key,
  name                 text not null,
  type                 text,   -- 'Customer','Prospect','Partner','Test'. TRAP: Test/sandbox accts, some also named '%DO NOT USE%'
  parent_account_id    text references accounts(id),  -- TRAP: subsidiaries. Customers are counted at the PARENT level
  industry             text,
  employee_count       int,
  billing_country      text,   -- 'US','CA','GB'
  owner_id             text references users(id),
  segment__c           text,   -- LEGACY (pre-FY26): SMB/MM/ENT by employee count. Still populated, never cleared. TRAP
  sales_segment__c     text,   -- CURRENT (FY26+): Commercial/Mid-Market/Enterprise by contracted ARR band
  customer_status__c   text,   -- manual CSM picklist: 'Active','At Risk','Churned','Prospect'. ~15% wrong. TRAP
  is_active__c         boolean,-- LEGACY Chargebee sync flag. Frozen since 2025-03-01. TRAP
  total_arr__c         numeric,-- LEGACY Chargebee rollup. Frozen since 2025-03-01, mixed currencies. TRAP
  csm_health_score__c  int,
  created_date         timestamptz,
  is_deleted           boolean default false,  -- TRAP: soft-deleted duplicate accounts
  -- bloat: real SFDC objects are wide. These exist to make raw-schema context honestly expensive.
  website text, phone text, description text, account_source text, rating text, ownership text,
  sic_code text, ticker_symbol text, annual_revenue numeric, number_of_locations__c int,
  mkto_lead_score__c int, mkto_acquisition_program__c text, hubspot_id__c text, zoominfo_id__c text,
  gong_last_call__c date, outreach_sequence__c text, g2_intent_score__c int, clearbit_tech__c text,
  netsuite_id__c text, chargebee_customer_id__c text, stripe_customer_id__c text,
  partner_tier__c text, referral_source__c text, last_qbr_date__c date, nps_score__c int
);

create table opportunities (
  id                 text primary key,
  account_id         text references accounts(id),
  name               text,
  type               text,     -- 'New Business','Expansion','Upsell','Renewal'. TRAP: 'Upsell' = legacy synonym for Expansion
  stage_name         text,     -- current + legacy names, e.g. 'Closed Won' and 'Closed - Won (Legacy)'. TRAP
  is_closed          boolean,
  is_won             boolean,  -- reliable; use this, not stage_name
  amount             numeric,  -- TCV in opp currency. Multi-year deals = full term value. TRAP
  arr__c             numeric,  -- annualized, opp currency. Renewals carry FULL renewed ARR, not incremental. TRAP
  currency_iso_code  text,     -- 'USD','CAD','GBP'. TRAP
  term_months        int,
  close_date         date,
  forecast_category  text,     -- 'Pipeline','Best Case','Commit','Closed','Omitted'
  owner_id           text references users(id),
  created_date       timestamptz,
  is_deleted         boolean default false,
  -- bloat
  lead_source text, next_step text, description text, probability int, competitor__c text,
  loss_reason__c text, champion__c text, economic_buyer__c text, mutual_action_plan__c text,
  gong_deal_score__c int, legal_status__c text, security_review__c text, po_number__c text,
  legacy_booking_amount__c numeric   -- TRAP: old Chargebee booking value, looks like a "bookings" field
);

create table contracts (          -- SOURCE OF TRUTH for ARR and "customer" (Stripe-synced since 2025-03-01)
  id                 text primary key,
  account_id         text references accounts(id),
  opportunity_id     text references opportunities(id),
  status             text,        -- 'Draft','Activated','Expired','Cancelled'. Exclude Draft + Cancelled
  start_date         date,
  end_date           date,
  arr                numeric,     -- contract currency
  currency_iso_code  text,
  auto_renew         boolean
);

create table dated_conversion_rates (   -- SFDC-style corporate FX. rate = units of iso_code per 1 USD
  iso_code         text,
  start_date       date,
  next_start_date  date,
  conversion_rate  numeric
);

create table product_usage_monthly (    -- product analytics export (CS's notion of "active")
  account_id       text references accounts(id),
  month            date,               -- first of month
  active_users     int,
  seats_purchased  int                 -- TRAP: pilots/free trials have usage but no contract
);

-- ---------------------------------------------------------------------
-- Field labels the BASELINE sees (mimics SFDC). Note how the legacy
-- fields get the most authoritative-sounding labels. That's the point.
-- ---------------------------------------------------------------------
comment on column accounts.total_arr__c        is 'Total ARR';
comment on column accounts.is_active__c        is 'Active';
comment on column accounts.segment__c          is 'Segment';
comment on column accounts.sales_segment__c    is 'Sales Segment';
comment on column accounts.customer_status__c  is 'Customer Status';
comment on column opportunities.amount         is 'Amount';
comment on column opportunities.arr__c         is 'ARR';
comment on column opportunities.legacy_booking_amount__c is 'Booking Amount';
comment on column contracts.arr                is 'Contract ARR';
