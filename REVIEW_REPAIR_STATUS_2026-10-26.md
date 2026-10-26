# Review repair status — 2026-10-26

This note records changes and checks made to the extracted working copy after the read-only review. The Google Drive source archive remains unchanged.

## Repairs verified in the working copy

- Money policy and agent-envelope validation now reject malformed, non-finite, fractional, missing, non-positive, or out-of-envelope amounts and invalid policy limits.
- Flight-Box receipts use Ed25519 signatures alongside digests; verification requires a trusted public key and rejects missing-key, tampered-body, and altered-signature cases.
- SKILL.md integrity binds both policy and workflow content; the checksum is not described as authenticated authorship.
- Sentinel fails closed when required amount or policy context is missing or invalid.
- Node is pinned to `24.22.1` (LTS as of this review date).
- Onboarding styles are restored for all five steps; desktop passkey is described as planned/not connected, and virtual control is preview-only. Avatar color carries across the supported artwork.
- Earlier in this repair pass, onboarding-created agents were restored from browser-local storage only. That UI-only behavior has since been superseded by `KEUS_SIGNUP_PROVISIONING_IMPLEMENTATION_2026-10-26.md`: completed onboarding now saves to the signed-in account workspace and desktop bootstrap reloads it from the shared database.
- Desktop app options and sample shopping, seller, approval, and watch states are clearly labelled as preview-only/not connected.
- New Agent dialog has dialog semantics, initial focus, Tab containment, Escape/backdrop closing, and focus restoration.
- Static page routing and assets are explicitly allowlisted; unknown paths return 404. In production, desktop workspace aliases require a valid Keus session and fail closed if auth storage is unavailable.
- Same-origin API checks no longer trust a matching untrusted Referer or Sec-Fetch-Site value; cross-origin access requires an explicit allowlist entry.
- Roadmap, auth, and Render notes distinguish source code from verified provider setup/deployment and record that no live commerce/payment integration is claimed.

## Verification completed

- `npx --yes node@24.22.1 --test tests/unit/*.test.mjs`: **51/51 passed**.
- `npm audit --omit=dev`: **0 reported vulnerabilities**.
- Inline JavaScript syntax in desktop, onboarding, login, auth-verify, and pocket pages: **5/5 passed** under Node 24.22.1.
- Chromium onboarding checks passed at **1440×1000** and **375×812**: all five steps styled, no horizontal overflow, wallet avatar responds to a color change, no page errors.
- Chromium end-to-end local preview check: onboarding agent appears in desktop, remains present and selected after reload, and appears only once. New Agent dialog keyboard checks passed; no external network requests were made.
- Local server route tests cover production auth guard behavior with fixture sessions, unknown/static paths, explicit assets, invalid Origins, and proxy scheme handling.

## Still incomplete / explicitly not claimed

- This is not a live commerce product: no Channel3, Workers AI, KERNEL, PayPal transaction, remote Turso, real email-code delivery, server-side transaction WebAuthn, purchase flow, or capture/refund flow was used or tested.
- The production guard protects the desktop workspace aliases and `/onboarding`; it is not a complete authorization layer for future data/action APIs.
- Non-onboarding preview-only UI state remains browser-local and is not synchronized across devices. Completed onboarding profile and its paused starter-agent record are now account/workspace-scoped in the shared database; unfinished form drafts remain account-keyed in local storage.
- The Render file is only a proposed blueprint; no deployment is claimed.
- No production/deployed-origin, physical-device, or formal security/accessibility certification was performed.
- The separate `Tempo.glb` export was completed and verified on 2026-10-26; it remains a separate deliverable outside this original source-repair archive.

## Preservation

