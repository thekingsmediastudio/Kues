# Keus API Hub

**Status: the base API Hub is deployed to `https://keus-staging.onrender.com`; its health endpoint returns HTTP 200, and the owner has accessed the console.** A scoped key successfully retrieved the agent manifest, but the first GitHub read invocation returned `connector_request_failed`. The cause was Node's `autoSelectFamily` DNS lookup shape being incompatible with the pinned-address callback; a compatibility fix is implemented locally and passes the 67-test suite, but still needs to be pushed and deployed. The Hub replaces the one-off, memory-only GitHub/Render helper bridges with a self-hosted, login-protected API connection registry. It uses Turso for persistent metadata and does not depend on an Arena session once deployed; it does depend on the user's Render, Turso, and WorkOS accounts and configured credentials.

## What it does

- Provides an owner-only console at `/api-hub` after Keus WorkOS login. Only addresses in `API_HUB_ADMIN_EMAILS` may manage connections.
- Lets an administrator register and edit HTTPS API connections by base URL, authentication type, encrypted credential, optional fixed headers, and an explicit list of named operations. Connector credentials are never returned; leaving the secret blank while editing retains the existing credential, while entering a value replaces it. Fixed headers are also retained when the edit field is blank and can be cleared by entering `{}`.
- Exposes only registered operations; there is no arbitrary URL-forwarding endpoint. The hub resolves and pins public DNS addresses, blocks private/special-use destinations, requires HTTPS, and refuses redirects.
- Stores provider auth and fixed headers encrypted using AES-256-GCM. The encryption key is a server-only Render secret. Connector lists never return credentials or fixed-header values.
- Issues short-lived agent bearer keys (1–90 days) scoped to exact connector operations. A key is displayed once; only its SHA-256 hash is stored. Keys can be revoked in the console.
- Requires `confirmWrite: true` for any non-GET/HEAD operation, in addition to that exact operation being present in the agent key's scope.
- Keeps an audit trail of operation name, method, upstream status, outcome, and time. It deliberately does not log request/response bodies, provider credentials, or headers.
- Redacts common secret fields and the configured credential from returned provider responses.

## Configure before deployment

The Render Blueprint (`render.yaml`) includes two API Hub settings:

- `API_HUB_ADMIN_EMAILS` — enter the exact verified WorkOS email address that should manage the hub. This is a private environment value.
- `API_HUB_ENCRYPTION_KEY` — Render generates a 256-bit value for this setting. Preserve it securely. If it is lost or changed, stored provider credentials cannot be decrypted; re-enter those credentials or restore the original key.

The hub also requires the existing WorkOS staging and Turso environment values described in `RENDER_DEPLOYMENT.md`. Do not put these values in Git, source files, chat, or browser code. Do not deploy the temporary helper bridges as public services.

## Register an API

1. Sign into the deployed Keus service with the allowlisted WorkOS account and open `/api-hub`.
2. Enter a name and public HTTPS base URL, select `Bearer token`, `Custom header`, or `No authentication`, and add the provider credential in the secret field. The secret is cleared from the page after submission and is not shown again.
3. Add optional fixed headers as JSON (for example, a provider-specific `Accept` or API-version header). These headers are encrypted with the auth configuration and are never returned in management responses.
4. Define the operations the hub may expose. Each operation has a unique lowercase name, HTTP method, and path template. `{name}` substitutes one URL-encoded path segment; `{path*}` substitutes a slash-separated path. Put query parameters in the invocation's `query` object, not in the template.
5. To revise a connection, select **Edit** in its card. Change the URL, auth mode, headers, or operations as needed. The secret field is blank: leave it blank to retain the saved credential, or enter a new one to replace it. Leave fixed headers blank to retain them; enter `{}` to clear them. If switching to a different auth mode, provide the required new credential.

Example definition for a repository API (placeholder only; do not paste real credentials into this file):

```json
[
  {"name":"get-repository","method":"GET","path":"/repos/{owner}/{repo}"},
  {"name":"update-file","method":"PUT","path":"/repos/{owner}/{repo}/contents/{path*}"}
]
```

The UI accepts `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, and `DELETE`. A registered write operation is not automatically available to every agent: select it explicitly when issuing a scoped key.

## Agent API

After creating a scoped key in `/api-hub`, store it in the consuming agent's secret manager. Do not put it in source control, a prompt, or a browser bundle.

Get the operations allowed by the key:

```http
GET /api/hub/manifest
Authorization: Bearer khub_<one-time-issued-key>
```

Invoke an operation:

```http
POST /api/hub/invoke
Authorization: Bearer khub_<one-time-issued-key>
Content-Type: application/json

{
  "connectorId": "<id from the manifest or console>",
  "operation": "get-repository",
  "pathParams": {"owner": "thekingsmediastudio", "repo": "Kues"},
  "query": {}
}
```

A write invocation must include `"confirmWrite": true` and its JSON `body`; the key must also have that operation's scope. The hub returns the provider's HTTP status as `upstreamStatus`, separately from the Hub's own HTTP response status.

## Limits and boundaries

- Provider API requests require HTTPS on the standard public port. Private, loopback, link-local, reserved, and special-use IP destinations are blocked. DNS is checked at call time and the chosen public address is pinned for that request.
- Operations accept JSON request bodies up to 64 KiB; provider responses are limited to 1 MiB. JSON and text responses are supported; redirects and other content types are rejected.
- Each agent key has a per-running-instance limit of 60 manifest/invocation calls per minute. Keys expire in at most 90 days and can be revoked immediately. The in-memory rate window resets on service restart.
- The first version is an authenticated REST API, not an MCP server. It can be used by any agent or automation capable of HTTPS requests and bearer authentication.
- Render Free can sleep while idle. The hub is hosted in the user's Render/Turso accounts, but the first call after idle may be delayed. This is staging/hobby hosting, not a production uptime commitment.
