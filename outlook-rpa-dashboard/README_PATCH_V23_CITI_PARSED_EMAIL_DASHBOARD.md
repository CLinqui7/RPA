# Patch v23 - Citi aggressive parsed + email documents in dashboard

- Factura American dashboard now lists PDFs downloaded from Outlook/Supabase as cards, even when the email event subject was parsed as a body fragment.
- A2000 Lab finalizes Citi records aggressively for operational review:
  - CITI warehouse fallback: PE.
  - CITI store fallback: SAME.
  - Text colors prefer 3-letter A2000 codes when available.
  - WHITE prefers WTB/WHA; BLACK-OFF BLACK and BLACK prefer BKA/BCB.
  - If no 3-letter color exists for the style, the first valid master candidate is used instead of blocking.
  - If Citi master UPC remains ambiguous, the invoice customer UPC is used as the operational UPC fallback and traced in raw.upc_match_rule.
- Remaining missing fields are recalculated so Citi can become parsed when operational fields are available.
