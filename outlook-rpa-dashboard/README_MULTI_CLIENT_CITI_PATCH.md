# Patch multi-cliente: mantener Bealls y agregar Citi Trends

Este patch NO elimina el parser Bealls. Mantiene la arquitectura de parsers por cliente y mejora Citi Trends.

## Qué cambia

- `api/src/po/parsers/cititrends.js`
  - Lee Citi Trends con 1 item o varios items.
  - Soporta vendor style corto como `SENA` y estilos largos como `KS306-S9962`.
  - Extrae `Customer SKU`, `UPC`, `MSRP`, `Cost`, `Size`, `Qty`, descripción y color visual.
  - Marca `STYLE/COLOR_NO` de A2000 como pendientes, porque el PO de Citi NO trae el estilo interno A2000.

- `api/src/po/mappers/a2000Defaults.js`
  - Defaults Citi: `CUST_NO=CITI`, `TERM_NO=X6`, `DEF_WHOUSE=PE`, `DIV_NO=X`.

- `api/src/po/mappers/styleColorRules.js`
  - Evita convertir `SENA` en `STYLE` interno A2000.
  - Citi queda en `needs_mapping` hasta que se cruce con PT/export/checklist.

- `api/src/a2000/exportBatch.js`
  - Evita que Citi se exporte a A2000 usando vendor style crudo.
  - Para Citi, exige `style_code` y `color_code` ya mapeados.

- `api/src/debug-parse-pdf-batch.js`
  - Script para probar varios PDFs de una sola vez.

## Resultado esperado

Bealls sigue parseando como antes.
Citi se detecta como `cititrends`, extrae PO/items, pero queda `needs_mapping` porque faltan tienda, estilo A2000 y color A2000.

Eso es correcto para Citi: el PDF es fuente de PO/item base, y el PT/export/checklist completa el import final.
