# Hardcopy Reading V3: Master Match + Multi-Order Hardened

## Scope

This patch is a delta on top of `HARDCOPY_READING_V2_FIELD_CERTIFICATION_PATCH.zip`.

Runtime source policy remains:

- PDF / hardcopy text and structure
- Customer Master
- Store Master
- VR_SKU
- VR_UPC_STYLE
- VR_COLOR
- Warehouse master

The runtime does **not** read checklist, PT, packing slip, Hermanito, mapping_truth or old exports to complete a current order.

## Main objective

Improve customer-specific hardcopy reading and official-master style/color/UPC resolution without using historical mappings and without leaking fuzzy rules across customers.

## Style matching policy

Similarity is opt-in. A parser must explicitly declare:

`style_similarity_semantics = NEAREST_OFFICIAL_STYLE_CODE`

The enrichment layer then:

1. normalizes printed and official style tokens;
2. restricts the candidate universe by a stable leading prefix;
3. calculates Levenshtein distance;
4. ranks exact prefix-extension relationships ahead of unrelated equal-distance candidates;
5. resolves only when the best candidate is unique.

No global "closest style wins" policy exists.

Examples certified by this patch:

- Bealls old `03HOSTAR-Y` -> `03HOSTARYK` only because `03HOSTARYK` is the unique nearest prefix extension and the printed White + exact printed size independently resolves official color `001` and an exact UPC row.
- ITSFASHION `SNNT0010C-A27` -> `SNNST0010C / A27` because the printed composite base has one unique nearest official base style and `A27` exists exactly as a color on that official style.

## Variety Wholesale

Printed style:

`W7EH00184-42-07`

The parser preserves the full RAW value and declares that the trailing customer suffix may be a prefix of an official color code.

Official base style:

`W7EH00184-42`

Official colors are evaluated only for that base style. Printed suffix `07` uniquely prefixes official color `078`, therefore:

- STYLE = `W7EH00184-42`
- COLOR = `078`
- Master UPC = `196540928345`

Terms always use Customer Master, therefore VARIETYWHO uses `C4`. PDF terms remain audit evidence.

All nine audited Variety lines now resolve official style, color and master UPC.

## Gabriel Brothers / Gabe's

Printed style `WELMA-61K` resolves through normalized official style fields to `WELMA61K`.

The parser explicitly declares that the printed description contains abbreviated official color semantics.

Examples:

- `MRMD MLTI` -> semantic `MERMAID MULTI`
- `FSCHA` -> semantic `FUCHSIA/FUSCHIA`

The official style contains duplicate semantic color families with numeric and alpha codes. For this prepack document, the resolver prefers a unique three-letter alpha color only when that code has an official ALL / Size Num 0 row in VR_UPC_STYLE.

Certified results:

- WELMA61K / MDA -> UPC `194866098261`
- WELMA61K / FSA -> UPC `194866098254`

No QTY_SZn is invented because the hardcopy does not provide a safe size distribution.

## Me Salve

The hardcopy may print `SOLID` in the color column while the actual semantic color is visible in product description text.

For parsers that explicitly declare description color semantics:

- description words are matched to official color descriptions/abbreviations for the already-resolved style;
- `SOLID` prefers a unique numeric official color code for that semantic color;
- prepack may prefer a unique alpha official semantic duplicate when explicitly declared by the parser.

Certified examples:

- PL2017NL-42 / RED -> 033 -> UPC `199347468618`
- PL2018NL-42 / BROWN -> 006 -> UPC `199347468625`
- PL1132NL / LIGHT PINK -> 670 -> UPC `199347014747`
- PL1034NL / LIGHT PINK -> 670 -> UPC `199347014730`

## 10BELOW Store

The primary printed Ship To is ranked by customer/store identity after address narrowing.

For PO 72041:

- Ship To name = Simply 10
- address starts with 2500 Crestwood Blvd
- official candidates share the address
- store code/name identity uniquely selects `SIMPLY10`

The two lines resolve official style/color/master UPC:

- WILLA01L / SGA -> `194866934613`
- RYNN05L / WHA -> `194866886837`

No size ratio or QTY_SZn is invented.

## IPC

Printed composite style:

`AX9851B-42-G16`

Official resolution:

- STYLE = AX9851B-42
- COLOR = G16
- Master UPC = `196540921803`
- official Scale = PC
- official Size Num = 1

The printed table explicitly labels quantity as QTY and the parser declares `ORDERED_UNITS`. Therefore QTY 2000 safely maps to QTY_SZ1 = 2000.

Terms use Customer Master: `PP`.

The source date conflict remains blocking because the same document says pickup 5/8/26 and prepare by 05/08/25.

## ITSFASHION Multi-Order PDF

One physical PDF contains six independent Purchase Orders:

- 616994
- 616996
- 616999
- 617005
- 617011
- 617012

`parseRawPurchaseOrders` and `parsePurchaseOrders` now support 1..N orders per physical PDF.

Cato-family documents are split by PDF page boundaries when each page contains one Purchase Order. A marker fallback splits on repeated `PURCHASE ORDER:` headers when page form-feed boundaries are unavailable.

Each split order records:

- source_order_index
- source_order_count
- hardcopy_boundary_semantics

The server production parsing paths now call `parsePurchaseOrders` and flatten independent orders. The legacy single-order API remains blocking for multi-order input to prevent silent merging.

Certified results:

