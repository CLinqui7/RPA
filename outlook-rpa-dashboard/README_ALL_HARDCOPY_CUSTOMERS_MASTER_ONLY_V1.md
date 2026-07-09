# ALL HARDCOPY CUSTOMERS - MASTER ONLY HARDENED V1

## Scope

This cumulative patch profiles the complete 23-customer hardcopy universe registered for the project while enforcing one rule:

**Runtime order construction may use only the original customer-issued source document plus official A2000 masters.**

Allowed runtime evidence:

- PDF / original hardcopy
- Customer Master
- Store Master
- VR_SKU
- VR_UPC_STYLE
- VR_COLOR
- Warehouse Master

Forbidden as runtime mapping truth:

- checklists
- PT / Pick Ticket
- Packing Slip
- historical Sales Order export
- Hermanito
- `mapping_truth`

The parser preserves printed values as raw evidence. Final A2000 STYLE, COLOR_NO, TERM_NO, STORE_NO, DIV_NO, WHOUSE, SCALE and QTY_SZn values require explicit or uniquely supported official-master evidence.

## Coverage

- 23 customer profiles registered.
- All 23 official customer codes resolve to Customer Master rows with nonempty Terms.
- `GORDONRBO` is an explicit external label alias to official A2000 customer `GORBRORET`.
- 18 canonical customer-issued PDF samples are included and audited.
- 18/18 canonical PDF samples route to the expected customer-specific parser and official customer identity when required upstream banner metadata is supplied.
- Existing Batch01 source fixtures remain: 5 RAW parser fixtures and 3 enrichment fixtures.
- All-customer guard suite: 25/25 PASS in the build used to create this patch.
- Batch01 V3 guard suite: 20/20 PASS in the build used to create this patch.

## Important hardening added in this version

### 1. Every known customer gets a safe personalized fallback

If upstream email/document metadata identifies one of the 23 known customers but the PDF does not match a verified document-family signature, the document now routes to `known_unsupported` instead of `generic`.

The system preserves the customer candidate and blocks the order. It does not invent fields from the customer name.

### 2. Final style/color normalization is master-only

`styleColorRules.js` no longer turns code-looking printed tokens into A2000 codes.

`WHITE`, `003`, `ABC`, or a printed vendor style remain raw until official-master enrichment resolves them.

### 3. Store Master malformed CSV rows are quarantined

The supplied official `stores_master.csv` has a 50-column header, but 2,696 data rows contain a different column count. The audit found source rows with unquoted commas in text fields, which previously shifted address, city, state, postal and Active values into the wrong columns.

Cache V8 policy:

`reject_shifted_columns_preserve_customer_store_keys_v1`

For malformed rows:

- preserve exact `Customer` and `Store` keys only
- blank the shifted descriptive columns
- mark `source_row_status = malformed_unquoted_csv_columns`
- exclude malformed descriptive fields from address-based store resolution
- never use shifted Active, Ship Via or Warehouse values

An exact printed Store/DC may still resolve when the exact official `Customer|Store` key exists and the master does not explicitly say `Active=N`. Unknown activity is recorded as a warning.

This fixes OLLIES 5050/5100 without trusting corrupted shifted address columns.

### 4. PDF extraction avoids unnecessary TrueType warning paths

For strong layout signatures, `pdftotext -layout` is accepted directly. `pdf-parse` is not invoked only to compare scores when the layout score is already strong.

This removes the repeated `TT: undefined function: 32` noise for the known strong table layouts while retaining the fallback for weaker/unknown PDFs.

### 5. Customer Master Terms remain authoritative

`TERM_NO` comes from exact Customer Master customer resolution.

Printed terms stay in `terms_raw` for audit. Material policy mismatch, such as PDF NET45 versus Customer Master PREPAY, blocks import but does not replace the official master TERM code.

Example:

- 10BELOW PDF: `3% / 60 DAYS`
- Customer Master: `6C / CIT NET 60`
- Result: `terms_code = 6C`, no false conflict

### 6. Strict quantity bucket protection remains active

`qty_total` never falls into `QTY_SZ1`.

Only explicit official size-slot evidence may populate `QTY_SZ1...QTY_SZ18`.

CASE quantity never auto-populates size buckets as EACH quantity.

### 7. Customer-specific parser/enrichment strategies

Implemented or hardened customer-aware families include:

- 10BELOW
- BEALLSOUTL
- CARNIVAL
- CATO / ITSFASHION / VERSONA document family
- CITI
- COLONY
- GABRIELBRO
- IPC
- MACYSBACKS
- MARSHALLS
- MESALVEINC
- OLLIES
- SHOE4500
- SPENCER legacy family
- TILLYS
- TJMAXX
- VARIETYWHO
- ZUMIEZ

Customers without a safe original source layout sample are registered and safe-blocked instead of guessed.

## Master cache required

Rebuild the official compact cache after applying the patch.

Expected manifest:

```json
{
  "version": 8,
  "source_policy": "official_masters_only",
  "customer_profile_policy": "master_only_all_customers_v1",
  "store_csv_policy": "reject_shifted_columns_preserve_customer_store_keys_v1"
}
```

## Validation commands

```bash
node api/src/debug-verify-parser-fixtures.js
node api/src/debug-verify-enrichment-batch01.js
node api/src/debug-verify-batch01-v3-guards.js
node api/src/debug-verify-all-customers-master-only.js
node api/src/debug-audit-all-hardcopy-fixtures.js
```

The all-customer audit does not require every source to be importable. A `needs_mapping` result is correct when the customer-issued source and official masters do not contain enough evidence for a strict A2000 order.
