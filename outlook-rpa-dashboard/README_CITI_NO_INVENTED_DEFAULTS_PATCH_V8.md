# Patch v8 - Citi strict no invented defaults

This patch removes invented A2000 operational defaults from Citi Trends PDF-only extraction.

## Why
Citi PO PDFs do not print `store_code`, `division_code`, header warehouse, or line warehouse. Previous normalization/default/export logic could still fill `division_code = X` and `warehouse_code = PE`. That made the parser appear to know values that were not in the invoice.

## Behavior after this patch
For Citi Trends:

- `customer_code = CITI` is allowed because the customer is printed in the document.
- `terms_code = X6` is allowed because the PDF prints `NET 60 DAYS ROG`, which is a deterministic terms mapping.
- `style_raw = SENA` can map to `style_code = 11SENAL` only for the confirmed style rule.
- `store_code`, `division_code`, `warehouse_code`, line `warehouse_code`, and A2000 `color_code` stay blank unless they are printed in the PDF or supplied by an approved mapping source.

Expected Citi status remains `needs_mapping` until approved sources supply store/division/warehouse/color.
