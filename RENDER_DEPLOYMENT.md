# Keus staging deployment blueprint for Render Free

**Status: not deployed.** This is a proposed setup guide and `render.yaml` blueprint, not evidence of a live Render service, connected WorkOS tenant, or remote database. It does not include credentials or provision external accounts. The proposed free stack is Render Free web service + Turso Free database. Treat it as a public demo/staging environment only: Render explicitly says its Free instances are not for production, sleep after 15 minutes idle (first wake can take about a minute), and have ephemeral filesystems. The SQLite file must never be used as the hosted database; persist auth/users/sessions in Turso. Turso's current Free plan advertises 100 databases, 5 GB storage, 500 million monthly rows read, and 10 million monthly rows written ([plan details](https://turso.tech/pricing)). Render limits are documented at [Deploy for Free](https://render.com/docs/free).

## Blueprint settings

`render.yaml` describes a Node web service in Frankfurt with:

- Free plan, `npm ci` build, and the Keus web server start command.
- `/api/health` health check.
- WorkOS configured only after valid staging secrets are supplied through Render's private environment settings; its presence in the blueprint does not mean sign-in is live.
- Remote Turso URL/token supplied through private environment settings.
- Production cookie behavior and PayPal Sandbox mode.

## One-time setup

1. Put the **contents of the `source/` directory** in a Git repository Render can access, with `render.yaml` at the repository root, then create a Render Blueprint from that repository. This workspace snapshot is not a Git repository and has no remote, so it cannot push or deploy itself; create/connect the repository in your Git provider and Render Dashboard. Never paste a Git access token into chat.
2. Create or select a **Turso Free** database for this staging environment. Copy its database URL and create a database auth token.
3. In the Render service's environment settings, set `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `TURSO_DATABASE_URL`, and `TURSO_AUTH_TOKEN` as private values. Use the WorkOS **staging/test** key and its matching client ID. Never commit these values or send them in chat.
4. Deploy once, then copy the public service origin from Render, for example `https://keus-staging.onrender.com`. Keus derives the callback as `<service-origin>/auth/callback` from Render's `RENDER_EXTERNAL_URL` unless an explicit `WORKOS_REDIRECT_URI` override is provided.
5. Add that exact callback URI to the WorkOS application's allowed redirects. The Keus callback is the destination after WorkOS completes sign-in.
6. In the same WorkOS staging environment, enable Google and GitHub under **Authentication → OAuth providers**. Follow the provider configuration instructions in WorkOS. If using your own Google/GitHub OAuth app credentials, configure the provider callback URI shown by WorkOS in the respective provider console; that is distinct from Keus's `/auth/callback`.
7. After the staging secrets are set, open `/login` on the Render service and test email-code sign-in using a controlled inbox. A first-time verified user should receive a Keus session and go to `/onboarding`; an existing user should go to `/app`. The user confirmed the email-code flow in the local WorkOS test preview, but this does not test the deployed Render environment. Do not claim the hosted deployment works until you test it there.

## Important boundaries

- Use the Render service's public URL for this staging callback, not the agent preview proxy URL.
- Keep staging keys in Render's secret environment settings. Do not put them in `render.yaml`, `.env` files committed to source control, or client-side code.
- Render Free services may sleep while idle. The first request after idle can be slow.
- Keus applies its database migrations during startup; keep Turso credentials configured before the first deployment.
- The repository snapshot currently has no Git remote. Render cannot auto-deploy changes from this workspace until the reviewed source is committed to a linked repository. After that link exists, commits to the configured branch can trigger deploys.
- Production workspace aliases and `/onboarding` require a valid Keus session. This does not imply all product APIs or commerce actions are implemented or authorized.
