# BATCH 01 V3 — MASTER ONLY HARDENED

Customers in this batch:
- OLLIES
- CARNIVAL
- 10BELOW

## Scope policy

Runtime construction is limited to:

1. Values extracted from the source PDF/hardcopy.
2. Official A2000 masters loaded from `api/masters`:
   - customer master
   - stores master
   - VR_SKU
   - VR_UPC_STYLE
   - VR_COLOR
   - warehouse master

This patch does not ship or read `api/training/mapping_truth`.
It does not read checklists, Pick Tickets, Packing Slips, historical exports, or Hermanito at runtime.

## Terms policy

Once `customer_code` resolves to an exact Customer Master row, Customer Master `Terms` is authoritative for A2000 `TERM_NO`.

Example:

- PDF 10BELOW `terms_raw`: `3% / 60 DAYS`
- Customer Master `10BELOW.Terms`: `6C`
- Result: `terms_code = 6C`

The PDF text remains in `terms_raw` for audit. Textual differences between PDF terms wording and the Customer Master description do not create a false terms conflict.

## Hardening changes

1. RAW identity fields never fabricate a legal entity or brand when text extraction did not read one.
2. Exact reverse UPC lookup is opt-in and uses explicit UPC fields only. `ticket_sku` is not treated as UPC.
3. OLLIES exact printed UPC can resolve an exact `VR_UPC_STYLE` business tuple.
4. Duplicate UPC rows collapse only when STYLE, CLR, Size Num, Size Name, DIV, SCALE and SKU are identical.
5. UPC Size Num can populate a QTY_SZn bucket only when the PDF quantity semantics are explicitly `EACH`.
6. CASE quantities cannot be copied into A2000 QTY buckets.
7. 10BELOW `BASE-SUFFIX` style/color resolution runs only for the `tenbelow` parser and requires an exact STYLE + CLR pair in VR_SKU.
8. Customer Master is authoritative for TERM_NO after exact customer resolution.
9. Hardcoded A2000 fallbacks such as DIV `X`, WH `PE`, MASTER_INVOICE `Y` and qty_total -> QTY_SZ1 were removed from export paths.
10. A strict A2000 line requires an explicit line number, resolved STYLE/COLOR, valid non-negative sales price, warehouse, valid integer quantity buckets and at least one positive QTY_SZ1...QTY_SZ18 value.
11. A line with only qty_total is not importable.
12. A line with only zero, negative or nonnumeric QTY_SZn values is not importable.
13. A2000 optional SIZE_NO/CUST_STYLE1/CUST_STYLE2/REF fields are exported only from explicit target-semantic fields. Raw size text, customer SKU, ticket SKU and UPC are not repurposed into those columns.
14. The server export uses `api/src/a2000/csv.js` as the single source of truth for A2000 CSV columns.
15. The aggressive server-side Citi finalizer that selected first candidates and forced SAME/PE was removed from the UI/export path.
16. The quality gate accepts any valid QTY_SZn bucket, not only QTY_SZ1.
17. Master cache V5 is required and declares `source_policy = official_masters_only`.

## Required cache rebuild

After applying this patch:

```bash
rm -rf api/masters/cache
python3 api/scripts/build-master-cache.py api/masters
cat api/masters/cache/manifest.json
```

Required manifest markers:

```json
{
  "version": 5,
  "source_policy": "official_masters_only"
}
```

## Verification

```bash
node api/src/debug-verify-parser-fixtures.js
node api/src/debug-verify-enrichment-batch01.js
node api/src/debug-verify-batch01-v3-guards.js
```

Expected:
- RAW fixtures: 5/5 PASS
- Enrichment fixtures: 3/3 PASS
- Master-only guard suite: 20/20 PASS

`Warning: TT: undefined function: 32` is currently an observed PDF font/text-engine warning. The guarded fixtures still pass. Treat it as extraction-suspect only when accompanied by missing lines, missing anchors, or inconsistent totals.

## Known scope boundary

This V3 hardens Batch 01 and the shared UI/CSV export leak paths. Older parsers such as Bealls, Citi, Gabes, Shoe Show, Spencers and Variety still contain legacy customer-specific behavior from earlier project work. They are not all migrated to the new master-only policy by this patch because doing so without dedicated regression fixtures would be a separate breaking migration.
