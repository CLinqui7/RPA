# Patch v20: aceptar duplicados + leer correo Factura American + arreglar test-pdfs

## Incluye

- `api/src/server.js`
  - Corrige la ruta de `test-pdfs` usando la raíz real del proyecto.
  - Mantiene endpoints `/po/test-pdfs` y `/po/parse-test-pdfs`.

- `api/src/runRepository.js`
  - Acepta duplicados de correos creando un `external_key` único por corrida.
  - Guarda el identificador original en `raw.original_external_key`.

- `api/src/documentRepository.js`
  - Acepta PDFs duplicados creando `external_key` y `storage_path` únicos por corrida.
  - Guarda el hash del PDF y el identificador original para auditoría.

- `api/src/runScan.js`
  - Pasa el `run.id` a correos y documentos.
  - Deja logs claros de cuántos correos leyó y PDFs descargó.

## Variables recomendadas

```bash
INVOICE_SUBJECT_FILTER="factura american"
OUTLOOK_SCAN_MODE=search
OUTLOOK_SEARCH_QUERY="factura american"
ALLOW_DUPLICATE_EMAIL_EVENTS=true
ALLOW_DUPLICATE_DOCUMENTS=true
```

## Probar PDFs

```bash
curl -s http://127.0.0.1:4100/po/test-pdfs
curl -s -X POST http://127.0.0.1:4100/po/parse-test-pdfs | head -c 1000
```

## Leer correo Outlook

```bash
curl -s -X POST http://127.0.0.1:4100/run-scan
```

Si no lee correos, revisar login:

```bash
OUTLOOK_HEADLESS=false npm --prefix api run login
```
