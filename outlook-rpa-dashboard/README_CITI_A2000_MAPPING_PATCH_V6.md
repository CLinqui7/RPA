# Citi A2000 Mapping Patch v6

Este patch completa Citi Trends para el caso validado en A2000:

- Customer PO: `0000187960`
- Store: `4`
- Division: `MJ`
- Header Def. W/H: `HT`
- Line W/H: `PE`
- Terms: `X6`
- Style: `11SENAL`
- Color: `PKA`
- Pick Ticket: `1756205`
- Sales Price: `4.5000`
- Operational Qty: `1200`
- Size distribution: `100,100,200,100,200,200,200,100`

Importante: el PDF Citi trae qty `1206`, pero A2000/PT/export usa qty operativa `1200`. Por eso este patch guarda el total PDF en `raw/pdf_*` y usa el total operativo para import.

## Archivo modificado

```txt
api/src/po/parsers/cititrends.js
```

## Comando de prueba

```bash
cd /workspaces/RPA/outlook-rpa-dashboard

SUPABASE_URL=https://example.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=dummy \
PDF_TEXT_ENGINE=pdftotext \
node api/src/debug-parse-pdf-batch.js test-pdfs/*.pdf test-pdfs/*.PDF
```

Esperado para Citi:

```txt
status: parsed
store_code: 4
division_code: MJ
warehouse_code: HT
line.style_code: 11SENAL
line.color_code: PKA
line.warehouse_code: PE
line.qty_total: 1200
```
