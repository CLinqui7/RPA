# Patch v19 - Factura American Scope + test-pdfs path fix

Este patch hace tres cosas:

1. Arregla el error de la web `ENOENT ... /api/test-pdfs`.
   - Ahora el API busca `test-pdfs` tanto desde la raíz del repo como desde `/api`.
   - También soporta `A2000_TEST_PDF_DIR` si quieres una ruta personalizada.

2. Filtra el dashboard por asunto `factura american`.
   - `/events` ahora devuelve solo eventos cuyo asunto coincide con `INVOICE_SUBJECT_FILTER`.
   - La web también aplica el mismo filtro como segunda barrera.
   - El botón dice `Revisar Factura American`.

3. Oculta el cuerpo completo del correo en el dashboard.
   - Se mantiene resumen operativo y datos extraídos.
   - No se muestra `body_text` completo.

## Variables recomendadas

En `api/.env`:

```bash
INVOICE_SUBJECT_FILTER="factura american"
```

## Probar A2000 Lab

```bash
cd /workspaces/RPA/outlook-rpa-dashboard
curl -s http://127.0.0.1:4100/po/test-pdfs
curl -s -X POST http://127.0.0.1:4100/po/parse-test-pdfs | head -c 1000
```

## Probar filtro de dashboard

```bash
curl -s "http://127.0.0.1:4100/events?subject=factura%20american" | head -c 1000
```

## Limpieza opcional de eventos viejos

Ver `database/optional_cleanup_factura_american.sql`.