- 616994 -> SESST0117C / A27 / UPC 199347376548
- 616996 -> SESST0121C / A27 / UPC 199347376562
- 616999 -> SESST0109C / A27 / UPC 199347376524
- 617005 printed SNNT0010C-A27 -> SNNST0010C / A27 / UPC 199347376630
- 617011 -> SNNST0006C / A27 / UPC 199347376616
- 617012 -> SNNST0007C / A27 / UPC 199347376623

All six are independently parsed with Store SHIPTO, Customer Master Terms C6 and QTY_SZ1 = 160.

## Bealls old layout

The old hardcopy is no longer treated as unreadable.

Printed style `03HOSTAR-Y` is preserved as RAW.

Official style resolution is `03HOSTARYK` using the explicit nearest-style policy and unique prefix-extension ranking.

Printed color White plus each exact printed size disambiguates official color `001` from alternate White semantic codes on the style.

Certified size-specific official UPC/bucket results:

- Size 1 -> UPC 199347273304 -> QTY_SZ5 = 46
- Size 2 -> UPC 199347273311 -> QTY_SZ6 = 46
- Size 3 -> UPC 199347273328 -> QTY_SZ7 = 46
- Size 11 -> UPC 199347273274 -> QTY_SZ2 = 92
- Size 12 -> UPC 199347273281 -> QTY_SZ3 = 92
- Size 13 -> UPC 199347273298 -> QTY_SZ4 = 92

## Citi UPC separation

Customer printed UPC and official master UPC remain separate.

Example first line:

- customer UPC from PDF = 400433438706
- RAW style = AX4028H-42-LR1
- official STYLE = AX4028H-42
- official COLOR = LR1
- official master UPC = 196540051104

The printed customer UPC is never overwritten.

One audited Citi line resolves exact official STYLE AX4376H-94 / COLOR 979 but VR_UPC_STYLE contains no exact official UPC row for that exact style/color. The PDF still supplies customer UPC 400433439468. The system records `customer_upc_only_no_unique_official_master_upc` and does not borrow the sibling AX4376H-42 UPC.

## Shoe Show multi-size UPCs

A multi-size line cannot truthfully have one single master UPC.

The Shoe Show hardcopy prints an exact size grid for HAMPTON / TSI:

- 8 = 346
- 9 = 520
- 10 = 580
- 11 = 580
- 12 = 460
- 13 = 322

The enrichment layer now builds `master_upcs_by_size` from exact printed size + official VR_UPC_STYLE rows:

- 8 -> 199347310061
- 9 -> 199347310078
- 10 -> 199347310085
- 11 -> 199347310092
- 12 -> 199347310108
- 13 -> 199347310115

`master_upc` remains null because there is not one UPC for the whole multi-size line.

## Carnival

Both 1674444 and 1674445 are Carnival hardcopies.

Current official master resolution for the printed WATER SHOES product family:

- BLACK -> 133CARNIVA01 / 003
- NAVY -> 133CARNIVA01 / 007

Per-size official master UPCs resolve from printed size values.

CASE quantities never auto-populate QTY_SZn.

## Marshalls limitation

PO 314654 is read correctly from the top of the routing document.

All five official style/color pairs resolve:

- HANZB / 006
- HANZB / TAU
- BARRETTB / 285
- BARRETTB / 003
- BARRETTB / TAU

Each style/color has six size-specific official UPC rows. The routing document does not provide size distribution and does not provide sales price. Therefore a unique UPC and QTY_SZn cannot be built without a companion priced PO / size source.

The system preserves six UPC candidates per line and refuses to choose one.

## PO review policy

Per business instruction, the printed PO-like identifiers in the current TJMAXX and VERSONA samples are preserved as evidence but marked with blocking `order_no_requires_business_review` until the business confirms which number is the American Exchange/A2000 order identifier.

## Audit coverage

The V3 master audit parses 22 physical source documents and produces 27 orders because the ITSFASHION PDF splits into six orders.

Current certified audit result:

- 106 lines
- 106 / 106 official styles resolved
- 106 / 106 official colors resolved
- 99 lines with one unique official master UPC
- 1 multi-size Shoe Show line with all 6 size-specific official master UPCs resolved
- 100 / 106 lines with official master UPC coverage
- 101 / 106 lines with at least some UPC evidence when Citi customer UPC is included
- 5 lines with no UPC evidence: the five Marshalls routing lines, each with six size-specific official UPC candidates and no printed size

## Verification commands

```bash
node api/src/debug-verify-parser-fixtures.js
node api/src/debug-verify-enrichment-batch01.js
node api/src/debug-verify-batch01-v3-guards.js
node api/src/debug-verify-all-customers-master-only.js
node api/src/debug-audit-all-hardcopy-fixtures.js
node api/src/debug-verify-reading-v3-master-matches.js
node api/src/debug-audit-master-style-color-upc.js
```

Expected V3 results:

- parser fixtures: 5/5 PASS
- Batch01 enrichment: 3/3 PASS
- Batch01 V3 guards: 20 PASS / 0 FAIL
- all-customer guards: 27 PASS / 0 FAIL
- source hardcopy audit: 19 physical PDFs / 24 parsed orders / 19 identity PASS / 0 FAIL
- V3 master/multi-order guards: 13 PASS / 0 FAIL
- master audit: 106/106 styles, 106/106 colors, 100 lines with official master UPC coverage, 5 no-UPC-evidence Marshalls routing lines
