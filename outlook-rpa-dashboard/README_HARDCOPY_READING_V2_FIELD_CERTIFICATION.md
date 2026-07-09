# HARDCOPY READING V2: field-level certification and business-rule corrections

This patch is incremental over `HARDCOPY_ALL_CUSTOMERS_MASTER_ONLY_HARDENED_V1`.

## Source policy

Runtime still uses only:

- PDF / hardcopy text
- Customer Master
- Store Master
- VR_SKU
- VR_UPC_STYLE
- VR_COLOR
- Warehouse master

It does not read checklists, PTs, packing slips, old exports, Hermanito, or historical mapping truth.

## Main corrections

1. **10BELOW Ship To**
   - Extracts all visible Ship To candidates.
   - Resolves the official Store Master row when the printed address matches by normalized address / first street number.
   - Keeps `qty_szn` unresolved when the source has only `Size Scale: 6 to 11` and total units.

2. **MACYSBACKS dates**
   - `ROUTE/START SHIP DATE` becomes `start_date`.
   - `IN MACYS BACKSTAGE DC BY` becomes `cancel_date`.
   - `order_date` remains unresolved because it is not printed.

3. **TILLYS Store**
   - Uses explicit parser default `SAME` when no authoritative Ship To is printed.

4. **SHOE4500 Store**
   - Preserves Ship To when text-extracted.
   - Uses explicit parser default `SAME` when the source text does not expose an authoritative Ship To block.

5. **CITI Reference PO**
   - Stops reading the label `Terms` as `reference_po` when Reference PO is blank.

6. **Terms policy**
   - Customer Master terms now take precedence for A2000 `TERM_NO`.
   - PDF terms mismatches remain audit warnings, not blocking conflicts.
   - This applies to Variety, Versona, IPC, 10Below, etc.

7. **Carnival official master style/color**
   - Resolves `133CARNIVA01` and official color from printed color (`BLACK`, `NAVY`) using VR_SKU only.
   - Still does not populate `QTY_SZn` from CASE quantities.

8. **Spencer canonical hardcopy**
   - Adds the uploaded Spencer PDF as a source fixture.
   - Parses PO `305696`, Store Master address, exact UPC `196540785962`, style/color and QTY bucket from official masters.

9. **Hardcopy reading dump**
   - Adds `api/src/debug-dump-all-hardcopy-reading.js` to show exactly what the parser reads from every canonical hardcopy and what enrichment resolves.

## Expected test results

Run from project root:

```bash
node api/src/debug-verify-parser-fixtures.js
node api/src/debug-verify-enrichment-batch01.js
node api/src/debug-verify-batch01-v3-guards.js
node api/src/debug-verify-all-customers-master-only.js
node api/src/debug-audit-all-hardcopy-fixtures.js
node api/src/debug-dump-all-hardcopy-reading.js > api/debug/all_hardcopy_reading_dump.json
```

Expected summary:

- RAW parser fixtures: `5/5 PASS`
- Batch01 enrichment: `3/3 PASS`
- V3 guards: `20 PASS / 0 FAIL`
- All customer guards: `26 PASS / 0 FAIL`
- Hardcopy audit: `19 identity checks PASS / 0 FAIL`

## Notes

- ITSFASHION still blocks as a multi-order document. The parser detects the multiple POs but the system still needs a future `MultiOrderDocumentSplitter` to create one InternalOrder per PO.
- TJMAXX remains review-only because the source explicitly requires separate routing/distribution instructions.
- MARSHALLS remains review-only because the current source is routing instructions, not a priced PO.
- IPC remains blocked by the source date conflict (`5/8/26` vs `05/08/25`).
- 10BELOW still needs size ratio / size breakdown before A2000 line import.
- Bealls old remains unresolved because the printed legacy style does not uniquely resolve from official masters.
