# Customer Source Audit - PDF + Official Masters Only

This report records what the supplied customer-issued source documents can and cannot safely produce without checklists, PTs, packing slips, historical exports or Hermanito.

| Customer | Parser / source status | Current result | Source or data problem | Safe action |
|---|---|---|---|---|
| 10BELOW | `tenbelow` verified | Needs mapping | PDF has total units and size range `6 to 11`, but no size ratio. Ship-to address matches multiple active Store Master rows. | Ask for explicit size breakdown/ratio and authoritative destination/store code. Do not equal-split quantity. |
| BEALLSOUTL | `bealls` verified, new + old layouts | New sample parsed; old sample blocked | Old source prints legacy/malformed vendor style such as `03HOSTAR-Y`; official masters do not uniquely support silently adding missing characters, color or scale. | Ask customer/vendor to print correct vendor style and preferably UPC or explicit size breakdown. |
| CARNIVAL | `carnival` verified from original PO fixtures | Needs mapping | Source prints CASE quantity and item/customer SKU but no official A2000 style/color cross-reference exists in allowed masters; dates/destination are also insufficient for strict order. | Ask for original PO data containing vendor style/UPC, authoritative destination and explicit EACH/size distribution. Do not use historical checklist mapping. |
| CATO | Cato Corporation family profiled | Safe fallback / family-only | No canonical CATO-banner original sample was supplied. Legal entity `CATO CORPORATION` alone cannot distinguish CATO, ITSFASHION or VERSONA. | Supply one original CATO PO and preserve customer/banner metadata in email/document metadata. |
| CITI | `cititrends` verified | Parsed | Canonical sample resolves through printed data plus official masters. | Keep current source quality. |
| COLONY | `colony` verified | Needs mapping | Source has PO Date and In House Due Date but no explicit Start Ship and Cancel Date. Also contains `TRAFFIC#COLONYBRANDS.COM` and later correct `TRAFFIC@...`. | Fix source email typo and print explicit ship/start and cancel dates. |
| GABRIELBRO | `gabes` verified | Needs mapping | Printed descriptive colors are not unique official color+scale choices for the resolved style; warehouse and size buckets remain unresolved. | Print actual vendor/A2000 color code or UPC and explicit size breakdown; include authoritative warehouse/destination source data. |
| GORDONRBO → GORBRORET | Official alias registered | Safe format block | Supplied original customer source is XLSX. Current Outlook/document pipeline only ingests PDF. | Either send/convert the original PO to PDF or add a separate XLSX ingestion pipeline. Do not derive from PT/checklist/export. |
| HAMRICKS | Profile registered | Safe source block | No original customer-issued hardcopy sample supplied. | Provide at least one original Hamrick's PO PDF. |
| IPC | `ipc` verified | Blocked | PDF Pickup Date says `5/8/26`; special instruction says `05/08/25`. PDF payment terms conflict materially with Customer Master `PP / PREPAY`. Cancel date and size bucket evidence are also absent. | Customer must correct the contradictory date and terms. Print cancel date and explicit size/quantity detail. |
| ITSFASHION | Cato Corporation family verified | Blocked | One PDF contains 6 separate POs. Current InternalOrder/document model is one order per source document. Legal entity alone also does not identify banner. | Send one PO per PDF or add a multi-order document splitter before persistence. Preserve ITSFASHION metadata upstream. |
| MACYSBACKS | `macysbacks` verified | Needs mapping | PDF has Start Ship and `In DC By`, but no explicit Order Date or Cancel Date. `In DC By` is not silently relabeled as Cancel Date. | Print explicit Order Date and Cancel Date. |
| MANDEE | Profile registered | Safe source block | No original customer-issued hardcopy sample supplied. | Provide at least one original Mandee PO PDF. |
| MARSHALLS | `marshalls` verified | Needs mapping | Supplied document is Routing and Distribution Instructions, not a priced PO. It lacks unit cost and size ratio/distribution. | Send the priced PO together with the routing document, or a single source containing unit cost and size breakdown. |
| MESALVEINC | `mesalve` verified | Parsed | Exact ship-to and official master resolution complete the strict fields. | Keep current source quality. |
| OLLIES | `ollies` verified | Parsed on canonical and Batch01 samples | Official Store Master CSV rows for OLLIES contain unquoted commas and shifted columns. Exact Customer+Store keys and exact printed UPCs are still usable. | Fix Store Master export quoting or provide XLSX/valid CSV. Runtime V8 quarantines shifted descriptive columns and keeps exact key evidence only. |
| SHOE4500 | `shoeshow` verified | Needs mapping | Source does not provide a safely mappable A2000 Store/DC. | Print authoritative Ship To/DC/store identifier. |
| SPENCER | Legacy parser exists | Safe unmatched-layout block | No canonical original hardcopy sample was supplied for regression testing. | Provide one original Spencer Gifts PO PDF before enabling unmatched layouts automatically. |
| TILLYS | `tillys` verified | Needs mapping | Logo/headquarters artwork is not authoritative Ship To. Source does not provide a safe Store/DC mapping. | Print authoritative Ship To/DC/store identifier. |
| TJMAXX | `tjmaxx` verified | Needs mapping | PO explicitly requires separate Routing and Distribution Instructions and does not contain one authoritative destination. | Supply the routing document with the PO or an authoritative destination identifier. |
| VARIETYWHO | `variety` verified | Blocked | PDF prints NET60 while Customer Master says `C4 / CIT NET45`. One printed trailing `-07` style also maps to a base style with multiple official colors, so color and size bucket are ambiguous. | Resolve terms discrepancy. For ambiguous line print actual color code/UPC and size breakdown. `07` is not treated as COLOR_NO. |
| VERSONA | Cato Corporation family verified | Blocked | With explicit VERSONA upstream hint the order/lines resolve, but PDF terms materially conflict with Customer Master `6C / CIT NET60`. Legal entity alone remains banner-ambiguous. | Correct PDF/master terms discrepancy and retain VERSONA metadata in subject/document record. |
| ZUMIEZ | `zumiez` verified | Parsed | Canonical sample resolves using source PDF plus official masters. | Keep current source quality. |

## Official Customer Master Terms coverage

All 23 registered profiles have a nonempty official Customer Master Terms code after the explicit Gordon alias is applied:

```text
10BELOW     6C
BEALLSOUTL  X6
CARNIVAL    C6
CATO        6C
CITI        X6
COLONY      C3
GABRIELBRO  C7
GORBRORET   C6   (external label GORDONRBO)
HAMRICKS    C3
IPC         PP
ITSFASHION  C6
MACYSBACKS  C6
MANDEE      3A
MARSHALLS   X6
MESALVEINC  6C
OLLIES      3A
SHOE4500    C3
SPENCER     C6
TILLYS      C6
TJMAXX      X6
VARIETYWHO  C4
VERSONA     6C
ZUMIEZ      6C
```

## Store Master source defect found

The official `stores_master.csv` header has 50 columns. The supplied file contains 2,696 rows whose parsed column count differs from the header. The affected rows show unquoted commas inside text fields.

Old behavior risk:

```text
unquoted comma in St Name / address
→ later columns shift
→ city/state/postal/Active/WH may be read from the wrong positions
```

V8 behavior:

```text
malformed row
→ preserve Customer + Store keys
→ blank shifted descriptive fields
→ mark source_row_status
→ no address/default/WH enrichment from the malformed row
```

Recommendation to the data owner: export Store Master as valid quoted CSV or XLSX. The runtime guard is defensive, but the source file should still be corrected.
