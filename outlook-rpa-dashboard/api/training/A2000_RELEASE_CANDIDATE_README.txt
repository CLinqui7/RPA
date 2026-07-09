A2000 RELEASE CANDIDATE CERTIFICATION
======================================

Project:
  /workspaces/RPA/outlook-rpa-dashboard

Branch used during discovery:
  factura-american-pdf-mvp

What is already proven in AMEXTEST
----------------------------------
1. OAuth client_credentials works.
2. Bearer expires_in=3600.
3. ORDER_HD live define has 60 fields.
4. ORDER_LI live define has 48 fields.
5. VR_ORDER_HD, VR_ORDER_LI and VR_UTREST_LOG work.
6. POST ORDER_HD creates a real Header.
7. response.data[0].SEQ_ORDER_NO equals VR_ORDER_HD.CTRL_NO.
8. ORDER_LI.SEQ_ORDER_NO links a Line to that Header.
9. Wrong division for style is a real business validation.
10. ORDER_LI validates the size distribution against ratio/scale context.
11. One valid ratio-preserving ORDER_LI row succeeded and was visible in VR_ORDER_LI.
12. Pending ORDER_LI rows in Upload Utility can interfere with REST uploads.
13. A2000 does not give Header idempotency by ORDER_NO.
14. HTTP 200 can still contain status=Fail / updated=0.
15. Raw A2000 JSON can contain duplicate "errors" object keys.

Why this suite exists
---------------------
The remaining API behavior gates before production are:

A. Two valid Lines in one ORDER_LI batch.
B. Exact size distribution survives REST -> A2000 -> VR_ORDER_LI.
C. Duplicate Line behavior.
D. ORDER_LI IGNORE_ERRORS=N rollback behavior.
E. Local master size_num correlation with QTY_SZn.
F. Static detection of code paths that still collapse qty_total into QTY_SZ1.
G. Dedicated Upload ID isolation remains an operational production requirement.

Important manual rule
---------------------
Before EACH write phase:
  Open AMEXTEST -> Import / Upload Utility -> ORDER_LI.

If pending rows exist:
  Export Data for evidence.
  CLEAR only ORDER_LI.

Then set:
  A2000_ORDER_LI_CLEARED=YES

The suite cannot press CLEAR for you.

Installation
------------
Put this file at:

  api/training/a2000_release_candidate_certification.py

Syntax check:

  cd /workspaces/RPA/outlook-rpa-dashboard
  python3 -m py_compile api/training/a2000_release_candidate_certification.py
  echo "PYTHON_SYNTAX=PASS"

The script automatically loads missing A2000_* values from:
  api/.env
  .env

It never prints Client Secret or access token.

PHASE 1: READONLY
-----------------
Run:

  cd /workspaces/RPA/outlook-rpa-dashboard

  A2000_CERT_PHASE=readonly \
  python3 api/training/a2000_release_candidate_certification.py \
  | tee /tmp/a2000_rc_readonly.log

This tests:
  OAuth
  live Upload contracts
  live Viewer contracts
  source Header 3757166
  source Lines
  size distributions
  local api/masters/cache/upc.csv size_num correlation
  targeted Viewer discovery:
    VR_SKU
    VR_SKU_Z
    VR_UPC_STYLE
  production code blocker scan

Expected:
  API contracts PASS.
  CODE-001 may FAIL because the current project code is still known to collapse quantities into qty_sz1/QTY_SZ1 and has no production REST saga.

That code failure is intentional evidence, not an A2000 API failure.

PHASE 2: MULTILINE SUCCESS
--------------------------
First inspect/CLEAR ORDER_LI in AMEXTEST.

Then:

  cd /workspaces/RPA/outlook-rpa-dashboard

  A2000_CERT_PHASE=multiline \
  A2000_ORDER_LI_CLEARED=YES \
  python3 api/training/a2000_release_candidate_certification.py \
  | tee /tmp/a2000_rc_multiline.log

This creates:
  1 unique Header
  2 real-context Lines

The Lines use EXACT source OPEN_SZ1..OPEN_SZ18 quantities, not the minimal ratio.

