# Gabe's mapping patch v9

This patch replaces `api/src/po/parsers/gabes.js`.

It adds support for Gabe's Purchase Order `100-0012002783 JR` and maps the three PO rows to the A2000 style/color/size distribution confirmed by the supplied PT/checklist/export evidence.

Important behavior:

- The Purchase Order PDF remains the source for PO number, order date, ship date, cancel date, ticket SKU, internal item, unit cost, total quantity and PO amount.
- A2000-only fields such as customer code, store, division, warehouse, term code, style/color code and size distribution are populated only when the PO line matches the confirmed Gabe's enrichment map.
- Gabe's supporting documents such as PT, PS, Packing Slip and Pull Sheet are detected and marked as supporting documents, not imported as standalone purchase orders.

Expected result for `12002783.pdf`:

- parser: `gabes`
- status: `parsed`
- customer_code: `GABRIELBRO`
- order_no: `100-0012002783 JR`
- start_date: `2026-06-11`
- cancel_date: `2026-06-18`
- terms_code: `C6`
- division_code: `MJ`
- warehouse_code: `PE`
- store_code: `SAME`
- line_count: `3`
- totals.qty: `3360`
- totals.amount: `22740`

Expected lines:

1. `48DAX39B / 9WA`, qty 1200, sizes 12/13/1/2/3/4 = 200/200/300/200/200/100, cost 7.25
2. `48DAX39TB / TNA`, qty 1200, sizes 6/7/8/9/10/11 = 200/200/200/200/200/200, cost 6.50
3. `48DAX39B / TNA`, qty 960, sizes 12/13/1/2/3/4 = 160/160/240/160/160/80, cost 6.50
