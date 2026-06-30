# Demo A2000 Batch: PDF → Supabase → Header CSV + Lines CSV

Esta demo NO intenta importar automáticamente a A2000. Hace el primer flujo presentable:

1. Toma PDFs ya descargados desde Outlook y guardados en `documents`.
2. Lee el PDF con `pdf-parse`.
3. Detecta parser por customer: Bealls, Gabe's o Citi Trends.
4. Extrae header + lines a tablas Supabase.
5. Exporta 2 CSV agrupados:
   - Header batch
   - Lines batch

## SQL necesario

En Supabase SQL Editor ejecuta:

```sql
-- database/schema_demo.sql
```

## Instalar dependencia nueva

```bash
cd /workspaces/RPA/outlook-rpa-dashboard
npm --prefix api install
```

## Procesar PDFs descargados

```bash
cd /workspaces/RPA/outlook-rpa-dashboard
npm --prefix api run demo:process
```

O por API:

```bash
curl -X POST http://127.0.0.1:4100/demo/process-documents \
  -H 'Content-Type: application/json' \
  -d '{"limit":20}'
```

## Ver órdenes extraídas

```bash
curl http://127.0.0.1:4100/demo/orders
```

## Exportar batch CSV

```bash
npm --prefix api run demo:export
```

O por API:

```bash
curl -X POST http://127.0.0.1:4100/demo/export-a2000-batch \
  -H 'Content-Type: application/json' \
  -d '{"includeNeedsMapping":true}'
```

Los archivos se guardan en:

```text
api/exports/a2000/YYYY-MM-DD/
```

## Importante

Los CSV son de demo/revisión. Los campos faltantes de A2000 quedan visibles en `MISSING_FIELDS`.

Eso es intencional: para A2000 real no debemos inventar `customer_code`, `store_code`, `division_code`, `terms_code`, `warehouse_code`, `style_code` o `color_code`.