Success criteria:
  ORDER_HD Success
  Header Viewer count = 1
  ORDER_LI Success
  updated >= 2
  VR_ORDER_LI count = 2
  each STYLE/CLR matches
  every active OPEN_SZn matches the exact uploaded QTY_SZn
  new REST log contains updated: 2 errors: 0

On success the suite writes:
  api/training/a2000_release_candidate/state.json

PHASE 3: DUPLICATE LINE
-----------------------
Inspect/CLEAR ORDER_LI again first.

Then:

  cd /workspaces/RPA/outlook-rpa-dashboard

  A2000_CERT_PHASE=duplicate-line \
  A2000_ORDER_LI_CLEARED=YES \
  python3 api/training/a2000_release_candidate_certification.py \
  | tee /tmp/a2000_rc_duplicate.log

The phase reloads the successful multiline state and reposts the first exact Line.

Success for safety means:
  Viewer line count does not increase.
  No duplicate LINE_NO becomes visible.
  A2000 rejects it, ideally with "Already on file" or status=Fail/updated=0.

IMPORTANT:
This phase may leave a failed pending row in ORDER_LI.
After it finishes, inspect and CLEAR ORDER_LI before another write test.

PHASE 4: ORDER_LI ROLLBACK
--------------------------
Inspect/CLEAR ORDER_LI again first.

Then:

  cd /workspaces/RPA/outlook-rpa-dashboard

  A2000_CERT_PHASE=rollback-line \
  A2000_ORDER_LI_CLEARED=YES \
  python3 api/training/a2000_release_candidate_certification.py \
  | tee /tmp/a2000_rc_rollback.log

The suite creates:
  1 fresh Header
  Line 1 valid with exact size distribution
  Line 2 deliberately invalid STYLE
  IGNORE_ERRORS=N

Rollback is confirmed only when:
  body.status=Fail
  updated=0
  VR_ORDER_LI count=0

After this test:
  inspect and CLEAR ORDER_LI.

Production read-only certification
----------------------------------
Against production, do NOT set a write phase.

Set production A2000_BASE_URL in the environment, then:

  A2000_CERT_PHASE=production-readonly \
  python3 api/training/a2000_release_candidate_certification.py

The script never writes in production-readonly.

How to share results
--------------------
For every phase, copy only the block:

  ================================================================================
  COPY THIS RESULT TO CHATGPT
  ================================================================================
  ...
  ================================================================================

The detailed evidence stays in:

  api/training/a2000_release_candidate/<phase>_<run_id>/

Key files:
  CERTIFICATION_REPORT.md
  facts.json
  test_matrix.json
  raw_response_index.json
  requests/
  responses/
  master_correlation.json
  targeted_master_viewers.json
  production_code_scan.json

Production blockers already visible in the repository
------------------------------------------------------
The current branch has several specific blockers found from the code:

1. Citi parser places each PDF detail quantity into qty_sz1.

   Current behavior:
     size_raw = actual PDF size
     qty_total = actual quantity
     qty_sz1 = actual quantity

   That loses the relationship:
     size -> A2000 Size Num -> QTY_SZn

2. The parser quality gate requires qty_sz1 specifically.

   A valid A2000 Line can have:
     qty_sz1 = empty
     qty_sz4 = 96
     qty_sz5 = 192
     qty_sz6 = 192
     qty_sz7 = 96

3. exportBatch.js can fall back:
     qty_total -> QTY_SZ1

   This reproduces the real AMEXTEST error:
     "Order line order qty ... is out of ratio"

4. server.js /po/export-a2000-import currently maps only QTY_SZ1.

5. The project is still CSV-oriented. It does not yet have the production A2000RestAdapter / persistent saga.

6. Persistent idempotency/recovery is required because the same Header POST was proven to create two CTRL_NO values.

Required production implementation after behavior gates pass
-------------------------------------------------------------
A. Size bucket enrichment

Use VR_UPC_STYLE / local upc.csv:
  style
  clr
  size_name
  size_num
  scale
  scale_abbr

For each parsed size row:
  style_code + color_code + size_raw
    -> master UPC row
    -> size_num
    -> qty_sz{size_num}

Do not blindly put qty_total in qty_sz1.

B. Aggregate per-size PDF rows into one A2000 logical Line

Group by:
  style_code
  color_code
  sales_price
  warehouse_code

