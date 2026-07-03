# Shoe Show parser patch v13

Fixes Shoe Show PDF-only parsing so that when the PO header includes an explicit `STYLE:` field, the parser uses that value as `style_raw` instead of swallowing `STYLE:` and `COLOR:` into the pattern text.

Example fixed:

- Before: `style_raw = "MUDD STORMY STYLE: STORMY13T-TUA COLOR: TAUPE"`
- After: `style_raw = "STORMY13T-TUA"`

The parser remains PDF-only and does not inject A2000 codes such as customer, store, division, warehouse, style_code, or color_code.
