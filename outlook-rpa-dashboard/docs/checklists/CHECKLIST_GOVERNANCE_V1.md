# Checklist Template Governance V1

## Purpose

Prevent the RPA from choosing whichever historical workbook looks most similar. Runtime now follows the strict policy:

```text
ONE CUSTOMER = ONE CHECKLIST
```

## What changed

- Canonical templates are bundled under `api/checklists/canonical/<CUSTOMER>/CHECKLIST.xlsx`.
- `approved-template-registry.json` is the only runtime source of truth.
- Each template is verified by exact SHA-256 before generation.
- Every customer has an explicit worksheet, header row, data-start row and column map.
- Historical `catalog.json` remains available for research, but cannot select a runtime template.
- Customer aliases normalize to one canonical customer code.
- Customers without an approved template return `CHECKLIST_TEMPLATE_MISSING`.
- Provisional templates return `PROVISIONAL_CUSTOMER_CHECKLIST_TEMPLATE`.
- The generator now fills customer-specific columns instead of relying only on generic header guessing.
- Existing line metadata such as PT, cartons, carton ID, tracking, DC name, department, sub SKU/style/color and retail price is carried into the checklist when the parser actually provides it.

## Supported runtime templates

### Canonical

BEALLSOUTL, CARNIVAL, CITI, COLONY, GABRIELBRO, ITSFASHION, MACYSBACKS,
MARSHALLS, MESALVEINC, OLLIES, SHOE4500, TILLYS, TJMAXX, VARIETYWHO,
VERSONA and ZUMIEZ.

### Provisional

CATO, HAMRICKS and SPENCER.

### Blocked because no checklist was found

10BELOW, GORBRORET, IPC and MANDEE.

The blocked customers are intentionally not assigned another customer's template.

## Validation commands

```bash
npm --prefix api run test:checklists
npm --prefix api run verify:checklists
npm --prefix web run build
```

The canonical verification generates a temporary workbook for all 19 approved/provisional templates and checks that each output remains a valid XLSX.

## Regenerating existing checklists

Dry-run one customer:

```bash
npm --prefix api run repair:checklists -- --customer BEALLSOUTL
```

Apply one customer:

```bash
npm --prefix api run repair:checklists -- --customer BEALLSOUTL --apply
```

Apply one order:

```bash
npm --prefix api run repair:checklists -- --order-id PURCHASE_ORDER_UUID --apply
```

Preview all orders:

```bash
npm --prefix api run repair:checklists -- --all
```

Regenerate all selected orders only after reviewing the dry-run:

```bash
npm --prefix api run repair:checklists -- --all --apply
```

Before applying, the command copies the existing generated checklist directory into `api/backups/`.


## V1.1: deduplicación física por control

La identidad provisional ya no contiene el UUID de `purchase_orders`.
La clave física se calcula con:

```text
canonical_customer_code + internal_control_key
```

El nombre provisional se deriva de:

```text
PENDING-{STORE}-{SHA256(internal_control_key)[0:8]}
```

El reparador selecciona una sola fila representativa por control y prefiere
la fila que tenga `a2000_ctrl_no` o `a2000_seq_order_no`.
