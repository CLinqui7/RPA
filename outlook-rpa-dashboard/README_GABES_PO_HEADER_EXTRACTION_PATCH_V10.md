# Gabe's PO header extraction patch v10

This patch replaces `api/src/po/parsers/gabes.js`.

Purpose:

- Make Gabe's PO number extraction stricter and more explicit from the Purchase Order PDF itself.
- Read the complete PO value that appears beside/under the `Purchase Order` title, including the final suffix such as `JR`.
- Accept values like `100-0012002783 JR` and similar 9-12 digit Gabe's PO bodies after the dash.
- Do not derive the PO number from PT, Pull Sheet, checklist, export, or A2000.

Expected for `12002783.pdf`:

- `order_no`: `100-0012002783 JR`
- `raw.order_no_source`: `purchase_order_header_or_po_text`

Note:

This patch does not change the current enrichment behavior for Gabe's style/color/div/warehouse/store. It only makes the PO extraction source clear and more robust.
