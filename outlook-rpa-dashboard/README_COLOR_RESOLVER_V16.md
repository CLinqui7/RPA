# A2000 Color Resolver v16

This patch improves color enrichment without hardcoding only one-off examples.

## What it adds

- Detects printed color families from invoice text: WHITE, BLACK, BLACK-OFF BLACK, PINK, TAUPE, KHAKI, DOVE, RED/BLACK, PINK/BLACK, etc.
- Applies customer-approved preferences only when that color code exists for the matched style in the master.
- Falls back to master-only matching when the printed color family produces one unique color candidate.
- Leaves `needs_mapping` when the color remains ambiguous.
- Adds trace fields:
  - `raw.color_match_rule`
  - `raw.color_match_family`
  - `raw.color_match_confidence`
  - `raw.color_master_candidates`

## Citi examples

- `WHITE` -> prefers `WTB`, then `WHA`, `001`, `076`
- `BLACK-OFF BLACK` -> prefers `BKA`, then `BCB`, `96A`, `003`
- `PINK` -> prefers `PKA`, then `009`
- `TAUPE` -> prefers `TA2`

These preferences are not blindly assigned. The chosen color must exist for the resolved style in `VR_SKU`.