- Original Drive ZIP SHA-256: `e909abf9edf36fd92246fa9c8ab4ccc54cc7a41db66359729fbcc8ecf77f265b`.
- The repaired source archive is stored alongside the original in `CueClaw — Project Backup & Assets — 2026-10-24` as `CueClaw_Project_Backup_2026-10-26_REPAIRED_FINAL.zip`; its separate `.sha256.txt` checksum is in the same folder. Do not replace the original archive.
## Keus UI simplification pass — 2026-10-26

The workspace screens were simplified and the user-facing brand spelling aligned to Keus. Decorative window dots were removed; the sidebar now has a clear Settings control; the demo status is informational rather than an unexpected attack-test button; the duplicate microphone control (which opened a call preview rather than recording) was removed. Teammate selection now supports keyboard input and exposes selected state. A phone-view shortcut appears on narrow screens, and the sample web/phone preview stacks instead of squeezing into tiny columns.

Mobile onboarding now stays inside the viewport: the fixed footer no longer covers the form, the name/role fields appear before the avatar preview on phones, and the color/avatar picker stacks cleanly with all choices contained. Existing sample/preview-only boundaries and interactions were preserved.

Verification for this pass:

- Browser smoke checks at 1440×1000, 768×1024, 390×844, and 320×720: **no horizontal overflow or page errors**.
- Desktop search, keyboard teammate selection, Add-menu demo action, settings, voice preview, and chat send: **passed**.
- Mobile onboarding footer/scroll separation, avatar/color/name/role editing, back/continue, and all five-step navigation: **passed**.
- No external network requests during the browser checks.
- `npx --yes node@24.22.1 --test tests/unit/*.test.mjs`: **51/51 passed**.
- `npm audit --omit=dev`: **0 vulnerabilities**.
- Inline JavaScript syntax checks: **5/5 passed**.

Browser review script and evidence: `cueclaw-review/qa/ui-simplification-review.py`, `ui-simplification-results.json`, and the `ui-refresh-*.png` screenshots. The app remains a prototype; this pass does not claim live integrations or production deployment.

## Screenshot-driven layout and icon follow-up — 2026-10-26

A second pass addresses the supplied screenshots. The desktop header no longer competes with redundant status/focus controls at intermediate widths; approval cards now expose two short, readable primary controls and place optional demo actions under a collapsed “More preview options” disclosure; approval details reflow from two columns to one at small widths; app configuration uses a four-square Apps glyph rather than a puzzle piece, and payment details use a card glyph. All actions remain local demo/preview behavior.

Verification for this follow-up:

- `qa/layout-overflow-review.py`: **passed** at 1440, 1024, 900, 768, 640, 480, 390, and 320 px. No document/header horizontal overflow, action-label clipping, or browser page errors.
- Browser interaction checks: optional actions start collapsed and expand; the virtual-keyfob action updates only its local preview badge; app and payment icons match their meaning.
- `npx --yes node@24.22.1 --test tests/unit/*.test.mjs`: **51/51 passed**.
- `npm audit --omit=dev --json`: **0 vulnerabilities**.
- Inline JavaScript syntax checks: **6/6 passed**.
- Screenshots and machine-readable results are in `cueclaw-review/qa/layout-refresh-*.png` and `cueclaw-review/qa/layout-overflow-results.json`.

The earlier UI-refresh ZIP remains a preserved first-pass snapshot; the screenshot-driven changes are packaged separately as a versioned follow-up. No prior source archive or backup was replaced.

