# Shoe Show PDF-only parser patch v12

This patch updates the Shoe Show parser to read the PO/factura itself without inventing A2000 operational values.

It extracts from `SHOE_SHOW_INC_PO_25933.PDF`:

- `order_no`: `25933`
- `order_date`: `2025-11-24`
- `start_date`: `2026-07-01`
- `cancel_date`: `2026-07-16`
- `terms_raw`: `.0 % NET 30 DAYS`
- stock/customer SKU: `248325`
- description: `MUDD STORMY MICRO 11-5`
- color raw: `TPE`
- quantity: `1200`
- cost: `10.00`
- amount: `12000.00`
- size quantities from the PO grid when available

It intentionally does **not** set:

- `customer_code` (`SHOE4500`)
- `store_code` (`CONCORD`)
- `terms_code` (`C3`)
- `division_code` (`MJ`)
- `warehouse_code` (`PE`)
- `style_code` (`47STORMY13K`)
- `color_code` (`TA2`)

Those values are A2000/PT/Pull Sheet/master values, not values printed as A2000 codes in the PO.
