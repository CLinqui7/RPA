# Parser Batch 01: OLLIES, CARNIVAL, 10BELOW

## Scope

This batch is parser-only.

```text
PDF / HARDCOPY
-> customer candidate detection
-> document family detection
-> layout version detection
-> raw extraction
-> meaning-preserving normalization
-> ParsedDocument
-> STOP
```

The batch does not decide final A2000 customer, store, terms, division, warehouse, style, color, scale, size bucket or ship-via mappings.

Historical checklists and exports are stored only as mapping truth evidence under `api/training/mapping_truth/`. They are not read by the parsers.

## Why these three customers

OLLIES, CARNIVAL and 10BELOW were selected because all three were missing customer-aware parsers, each source PDF represents one PO, all current fixtures are machine-readable, and each has historical evidence to validate parser-versus-mapping separation.

### OLLIES

Document family: `ollies_purchase_order`

Layout: legacy monospaced table with columns:

`Ln / SKU / Description / UPC Number / Model# / Cs Pk / Units Ord / Cost / Ext Cost`

Raw parser behavior:

- `customer_sku` from printed SKU
- `upc` from printed UPC Number
- `style_raw` from printed Model# exactly
- `color_raw = null` when no color is printed
- `qty_total` from Units Ord
- case pack retained in `raw.case_pack_raw`
- does not write historical A2000 colors such as J19, 172 or 610

### CARNIVAL

Document family: `carnival_purchase_order`

Layout: Purchase Order with line table:

`PO LINE / QUANTITY / UNIT / ITEM NUMBER / DESCRIPTION / DATE REQUIRED / UNIT PRICE / TOTAL PRICE`

Raw parser behavior:

- `customer_sku` from printed Item Number
- `style_raw = null` because the source PO does not print the historical A2000 style
- extracts BLACK or NAVY from the printed description
- extracts printed size such as `M6/W8`
- preserves raw CASE quantity in `qty_total`
- preserves `(6)` as `raw.pack_qty_candidate_raw`
- records `raw.derived_each_qty_candidate = CASE quantity * printed pack candidate`
- the derived each quantity is evidence only and is not assigned to an A2000 size bucket
- does not write historical style `133CARNIVA01` or colors `003` / `007`

### 10BELOW

Document family: `tenbelow_purchase_order`

Layout: wide Purchase Order table with columns:

`VENDOR STYLE / DESCRIPTION / REORDER / DEPT / SIZE SCALE / ... / COST / RETAIL / TOTAL UNITS / TOTAL COST`

Raw parser behavior:

- preserves the full printed Vendor Style, for example `WILLA01L-SGA`
- does not split it into final A2000 style and color
- exposes `style_base_candidate_raw = WILLA01L` and `style_suffix_candidate_raw = SGA` as raw candidate evidence
- `color_raw = null` because there is no explicit Color column in the source row
- extracts Size Scale, Cost and Total Units
- does not write historical final A2000 style/color from the export

## Architecture changes

### New raw parser entry point

`api/src/po/parsers/index.js` now exports:

```js
parseRawPurchaseOrder(...)
```

This function stops at raw parser output.

Existing production behavior remains behind:

```js
parsePurchaseOrder(...)
```

which still performs:

```text
parseRawPurchaseOrder
-> normalizeForA2000
-> enrichOrderWithMasters
-> addQuality
```

No enrichment or A2000 mapping logic was added to the three new parser files.

### New raw debug runner

```text
api/src/debug-parse-raw-pdf-batch.js
```

Use this runner when measuring parser accuracy. Do not use enriched output as parser truth.

### Parser fixtures and mapping truth are separate

Parser fixtures:

```text
api/training/parser_fixtures/
```

These assert source PDF raw values only.

Historical mapping evidence:

```text
api/training/mapping_truth/
```

These document historical A2000 results and sources. Parser code does not import these files.

## Text extraction

`api/src/po/pdfText.js` received layout-specific scoring anchors for the three selected table families. The anchors only add score when wide multi-column spacing is preserved.

Observed after the change:

```text
OLLIES   pdftotext=9   pdf-parse=9
CARNIVAL pdftotext=9   pdf-parse=3
10BELOW  pdftotext=9   pdf-parse=0
```

Auto mode therefore preserves the layout text needed by these parsers.

10BELOW may emit Poppler warnings such as `TT: undefined function: 32`. The current source still extracts and passes its raw fixture. The warning is not treated as parsed business data.

## Verified fixture results

```text
PASS carnival/po_1674444.raw.json
PASS carnival/po_1674445.raw.json
PASS ollies/po_933911.raw.json
PASS ollies/po_952211.raw.json
PASS tenbelow/po_72041.raw.json
```

Five raw fixtures passed.

## Existing parser routing smoke test

The batch was also run against current canonical hardcopies for existing parsers:

```text
Bealls new -> bealls
Bealls old -> bealls
Citi -> cititrends
Gabes -> gabes
Shoe Show -> shoeshow
Variety -> variety
```

The new customer-family anchors did not steal these documents from their existing parsers.

The old Bealls canonical sample still routes to `bealls` but currently extracts zero lines. That is an existing parser coverage gap and was not changed in this batch.

## Test commands in Codespaces

From the current project shown in Codespaces:

```bash
cd /workspaces/RPA/outlook-rpa-dashboard
```

Run raw fixture verification:

```bash
node api/src/debug-verify-parser-fixtures.js
```

Expected result: five `PASS` rows and process exit code 0.

Inspect raw outputs:

```bash
node api/src/debug-parse-raw-pdf-batch.js \
  "api/training/parser_fixture_pdfs/PO #933911.pdf" \
  "api/training/parser_fixture_pdfs/PO_127_1674444_0_US.pdf" \
  "api/training/parser_fixture_pdfs/72041 American Exchange PO.pdf"
```

The parser output should keep final A2000 mapping fields null in raw scope.

## Next parser batch finding

TJMAXX and MARSHALLS should be handled as a dedicated TJX phase rather than silently added to this batch. Historical TJX Distribution Instructions can represent multiple PO/DC order candidates inside one PDF, while the current persistence model is one purchase order per document.

A separate extraction issue was also observed in TJX Distribution Instructions: current auto scoring can choose collapsed `pdf-parse` text even when `pdftotext -layout` preserves the DC columns. That issue should be solved together with the multi-order ParsedDocument decision.

COLONY should also be scheduled separately because at least one historical PO has no useful text layer and is rotated, requiring a controlled OCR fallback strategy.