- New archive: `Keus_UI_Layout_Fix_2026-10-26_v2.zip` (156 payload files, 11,069,377 bytes; SHA-256 `b88e01aae54412284e7a04c23720f53851a046b8fee0f1b84fdcf213508c6e73`). ZIP integrity test passed.
- Uploaded alongside its checksum in the existing Drive folder `Project Deliverables — 2026-10-26`: archive file ID `1YZqseXCrj5xh2U262owQuqFUebSJ3nft`; checksum file ID `1DeO_yMAfGh7Ns4fjnqfoPqquPWDJstUF`.
- To meet the workspace storage quota, redundant local UI ZIP copies were removed after confirming their Drive uploads. Their local SHA-256 sidecars, project source, and QA evidence remain; no historical backup was deleted from Drive.
- Latest full-source slider/responsive package: `Keus_UI_Slider_Responsive_Refresh_2026-10-26_v3.zip`, 6,246,029 bytes, SHA-256 `2d354758f86d9976b2b05c2dd2f18ca6217c29ba97cbd657b9b01b1177911c5d`; uploaded and verified in the existing Drive folder (archive ID `1fiP_uFSc6cmhXQYtNEqU-WNVJr8YnMKF`, checksum ID `1KQZA4ekujpQqGfeHfJzUa4W1hp8vKwtM`). The local ZIP was removed after upload; source, QA, and checksum sidecar remain in the workspace.

## Slider and responsive interaction refresh — 2026-10-26

The spend-cap sliders now share a clearer interaction style: color-coded gold/blue progress tracks, larger high-contrast thumb targets, current-value chips, min/max scales, and synchronized `aria-valuetext`. The controls continue to support keyboard adjustment, touch dragging, and existing local preview updates. The onboarding cap controls use the same system.

Settings dialogs were adjusted for phone-sized screens: navigation becomes a scrollable horizontal tab strip that centers the selected section, panels use the available viewport height, and narrow card/form grids reflow to avoid squeezed text. Payment-card labels stack on very narrow screens. The remaining app-settings puzzle glyph was replaced for consistency.

Verification:

- `qa/slider-responsive-review.py`: **passed** at 1440, 1024, 900, 768, 640, 480, 390, and 320 px; settings dialogs stay within the viewport; sliders update the visible value, accessible value, and filled track together; keyboard arrow adjustment and mobile tab/card layout passed.
- Onboarding order/daily cap controls and value summaries passed at the same eight widths; **no browser page errors**.
- `npx --yes node@24.22.1 --test tests/unit/*.test.mjs`: **51/51 passed**.
- `npm audit --omit=dev --json`: **0 vulnerabilities**.
- Inline JavaScript syntax: **6/6 passed** from current desktop, onboarding, login, auth-verify, pocket, and development setup pages.
- Evidence: `cueclaw-review/qa/slider-responsive-results.json`, `slider-*.png`, and `slider-responsive-review.py`.

## Keus sign-in foundation — 2026-10-26

The website pass begins at sign-in. `apps/web/public/login.html` now has a desktop split welcome/sign-in layout with a clear example-team preview, and a focused form-first mobile layout. Styling is self-contained and responsive. Existing email-code, verification, cooldown, session, and WorkOS provider behavior is preserved. The local preview now states plainly when sign-in is not enabled and confirms no code was sent; provider buttons remain disabled unless configured. No authentication is simulated or claimed as live.

Verification:

- `qa/sign-in-responsive-review.py`: **passed** at 1440, 1024, 900, 768, 640, 480, 390, and 320 px; no horizontal overflow or page errors.
- Mocked (local-only) browser flow passed: configured email request → six-digit code cleanup → verification → redirect. No real email or credentials were used.
- The unconfigured state and disabled provider controls were checked; no external network requests were made.
- `npx --yes node@24.22.1 --test tests/unit/*.test.mjs`: **51/51 passed**.
- `npm audit --omit=dev --json`: **0 vulnerabilities**.
- Inline JavaScript syntax: **6/6 passed**.
- Screenshots/results: `cueclaw-review/qa/sign-in-after-1440.png`, `sign-in-after-390.png`, and `sign-in-responsive-results.json`.
- Full source snapshot backed up as `Keus_Sign_In_Web_Foundation_2026-10-26_v4.zip`, 6,851,611 bytes, SHA-256 `0d743259dedcc3737e5ff104727f6d385cae864af81d0455c4008ec351961927`; Drive archive ID `19QXe9UoRFRtiaQR6LU0uerSihlr9mU6K`, checksum ID `1JYPghH7RICKnfh1fY64BUNMEq564tNvs`. The local ZIP was removed after upload to stay within workspace storage quota; its checksum sidecar, source, and QA remain local.

