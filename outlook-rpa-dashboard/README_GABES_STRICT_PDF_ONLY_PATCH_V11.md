# Gabe's strict PDF-only patch v11

This patch replaces:

- `api/src/po/parsers/gabes.js`
- `api/src/po/mappers/styleColorRules.js`

Purpose:

- Make Gabe's behave like a true Purchase Order reader.
- Extract only values printed in the Gabe's PO PDF.
- Stop hardcoding/enriching `GABRIELBRO`, `C6`, `MJ`, `PE`, `SAME`, `48DAX39B`, `48DAX39TB`, `9WA`, `TNA`, or size distributions from PT, Pull Sheet, checklist, export, screenshots, or A2000.
- Keep the full PO number from the PO header, for example `100-0012002783 JR`.

Expected for `12002783.pdf`:

- `order_no`: `100-0012002783 JR`
- `order_date`: `2025-12-19`
- `start_date`: `2026-06-11`
- `cancel_date`: `2026-06-18`
- `terms_raw`: `NET 75 DAYS`
- `terms_code`: `null`
- `customer_code`: `null`
- `store_code`: `null`
- `division_code`: `null`
- `warehouse_code`: `null`
- `line_count`: `3`
- lines keep PO raw values such as `DAX-39M`, `DAX-39M-TOD`, item SKUs, ticket SKUs, costs, quantities and descriptions.
- lines should be `needs_mapping` because A2000 style/color/warehouse/size distribution are not printed in the PO.

Important:

Supporting docs like PT, PS and Pull Sheet are not applied automatically in this strict patch. They should be parsed later by a separate enrichment/mapping engine.
