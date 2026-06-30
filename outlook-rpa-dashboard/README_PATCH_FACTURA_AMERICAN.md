# Patch MVP: Outlook descarga PDFs con asunto "factura american"

Este patch convierte el scanner de Outlook en un intake básico de documentos.

Flujo actual:

1. Playwright abre Outlook Web usando el perfil persistente `api/.auth/outlook-profile`.
2. Busca correos según `OUTLOOK_SEARCH_QUERY`.
3. Abre cada correo visible.
4. Si el asunto contiene `INVOICE_SUBJECT_FILTER`, intenta descargar adjuntos PDF.
5. Guarda el PDF localmente en `api/downloads/invoices`.
6. Sube el PDF a Supabase Storage, bucket `po-documents`.
7. Crea un registro en la tabla `documents`.

Todavía no lee ni parsea el PDF. Eso queda preparado para la siguiente fase.

## Archivos cambiados

- `api/src/config.js`
- `api/src/rpa/outlookScanner.js`
- `api/src/runScan.js`
- `api/src/server.js`
- `api/src/documentRepository.js`
- `api/.env.example`
- `database/schema.sql`

## Variables nuevas

```env
OUTLOOK_SCAN_MODE=search
OUTLOOK_SEARCH_QUERY=subject:"factura american" hasattachments:yes
INVOICE_SUBJECT_FILTER=factura american
INVOICE_DOWNLOAD_ONLY_MATCHING=true
INVOICE_STORAGE_BUCKET=po-documents
INVOICE_LOCAL_DOWNLOAD_DIR=downloads/invoices
```

## Endpoint nuevo

```http
GET /documents
```

Devuelve los PDFs guardados en Supabase.
