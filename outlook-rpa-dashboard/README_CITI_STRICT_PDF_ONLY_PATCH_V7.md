# Citi Trends strict PDF-only patch v7

This patch removes the order-specific A2000 truth/hardcoded values that were added in v6.

## What changed

- Citi parser no longer injects:
  - store_code = 4
  - division_code = MJ
  - header warehouse = HT
  - line warehouse = PE
  - qty_total = 1200
  - operational amount = 5400
- Those values are not present on the Citi PO PDF, so they remain null.
- PDF totals remain as extracted from the PDF.
- The confirmed document-derived style rule is kept:
  - style_raw SENA -> style_code 11SENAL
- The A2000 color code PKA is not derived from the PDF. The PDF prints color_raw MULTI and the SKU segment 0096, but it does not print PKA.

## Expected Citi output for PO 0000187960

- customer_code: CITI
- order_no: 0000187960
- terms_code: X6
- store_code: null
- division_code: null
- warehouse_code: null
- line_count: 1
- style_code: 11SENAL
- color_code: null
- color_raw: MULTI
- qty_total: 1206
- amount: 5427
- status: needs_mapping because store_code and color_code are still missing for A2000 import.

## Why

The parser should extract what is in the PDF and apply only approved generic style rules. A2000-only operational data must come from an approved mapping source such as PT/export/checklist/style master, not from screenshots or manual order-specific values.
