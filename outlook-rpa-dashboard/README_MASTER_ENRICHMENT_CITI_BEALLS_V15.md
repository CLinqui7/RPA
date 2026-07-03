# Patch v15 - Citi color aliases + PE warehouse fallback

This patch improves the v14 master enrichment layer without changing the PDF parsers.

## Adds

- Reads `whse_master.csv` into `api/masters/cache/warehouses.csv`.
- Validates and applies default warehouse `PE` for Citi/Bealls when the PO/store/customer does not provide a warehouse.
- Propagates header warehouse to lines when missing.
- Adds customer-specific Citi color aliases:
  - Printed `WHITE` / `WHT` -> A2000 color `WTB`
  - Printed `BLACK-OFF BLACK` / `BLK-OFF BLACK` -> A2000 color `BKA`
- Prefers SKU rows for the detected customer when style/color has duplicate rows.

## Safety

The color aliases only apply to parser `cititrends` and customer `CITI`. Bealls continues using exact style/color from the PO plus master lookup.

## Required after applying

Rebuild the master cache:

```bash
python3 api/scripts/build-master-cache.py api/masters
```

Then run the batch:

```bash
SUPABASE_URL=https://example.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=dummy \
PDF_TEXT_ENGINE=pdftotext \
node api/src/debug-parse-pdf-batch.js test-pdfs/*.pdf test-pdfs/*.PDF
```
