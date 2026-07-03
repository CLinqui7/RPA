# A2000 Color Resolver v18 - Alpha 3 Color Preference

This patch improves the master enrichment color resolver. It does not change PDF parsers.

## New behavior

When the PO prints a color in text and the master has multiple possible A2000 colors, the resolver now ranks matches as follows:

1. Customer-approved preference, validated against the matched style.
   - Example: `CITI + WHITE -> WTB` only if `WTB` exists for that style.
   - Example: `CITI + BLACK-OFF BLACK -> BKA` only if `BKA` exists for that style.
2. Generic alpha-3 rule: prefer a single 3-letter alphabetic color code when it is the only alpha-3 candidate for the detected color family.
   - This avoids choosing numeric codes like `001`, `003`, `076` when a clean 3-letter A2000 color code exists.
   - If multiple alpha-3 candidates exist, the resolver does not guess.
3. Single master match: if the printed color family leaves only one master color, use it.
4. Otherwise, keep `color_code = null` and show candidates under `raw.color_master_candidates`.

## Why this matters

The bot is no longer only using one-off hardcoded values. It normalizes the printed color text, checks the valid colors for the resolved style in the master, prefers 3-letter alphabetic A2000 color codes when safe, and leaves trace fields explaining the decision.

## Expected Citi example

- `JANICET / WHITE` resolves to `WTB` because of the Citi preference and master validation.
- `JANICET / BLACK-OFF BLACK` resolves to `BKA` because of the Citi preference and master validation.

## Trace fields

Each resolved line may include:

- `raw.color_match_rule`
- `raw.color_match_family`
- `raw.color_match_confidence`
- `raw.color_master_candidates`
