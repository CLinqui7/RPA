# Bealls Style/Color Suffix Patch v5

Este patch corrige el split de estilo/color en Bealls cuando el sufijo de color viene en una línea visual separada.

## Problema corregido

Ejemplo detectado en Bealls PO 1902633:

```txt
159556 ABH4303E-42 Black . NYLON SQUARE SPACE WEEKENDER BAG W FLAT POUCH $9.00 463
-003
```

Antes se estaba interpretando como:

```txt
STYLE = ABH4303E
COLOR = 42
```

Correcto:

```txt
STYLE = ABH4303E-42
COLOR = 003
```

También corrige el caso Bealls PO 1858368 donde el MFG Style se parte así:

```txt
99153227 EHH108-26- Black Tattoo . Eve Twill Tote $11.00 100
EVP
```

Correcto:

```txt
STYLE = EHH108-26
COLOR = EVP
```

## Archivos modificados

```txt
api/src/po/parsers/bealls.js
```

## Pruebas esperadas

Para PO 1858368:

```txt
EHH108-26 / EVP / 100
EHH108-26 / LPT / 194
EHH108-26 / TLP / 191
Total Qty = 485
```

Para PO 1902633, la línea problemática debe quedar:

```txt
ABH4303E-42 / 003 / 463
```

## Comando recomendado

```bash
cd /workspaces/RPA/outlook-rpa-dashboard

SUPABASE_URL=https://example.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=dummy \
PDF_TEXT_ENGINE=pdftotext \
node api/src/debug-parse-pdf-batch.js test-pdfs/*.pdf test-pdfs/*.PDF
```