Then sum:
  qty_sz1 ... qty_sz18

Assign new sequential line_no values.

Example:

PDF rows:
  size A -> 96
  size B -> 192
  size C -> 192
  size D -> 96

Master size_num:
  A -> 4
  B -> 5
  C -> 6
  D -> 7

Internal logical Line:
  qty_sz4=96
  qty_sz5=192
  qty_sz6=192
  qty_sz7=96
  qty_total=576

C. Ratio validation

A2000 proved:
  1,0,0,0 -> out of ratio
  1,2,2,1 -> Success

Do not use the normalized ratio as the actual order quantity.

Use normalized ratio only to validate proportionality.

Upload the exact PO quantities.

D. REST Adapter

Required sequence:

  create/load idempotency job
  preflight
  state=header_uploading
  POST ORDER_HD once
  validate body.status / updated / data[0].SEQ_ORDER_NO
  persist raw response
  persist SEQ_ORDER_NO immediately
  state=header_created
  map all Lines with STORE_NO and same SEQ_ORDER_NO
  state=lines_uploading
  POST ORDER_LI
  validate body
  verify VR_ORDER_HD by CTRL_NO
  verify VR_ORDER_LI by CTRL_NO
  state=completed

E. Saga states

Recommended:
  parsed
  preflight_validated
  header_uploading
  header_created
  lines_uploading
  completed
  failed_preflight
  failed_header
  failed_lines
  reconciliation_required
  manual_review

If Lines fail after Header Success:
  do not create another Header
  resume ORDER_LI using persisted SEQ_ORDER_NO

F. No blind POST retry

Safe GET/Viewer:
  refresh token once on 401 and retry

Upload POST:
  make sure token is fresh before write
  do not generic retry on timeout/5xx
  reconcile with Viewers before any retry

G. Upload ID isolation

This is now a real production requirement.

Observed:
  14 BEALLSOUTL rows were pending in ORDER_LI Upload Utility.
  A single CITI REST row received 14 validation errors from those pending rows.
  CLEAR removed the contamination.
  The next single CITI row received its own clean "out of ratio" error.
  Correct ratio then succeeded.

Recommended:
  ask A2000 for dedicated integration Upload IDs cloned from ORDER_HD/ORDER_LI.

Conceptual names:
  RPA_ORDER_HD
  RPA_ORDER_LI

Do not assume those names already exist.

Until isolation is confirmed:
  shared ORDER_LI is a production operational risk.

Production GO gates
-------------------
Do not turn on automatic REST delivery until all of these are true:

[ ] readonly live contracts pass
[ ] local master size_num mapping is validated
[ ] two-Line exact distribution batch passes
[ ] duplicate Line behavior is characterized and safe
[ ] ORDER_LI IGNORE_ERRORS=N rollback is confirmed
[ ] Citi size rows are mapped to qty_sz{size_num}
[ ] same Style/Color per-size rows are aggregated into one logical Line
[ ] quality gate accepts any qty_sz1..18 distribution, not only qty_sz1
[ ] CSV fallback no longer silently collapses sized qty_total into QTY_SZ1
[ ] A2000RestAdapter exists
[ ] raw response is persisted
[ ] SEQ_ORDER_NO is persisted immediately after Header Success
[ ] idempotency job/table exists
[ ] Header duplicate prevention exists
[ ] Header-created / Lines-failed resume exists
[ ] no blind Upload POST retry
[ ] Viewer verification exists
[ ] production uses dedicated Upload IDs, or A2000 formally confirms pending state is isolated/safe
[ ] one real CITI PDF passes parse -> enrich -> aggregate -> preflight -> REST Header -> REST Lines -> Viewer verification
[ ] repeat with Bealls
[ ] repeat with each remaining customer parser before enabling that customer

Recommended rollout
-------------------
Stage 0:
  REST delivery disabled.
  CSV stays active.

Stage 1:
  CITI only.
  REST mode manual trigger.
  One document at a time.
  Human checks A2000 Header/Lines.
  5-10 successful orders.

Stage 2:
  CITI automatic.
  Other customers remain CSV/manual.

Stage 3:
  Enable customers one by one after each customer's PDF-to-bucket mapping is certified.

Never enable all customers in one flag on day one.
