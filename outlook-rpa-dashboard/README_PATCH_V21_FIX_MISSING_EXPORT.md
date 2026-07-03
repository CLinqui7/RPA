# Patch v21 - Fix missing hasDownloadedDocumentsForEmail export

Fixes startup error:

SyntaxError: The requested module '../documentRepository.js' does not provide an export named 'hasDownloadedDocumentsForEmail'

The scanner imports this function. Patch v20 overwrote documentRepository.js without that compatibility export.

Behavior:
- If ALLOW_DUPLICATE_DOCUMENTS=true, hasDownloadedDocumentsForEmail returns false, so duplicate email/PDF downloads are accepted.
- If ALLOW_DUPLICATE_DOCUMENTS=false, it checks Supabase documents by email_external_key.