Next website stage can proceed from this sign-in entry into onboarding. Real sign-in requires WorkOS/email delivery setup; that has not been configured or deployed.

## Active Keus branding update — 2026-10-26

The active website surfaces now use Keus branding and a new local Keus SVG icon/wordmark. Health metadata, email labels/tags, setup metadata, and visible copy were updated. Old CueClaw image URLs redirect to the Keus assets; browser state and local-database migration/fallback preserve existing data. Compatibility-only identifiers remain where needed for old storage, routes, database files, and setup headers. The preserved historical backup and older brand kit were not overwritten.

- Unit tests after this change: **51/51 passed**.
- Details: `KEUS_BRANDING_UPDATE_2026-10-26.md`.
- No live auth provider, email delivery, or production deployment was configured or claimed.

## Sign-in and sign-up methods — 2026-10-26

The `/login` surface now has distinct **Sign in** and **Create account** modes. Email remains a six-digit WorkOS Magic Auth flow. Separate Google and GitHub buttons call provider-specific OAuth routes; the existing state-cookie/callback/session path is retained and unsupported provider values are rejected. The first verified identity creates a local Keus user or links to the matching existing verified email. Google/GitHub buttons default disabled and only enable when each matching WorkOS Dashboard connection and server-side feature flag are configured. The isolated browser preview continues to suppress OAuth because its callback cannot reach the local preview server. The user selected **open self-service registration** rather than invite-only; keep new-user sign-up enabled in WorkOS.

- `npx --yes node@24.22.1 --test tests/unit/*.test.mjs`: **55/55 passed**.
- `qa/sign-in-responsive-review.py`: **8 viewport widths passed**; create-account email flow and GitHub OAuth handoff stub passed; no browser errors and no real email/provider request.
- Inline JavaScript syntax: **6/6 passed**.
- `npm audit --omit=dev`: **0 vulnerabilities**.
- Implementation and setup detail: `KEUS_AUTH_METHODS_IMPLEMENTATION_2026-10-26.md` and `AUTH_SETUP.md`.

User-reported verification update (2026-10-26): test-mode WorkOS email-code login succeeded end-to-end in the port-3100 preview using an inbox under the user's control. This confirms the test-mode email login path only; production email delivery, the separate open-sign-up account-creation path, and Google/GitHub OAuth remain unverified. Social OAuth still needs enabled WorkOS providers, server-side flags, and a reachable registered callback. Do not represent the test-mode result as production authentication.

## Registration handoff repair and free-hosting plan — 2026-10-26

The user reported that email registration created an account but appeared to do nothing afterward. Keus identity provisioning now returns `isNewUser`. First-time email and social accounts are directed to `/onboarding`; existing accounts continue to `/app`. The onboarding route is included in the production session guard and is available in the sign-in-only preview. The behavior is covered by unit tests, but still needs a new-account browser test after restarting the preview or on the hosted service.

The proposed free demo/staging host is Render Free plus Turso Free. `render.yaml` now uses the `keus-staging` service name, keeps Google/GitHub disabled by default, and uses Turso for remote auth/session persistence. No repository, Render service, or Turso database has been connected or deployed. Render states that Free services are not for production; they spin down after 15 minutes without traffic and their local files are ephemeral. See `RENDER_DEPLOYMENT.md` for setup steps and limits.

Verification for this change:

- `npx --yes node@24.22.1 --test tests/unit/*.test.mjs`: **56/56 passed**.
- Inline JavaScript syntax: **6/6 passed**.
- `render.yaml` parses successfully.
- Registration redirect has not yet been confirmed by the user after the source change; the existing port-3100 process still runs the previous server module and holds temporary WorkOS test credentials only in memory.
