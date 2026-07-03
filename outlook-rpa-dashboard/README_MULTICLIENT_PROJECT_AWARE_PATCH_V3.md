# Patch v3: multi-cliente respetando web + Supabase + exports A2000

Este patch está hecho para el proyecto real `outlook-rpa-dashboard`, no para un script suelto.
No reemplaza la web, no borra Supabase y no cambia el flujo existente de Outlook.

## Flujo que se respeta

1. Web React/Vite (`web/`) permite subir PDFs y verlos.
2. API Express (`api/src/server.js`) expone:
   - `POST /documents/upload`
   - `POST /demo/process-documents`
   - `GET /demo/orders`
   - `POST /demo/export-a2000-batch`
3. Supabase guarda:
   - `documents`
   - `purchase_orders`
   - `purchase_order_lines`
   - `a2000_import_batches`
4. Los parsers solo alimentan ese modelo común.
5. El export sigue saliendo desde `api/src/a2000/exportBatch.js`.

## Qué modifica

- `api/src/po/parsers/cititrends.js`
  - Lee Citi Trends con 1 item o varios items.
  - Soporta vendor style corto como `SENA` y largo como `KS306-S9962`.
  - Extrae SKU largo, UPC, MSRP/list price, cost/sales price, size, qty, descripción y color raw.
  - Deja `style_code` y `color_code` en null porque el PDF de Citi NO trae el STYLE/COLOR interno de A2000.

- `api/src/po/mappers/a2000Defaults.js`
  - Citi: `customer_code=CITI`, `terms_code=X6`, `warehouse_code=PE`, `division_code=X`.
  - No inventa store.

- `api/src/po/mappers/styleColorRules.js`
  - Evita que `SENA` se convierta en STYLE A2000.
  - Citi queda en `needs_mapping` hasta cruzarlo con PT/export/checklist.

- `api/src/a2000/exportBatch.js`
  - Evita exportar Citi usando style crudo del PDF.
  - Para Citi exige `style_code` y `color_code` ya mapeados antes del import.

- `api/src/debug-parse-pdf-batch.js`
  - Permite probar varios PDFs locales sin tocar Supabase.

- `database/schema_multiclient_patch_v3.sql`
  - Agrega `qty_sz2` a `qty_sz18` si faltan.
  - Crea tablas de mapping si no existen.
  - Es idempotente y no borra datos.

- `database/schema_mappings.sql`
  - Corrige el SQL anterior que tenía una coma extra después de `notes text`.

## Resultado esperado

Bealls sigue funcionando y exportando cuando está completo.
Citi se procesa, aparece en la web, guarda header/lines en Supabase, pero queda `needs_mapping` porque faltan tienda, style A2000 y color A2000.

Eso es correcto: el PDF de Citi es fuente del PO y de los items base, pero no trae toda la verdad operativa para A2000.

## Prueba local recomendada

```bash
cd /workspaces/RPA/outlook-rpa-dashboard
SUPABASE_URL=https://example.supabase.co SUPABASE_SERVICE_ROLE_KEY=dummy PDF_TEXT_ENGINE=pdftotext node api/src/debug-parse-pdf-batch.js \
  "test-pdfs/PurchaseOrder-0000187960-00-008769.pdf" \
  "test-pdfs/AMERICAN EXCHANGE-Dept#3277 -PO#1817648-DT#04212026-153028.PDF"
```

Citi esperado:
- parser: `cititrends`
- order_no: `0000187960`
- customer_code: `CITI`
- line_count: `1`
- status: `needs_mapping`

Bealls esperado:
- parser: `bealls`
- order_no: `1817648`
- customer_code: `BEALLSOUTL`
- line_count: `5`
- status: `parsed`
