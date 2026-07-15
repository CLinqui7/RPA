# Canonical checklist templates

Runtime checklist generation uses only the templates in this directory.

Rules:

1. One customer has at most one `CHECKLIST.xlsx`.
2. The approved registry stores the exact SHA-256 of every template.
3. Historical catalog scoring is audit-only and cannot select runtime templates.
4. A missing customer-specific template blocks generation instead of borrowing a similar workbook.
5. Provisional templates generate with an explicit warning and must be recertified.

Do not replace a template without updating its SHA-256 and explicit column schema in
`../approved-template-registry.json`, then running:

```bash
npm --prefix api run test:checklists
npm --prefix api run verify:checklists
```
