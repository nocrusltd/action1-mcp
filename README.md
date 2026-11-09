# Action1 MCP Server

[![MCP Compatible](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE)

MCP server for [Action1](https://www.action1.com/) — endpoint inventory, patch visibility, and policy automation via the [Model Context Protocol](https://modelcontextprotocol.io).

Covers the whole Action1 REST API (141 operations), read-only by default. Changes are opt-in in two tiers: `ACTION1_ENABLE_WRITES=true` for everyday writes, plus `ACTION1_ENABLE_ADMIN=true` for account administration. A bad push can break a whole fleet, so both are off unless you turn them on.

## Risk tiers

Every API operation has a tier, assigned in one place (`scripts/gen-api-catalogue.mjs`):

| Tier | Needs | Covers |
|---|---|---|
| read | nothing | every GET (73 operations) |
| write | `ACTION1_ENABLE_WRITES=true` | endpoints, groups, scripts, automations and schedules, update approvals, software repository, custom reports, CVE remediations (36) |
| admin | writes **and** `ACTION1_ENABLE_ADMIN=true` | users, roles, organizations, enterprise, subscription, advanced settings, data sources, agent deployment, deleting or moving endpoints, remote sessions (27) |
| blocked | never | closing the enterprise account (and revoking that), OAuth token minting, binary package upload (5) |

Write and admin tools are hidden from the tool list when their tier is off, and refused if called by name.

## Tools

### Read (always available)

| Tool | Description |
|---|---|
| `action1_navigate` | Discover tools by domain |
| `action1_list_organizations` | List Action1 tenants accessible to the configured credentials |
| `action1_list_endpoints` / `action1_get_endpoint` | Managed devices |
| `action1_list_missing_updates` | Missing patches across an organization |
| `action1_list_endpoint_missing_updates` | Missing patches on one endpoint |
| `action1_list_installed_software` | Installed software, org-wide or per endpoint |
| `action1_list_vulnerabilities` | CVEs detected, optionally per endpoint |
| `action1_list_endpoint_groups` | Endpoint groups |
| `action1_list_policies` | Automation instances |
| `action1_search` | Text search across an organization |
| `action1_get_automation_results` | Status of an automation run, one row per endpoint, including script output |
| `action1_list_api_operations` | Browse every API operation with its tier and whether it is enabled |
| `action1_describe_api_operation` | Parameters and request-body schema for one operation |
| `action1_api_read` | Call any read operation (reports, audit log, scripts, schedules, software repository, users, settings, ...) |

### Write (`ACTION1_ENABLE_WRITES=true`)

| Tool | Description |
|---|---|
| `action1_run_script` | Run an inline PowerShell / Command / Bash script now (SYSTEM on Windows). No reboot unless `reboot_after: true` |
| `action1_reboot_endpoints` | Reboot endpoints, warning the logged-in user first by default (240 min timeout) |
| `action1_deploy_updates` | Deploy specific updates. No reboot unless `reboot_after: true` |
| `action1_set_update_approval` | Approve, decline or reset updates |
| `action1_stop_automation` | Stop a running automation |
| `action1_api_write` | Call any write operation, or any admin operation when `ACTION1_ENABLE_ADMIN=true` |

Run-now tools return an `instance_id`; pass it to `action1_get_automation_results`. Offline endpoints run the job when they reconnect, within `retry_minutes` (default 1440). Targeting the `ALL` endpoint group also needs `confirm_all_endpoints: true`.

### Interactive Device Card (MCP Apps)

`action1_get_endpoint` renders as an interactive device-summary card in MCP
Apps hosts (Claude Desktop/web) — status, OS, user, IP, agent version,
reboot-required, and missing-update counts at a glance; plain-JSON behavior is
unchanged in other hosts. The card is read-only,
neutral by default, and brandable via `window.__BRAND__` injection or
`MCP_BRAND_*` env vars (`MCP_BRAND_NAME`, `MCP_BRAND_LOGO_URL`,
`MCP_BRAND_PRIMARY_COLOR`, `MCP_BRAND_ACCENT_COLOR`, `MCP_BRAND_BG`,
`MCP_BRAND_TEXT`) — no rebuild needed.

### Verified against a live tenant

Every read operation that needs no id beyond the organization, plus the named read tools. `action1_run_script`, `action1_stop_automation`, and endpoint-group create / rename / delete through `action1_api_write`. Not yet fired live: `action1_reboot_endpoints`, `action1_deploy_updates`, `action1_set_update_approval`.

The client retries HTTP 429 using the `retry_after` Action1 returns, up to 60s in total for reads and 20s for writes.

### Regenerating the catalogue

`npm run gen:api` downloads Action1's API docs bundle and rewrites `src/generated/action1-api.ts`. Pass a local spec file to work offline: `node scripts/gen-api-catalogue.mjs spec.json`.

API surface also maps to [PSAction1](https://github.com/Action1Corp/PSAction1) (Action1's MIT-licensed PowerShell module).

## Usage

### Claude Desktop (MCPB)

Install via the MCPB bundle from the [latest release](https://github.com/WYRE-AI/action1-mcp/releases).

Required credentials (created in Action1 → Settings → API Credentials, **non-recoverable on creation — copy immediately**):
- API Key (Client ID)
- Secret
- Region (`NorthAmerica` default; also `NorthAmerica-2`, `Europe`, `Australia`)
- Optional default organization id (for single-tenant use)

### Stdio (direct)

```bash
ACTION1_API_KEY=... \
ACTION1_SECRET=... \
ACTION1_REGION=NorthAmerica \
ACTION1_DEFAULT_ORG_ID=org-... \
ACTION1_ENABLE_WRITES=false \
ACTION1_ENABLE_ADMIN=false \
npx -y github:WYRE-AI/action1-mcp
```

### HTTP

`CONDUIT_S2S_SECRET` is required. If it is empty or a known placeholder (`changeme`, `replace-with-a-real-secret`, and similar), the HTTP server logs an error and exits non-zero. It never prints the secret. Generate one with `openssl rand -hex 32`.

`MCP_HTTP_HOST` defaults to `127.0.0.1` when unset. Set `0.0.0.0` only when `CONDUIT_S2S_SECRET` is set. The container image does that and sets `AUTH_MODE=gateway`. `MCP_HTTP_PORT` (or `PORT`) selects the port and defaults to `8080`.

`MCP_ALLOW_INSECURE_DEV=1` starts HTTP without `CONDUIT_S2S_SECRET`, logs a warning, skips `X-Gateway-S2S`, and binds `127.0.0.1` only. A non-loopback `MCP_HTTP_HOST` (including `0.0.0.0`) refuses to start. A placeholder secret is still rejected. Local development only.

`/health` stays unauthenticated and does not read credentials. The stdio transport does not use `CONDUIT_S2S_SECRET`.

#### X-Gateway-S2S

Every HTTP request except `/health` must include `X-Gateway-S2S` when a secret is configured. The value is `t=<unix seconds>,v1=<hex>`, where the hex is HMAC-SHA256 of the literal string `t=<unix seconds>` keyed with `CONDUIT_S2S_SECRET` (64 lowercase hex characters). The timestamp must be within 300 seconds of the server clock. A missing or invalid header is HTTP 401, before vendor credentials are read.

```bash
TS=$(date +%s)
SIG=$(printf 't=%s' "$TS" | openssl dgst -sha256 -hmac "$CONDUIT_S2S_SECRET" -hex | awk '{print $NF}')
curl -sS http://127.0.0.1:8080/ \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "X-Gateway-S2S: t=${TS},v1=${SIG}" \
  -H "X-Action1-API-Key: $ACTION1_API_KEY" \
  -H "X-Action1-Secret: $ACTION1_SECRET" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

#### Gateway mode (`AUTH_MODE=gateway`)

The Docker image and Compose file default to gateway mode. Every request must include:

- `X-Action1-API-Key`
- `X-Action1-Secret`
- `X-Action1-Region` (optional)
- `X-Action1-Default-Org-Id` (optional)

A request missing the API key or secret gets `401` and does not fall back to `ACTION1_API_KEY` / `ACTION1_SECRET` in the process environment. Those headers are the only credential source for that request.

```bash
docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -p 127.0.0.1:8080:8080 \
  ghcr.io/wyre-ai/action1-mcp:latest
```

Compose refuses to start when `CONDUIT_S2S_SECRET` is unset, publishes `127.0.0.1:8080:8080`, and does not pass static Action1 credentials into the container:

```bash
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" docker compose up
```

#### Single-tenant HTTP (`AUTH_MODE=env`)

Requests still require a valid `X-Gateway-S2S` header. Vendor credentials come from `ACTION1_API_KEY` and `ACTION1_SECRET` when the request does not carry those headers.

```bash
docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -e AUTH_MODE=env \
  -e ACTION1_API_KEY="$ACTION1_API_KEY" \
  -e ACTION1_SECRET="$ACTION1_SECRET" \
  -e ACTION1_REGION=NorthAmerica \
  -p 127.0.0.1:8080:8080 \
  ghcr.io/wyre-ai/action1-mcp:latest
```

Local HTTP without a secret is development-only. It binds `127.0.0.1` and logs a warning:

```bash
MCP_TRANSPORT=http MCP_ALLOW_INSECURE_DEV=1 npm start
```

## Architecture

```
src/
├── index.ts                  # stdio + HTTP transports, tool dispatch, S2S startup
├── s2s-verify.ts             # X-Gateway-S2S HMAC-SHA256 check
├── card.builder.ts           # MCP Apps device-card normalization + brand injection
├── resources.ts              # resources/list + resources/read (ui:// device card)
├── generated/
│   └── device-card-html.ts   # committed vite single-file bundle (npm run build:ui)
├── sdk/
│   └── action1-client.ts     # embedded REST + OAuth client (factor-out candidate
│                             # if surface crosses ~20 tools / 2+ domains)
├── utils/
│   ├── client.ts             # credential resolution (env vs gateway headers)
│   └── types.ts              # DomainHandler interface
├── domains/                  # one file per resource type
│   ├── organizations.ts
│   ├── endpoints.ts
│   ├── policies.ts
│   └── updates.ts
└── __tests__/                # domain tests + MCP Apps contract tests
ui/                           # device-card source (index.html + device-card.ts)
```

Per-request credential isolation via `AsyncLocalStorage` — concurrent requests in HTTP mode never share credentials through `process.env`.

## Development

```bash
npm install
npm run build
npm test
npm run dev      # tsc --watch
npm run lint     # eslint
npm run typecheck
```

## License

Apache-2.0. See [LICENSE](LICENSE).
