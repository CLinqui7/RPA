# Batch 01 combined hardcopy + master enrichment patch

Customers in this batch:
- OLLIES
- CARNIVAL
- 10BELOW

## Scope boundary

Raw parsers keep printed meaning. Final A2000 resolution stays in master enrichment.

Examples:
- OLLIES parser keeps printed `Model#` and UPC. Enrichment may override final STYLE/COLOR only from an exact UPC master match.
- 10BELOW parser keeps `WILLA01L-SGA` as `style_raw`. Enrichment splits it to `WILLA01L` + `SGA` only when the exact base style exists and `SGA` is an exact color code for that base style in VR_SKU.
- CARNIVAL remains RAW-only for final style/color in this batch.

## OLLIES rule

Resolution priority added:

1. Exact printed UPC in `VR_UPC_STYLE` (`upcByValue`).
2. If unique, resolve STYLE, COLOR, Size Num, Size Name, SCALE, DIV and SKU.
3. Exact STYLE+COLOR in `VR_SKU` enriches color description/abbr, list price, warehouse and pack quantity.
4. When exact UPC supplies `Size Num` 1..18, `qty_total` is written to the matching `qty_szN` bucket.
5. Printed Model# is preserved. If it differs from the exact UPC master style, the master override is recorded in `raw.style_master_override`.

This closes PO 952211, including the printed typo/mismatch `PL17977NL-42` versus master `PL1977NL-42` via UPC `199347506808`.

## 10BELOW rule

A trailing token is not blindly assumed to be color.

For `BASE-SUFFIX`:
- BASE must exist as an exact style in `VR_SKU`.
- SUFFIX must exist as an exact `Clr` for that BASE style.
- Only then enrichment resolves final STYLE and COLOR.

Confirmed examples:
- `WILLA01L-SGA` -> `WILLA01L` / `SGA`
- `RYNN05L-WHA` -> `RYNN05L` / `WHA`

The parser still preserves the full printed token in `style_raw`.

## Master cache v4

`build-master-cache.py` now keeps:
- SKU `Pack Qty`
- SKU `Wh`
- UPC color description/abbr
- UPC price
- UPC pack quantity

Runtime `masterData.js` adds `upcByValue` for reverse exact UPC lookup.

Rebuild `api/masters/cache` after applying this patch.

## Tests

Raw parser regression:

```bash
node api/src/debug-verify-parser-fixtures.js
```

Expected: 5 raw fixtures PASS.

Batch 01 enrichment regression:

```bash
node api/src/debug-verify-enrichment-batch01.js
```

Expected:

```text
PASS carnival_1674444.enriched.json
PASS ollies_952211.enriched.json
PASS tenbelow_72041.enriched.json

BATCH01 ENRICHMENT: 3/3 PASS
```

Inspect an enriched PDF:

```bash
node api/src/debug-inspect-enriched-pdf.js "api/training/parser_fixture_pdfs/PO #952211.pdf"
```
