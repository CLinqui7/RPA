# Patch v17 - A2000 Extraction Lab Web

Este patch agrega una vista web para revisar visualmente todo lo que extrae el motor A2000 de los PDFs en `test-pdfs`.

## Archivos modificados

- `api/src/server.js`
  - Agrega `GET /po/test-pdfs`
  - Agrega `POST /po/parse-test-pdfs`
  - Usa el parser real + enrichment real con masters.

- `web/src/main.jsx`
  - Agrega navegación `A2000 Lab`.
  - Agrega tarjetas de PDFs, detalle de header, líneas, master lookup, color resolver, candidatos y raw JSON.

- `web/src/styles.css`
  - Agrega estilos para la nueva vista.

## Cómo probar

Desde `/workspaces/RPA/outlook-rpa-dashboard`:

```bash
# 1. API
PORT=4100 npm --prefix api run dev
```

En otra terminal:

```bash
# 2. Web
npm --prefix web run dev -- --host 0.0.0.0 --port 3000
```

Abrir el puerto `3000` y entrar con `admin / admin123`.

Luego ir a **A2000 Lab** y presionar **Procesar PDFs test**.

## Qué muestra

Por cada PDF:

- Parser detectado
- Status: parsed / needs_mapping / error
- Customer, PO, fechas, terms, division, warehouse, store
- Total qty y amount
- Master lookup: customer, store, warehouse, counts
- Líneas extraídas
- Customer SKU
- UPC factura
- UPC master
- Internal SKU
- Style raw / Style A2000
- Color raw / Color A2000
- Regla del color resolver
- Candidatos style/color/UPC
- Faltantes y conflictos
- JSON completo para auditoría

## Nota

Esta vista no altera datos en Supabase. Es una consola visual de prueba para revisar lo que el motor extrae de `test-pdfs`.
