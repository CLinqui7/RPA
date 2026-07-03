# Patch v14 - Master enrichment for Citi + Bealls

This patch adds a master lookup layer after PDF parsing and before quality validation.

## What it does

- Reads masters from `api/masters/` or from `A2000_MASTER_DIR`.
- Uses `customer_master` to fill customer code and terms.
- Uses `stores_master` to validate stores and, for Citi only, apply the approved default office/store when the PO does not print a store.
- Uses `VR_SKU` / `VR_SKU_Z` to enrich style, color, internal SKU, division, and price metadata.
- Uses `VR_UPC_STYLE` to enrich master UPC by style + color + size.
- Keeps Citi invoice UPC as `customer_upc` and stores the master UPC separately as `master_upc`.

## Safety rules

- The PDF parser still extracts only what is printed on the PO.
- Master enrichment is separate and traceable in `raw_enrichment.master_lookup`.
- Citi default store is explicitly marked as `stores_master_default_office`.
- If color/style has multiple candidates, the system does not force it. It reports candidates and stays `needs_mapping`.

## Expected effect

### Bealls

Bealls should enrich UPC/internal SKU/division using `style_code + color_code`.

### Citi

Citi should enrich customer/terms/default store and may enrich style/division when the match is safe. Color remains pending if the master has multiple possible colors for the same printed color.
