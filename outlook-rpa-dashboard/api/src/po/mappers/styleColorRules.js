// MASTER-ONLY POLICY
// ------------------
// This module intentionally does NOT translate customer printed style/color
// strings into final A2000 STYLE or COLOR_NO values.
//
// Customer parsers preserve style_raw/color_raw and may attach explicit raw
// semantics such as UPC, exact SKU candidate, or STYLE-COLOR suffix. Final
// A2000 codes are resolved later by enrichOrderWithMasters() using only the
// official Customer/Store/VR_SKU/VR_UPC_STYLE/VR_COLOR/Warehouse masters.
//
// Keeping this normalization layer code-free prevents a short printed token
// such as WHITE, 003, or ABC from silently becoming an A2000 color code just
// because it looks code-like.
export function normalizeStyleColor() {
  return {
    style_code: null,
    color_code: null
  };
}
