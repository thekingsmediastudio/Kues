# Keus active-branding update, 2026-10-26

Active app pages now display Keus rather than the previous CueClaw name. The desktop, onboarding, phone, sign-in, auth verification, and private WorkOS setup pages use Keus branding and the new local SVG icon; current service health and email-delivery metadata also identify Keus. The existing WorkOS/email-code behavior and preview-only boundaries were preserved.

## Compatibility and preservation

- Old CueClaw icon/logo URLs permanently redirect to the corresponding Keus SVG assets.
- Existing browser onboarding/profile/pocket-preview data is read from old CueClaw storage keys, migrated to Keus keys, and then the old key is removed.
- A pre-existing `cueclaw.local.db` file is still selected when no Keus database exists, so existing local auth data is not abandoned. New local setups default to `keus.local.db`.
- The private WorkOS test-setup endpoint accepts the former setup-token header as a compatibility fallback; the page now sends the Keus header.
- Historical CueClaw source archives, workspace paths, the old brand kit, and their checksum data were not overwritten.

## Verification

- `npx --yes node@24.22.1 --test tests/unit/*.test.mjs`: **51/51 passed** after the brand and route changes.
- Unit tests cover the new Keus SVG asset routes, legacy URL redirects, updated health service label, existing authentication behavior, and private WorkOS setup flow.
- Remaining active `cueclaw` strings are compatibility-only (old URLs, storage keys, database fallback, and old setup header); they are not shown as the current product name.
- No live email, OAuth provider, deployment, or external commerce integration was configured or claimed.

Additional post-change checks:

- `qa/sign-in-responsive-review.py` against the updated server: **8 viewport widths passed**, the local mocked email-code flow passed, and there were **0 page errors**.
- Chromium smoke checks on sign-in, desktop, onboarding, pocket, and auth verification: old product name not visible and **0 page errors** on each.
- Inline JavaScript syntax: **6/6 passed**.
- `npm audit --omit=dev`: **0 vulnerabilities** reported.
