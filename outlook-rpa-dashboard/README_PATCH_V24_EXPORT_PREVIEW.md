# Patch v24 - A2000 Export + PDF Preview

Agrega al A2000 Lab:

- Botón **Abrir factura**.
- Preview embebido del PDF seleccionado.
- Endpoint `GET /po/pdf-preview` para PDF local, test PDF o documento descargado de Outlook/Supabase.
- Botón **Export Header + Sales**.
- Endpoint `POST /po/export-a2000-import` que genera dos CSV en formato importable:
  - `A2000_IMPORT_HEADERS_*.csv`
  - `A2000_IMPORT_SALES_LINES_*.csv`
- Preview visual de headers y sales lines exportados.

El export solo incluye órdenes `parsed` con header y líneas mapeadas.
