# Patch v22 - A2000 Lab correos/Supabase + master path note

Agrega en A2000 Lab una fuente de datos nueva: Correos / Supabase.

Endpoints nuevos:
- GET /po/email-documents
- POST /po/parse-email-documents

La web ahora permite alternar entre:
- Correos / Supabase: documentos descargados por Outlook RPA y guardados en Supabase/documents.
- Test PDFs: archivos locales en test-pdfs.

IMPORTANTE para masters:
Levantar API con:
A2000_MASTER_DIR=/workspaces/RPA/outlook-rpa-dashboard/api/masters
A2000_MASTER_CACHE_DIR=/workspaces/RPA/outlook-rpa-dashboard/api/masters/cache

