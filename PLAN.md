# Implementation Plan: OAuth Support for codex-action

## Overview

Replace the closed-source `@openai/codex-responses-api-proxy` with a custom OAuth-aware proxy that authenticates against the ChatGPT backend using OAuth tokens from a user's ChatGPT Plus/Pro subscription.

The proxy is **not** a thin wrapper around the reference package — `opencode-openai-codex-auth` is an OpenCode plugin, not a standalone server. We extract and adapt its core logic into an HTTP proxy server that lives in this repo.

---

## Phase 1: OAuth Proxy Server

**Goal:** Create a standalone HTTP proxy server that sits between Codex CLI and the ChatGPT backend API.

**Testable:** Yes — fully testable in isolation. Unit test each module, integration test the full proxy with curl.

### 1.1 Create `src/oauth/tokenManager.ts` — Token lifecycle

**Extract from reference:** `lib/auth/auth.ts` lines 122-172, `lib/request/fetch-helpers.ts` lines 29-69

**Functions:**
- `loadTokens(accessToken, refreshToken)` → `TokenState`
- `shouldRefreshToken(state)` → boolean (check `expires < Date.now()`)
- `refreshAccessToken(refreshToken)` → `{ access, refresh, expires }`
  - POST to `https://auth.openai.com/oauth/token` with `grant_type=refresh_token`, `client_id=app_EMoamEEZ73f0CkXaXp7hrann`
- `decodeJWT(token)` → payload (extract `chatgpt_account_id` from claim `https://api.openai.com/auth`)
- `getAccountId(accessToken)` → string

### 1.2 Create `src/oauth/requestTransformer.ts` — Request pipeline

**Extract from reference:** `lib/request/request-transformer.ts`, `lib/request/fetch-helpers.ts`

**Functions:**
- `rewriteUrl(path)` → rewrite `/v1/responses` to full ChatGPT backend URL
- `transformRequestBody(body)` → transformed body
  - Set `store: false` (required by ChatGPT backend)
  - Set `stream: true` (always — response handler detects original intent)
  - Normalize model name (strip provider prefix, map known variants)
  - Strip message IDs from input items (stateless operation)
  - Set reasoning config defaults if missing
  - Add `include: ["reasoning.encrypted_content"]`
  - Remove unsupported params (`max_output_tokens`, `max_completion_tokens`)
- `createHeaders(accessToken, accountId, originalHeaders)` → Headers
  - `Authorization: Bearer <token>`
  - `chatgpt-account-id: <id>`
  - `OpenAI-Beta: responses=experimental`
  - `originator: codex_cli_rs`
  - `accept: text/event-stream`
  - Remove `x-api-key` if present

### 1.3 Create `src/oauth/responseHandler.ts` — Response pipeline

**Extract from reference:** `lib/request/response-handler.ts`

**Functions:**
- `handleResponse(upstreamResponse, wasStreaming)` → Response
  - If original request was streaming: pipe SSE stream through to client
  - If non-streaming: consume SSE, parse `response.done` event, return JSON
- `convertSseToJson(sseText)` → parsed response object
  - Split on newlines, find `data:` lines
  - Parse JSON, look for `type === "response.done"` or `"response.completed"`
  - Return `data.response`
- `mapUsageLimit(response)` → remap 404 usage_limit to 429

### 1.4 Create `src/oauth/modelMap.ts` — Model normalization

**Extract from reference:** `lib/request/helpers/model-map.ts`

- Copy the model normalization map (87 entries → 9 base models)
- `normalizeModel(model)` → normalized model string

### 1.5 Create `src/oauthProxy.ts` — Main proxy server

**Responsibilities:**
- Listen on a dynamic localhost port
- Accept requests from Codex CLI at `/v1/responses`
- Transform and forward to `https://chatgpt.com/backend-api/codex/responses`
- Write server info JSON file (same format as existing proxy)

**Skeleton:**
```
- createOAuthProxy(options) → { start(), stop() }
  - options: { serverInfoFile, accessToken, refreshToken }
  - On start: bind to port 0 (dynamic), write server info file
  - On request: transform → forward → handle response
```

### How to test Phase 1

- Unit test `tokenManager`: mock fetch for refresh, test JWT decode with a crafted JWT, test expiry detection
- Unit test `requestTransformer`: pass in a Codex CLI request body, assert transformed output matches ChatGPT backend format
- Unit test `responseHandler`: feed SSE text, assert correct JSON extraction; test stream passthrough
- Integration test: start proxy on localhost, curl a `/v1/responses` request, verify it transforms correctly (mock upstream or use a test endpoint)

---

## Phase 2: CLI Command for OAuth Proxy

**Goal:** Add a new CLI command to `src/main.ts` that starts the OAuth proxy, so it can be invoked from `action.yml`.

**Testable:** Yes — run `node dist/main.js start-oauth-proxy` locally, verify it starts, writes server info, and accepts requests.

### 2.1 Add `start-oauth-proxy` command to `src/main.ts`

**Options:**
- `--server-info-file <path>` (required)

**Token input:** Read from environment variables `OAUTH_ACCESS_TOKEN` and `OAUTH_REFRESH_TOKEN` (not CLI args — security).

**Behavior:**
1. Read tokens from environment variables
2. Validate tokens are present
3. Decode JWT to extract account ID
4. If access token expired, refresh immediately
5. Start HTTP server on dynamic port
6. Write `{ port, pid }` to server info file
7. Keep process running in foreground (action.yml backgrounds it with `&`)
8. Handle SIGTERM/SIGINT for graceful shutdown

### How to test Phase 2

- Set env vars, run the command, verify:
  - Server info file written with valid `{ port, pid }`
  - Server responds on the reported port
  - `curl -X POST http://127.0.0.1:<port>/v1/responses` reaches the proxy
- Test error cases: missing tokens, malformed JWT

---

## Phase 3: Build & Bundle

**Goal:** Ensure the new code compiles and bundles correctly.

**Testable:** Yes — `pnpm run check && pnpm run build` either passes or fails.

### 3.1 No new npm dependencies needed

- HTTP server: use Node.js built-in `http` module (already available)
- JSON parsing: built-in
- JWT decoding: manual base64 decode (same as reference — no library needed)
- Fetch: Node 20 has global `fetch`

### 3.2 Update esbuild config if needed

- Verify the new files are picked up by the existing `esbuild src/main.ts` entry point (they will be, since they're imported transitively)

### 3.3 Rebuild `dist/main.js`

- Run `pnpm run build`
- Verify `pnpm run check` passes (TypeScript type checking)

### How to test Phase 3

- `pnpm run check` — no type errors
- `pnpm run build` — produces `dist/main.js` without errors
- `node dist/main.js --help` — shows the new `start-oauth-proxy` command

---

## Phase 4: action.yml Integration

**Goal:** Add OAuth inputs, wire auth-mode detection, and connect the OAuth proxy steps. Also update conditionals on all existing steps. This is the final wiring — all code is already built and tested.

**Testable:** End-to-end only (GitHub Actions or `act`). This is intentionally last so everything it depends on is already verified.

### 4.1 Add new inputs to `action.yml`
- `oauth-access-token` (required: false, default: "")
- `oauth-refresh-token` (required: false, default: "")

### 4.2 Add auth-mode resolution step
- New step early in the workflow: `Determine auth mode`
- Logic: if `oauth-access-token` is non-empty → `oauth`, else if `openai-api-key` is non-empty → `api-key`, else → `none`
- Set step output: `auth-mode`
- Fail with clear error if both are provided simultaneously

### 4.3 Update all conditional steps
- Every step currently gated on `inputs['openai-api-key'] != ''` needs updating
- Replace with checks against `auth-mode` output (either `oauth` or `api-key`)
- Steps affected:
  - "Install Codex Responses API proxy" — gate on `api-key` only
  - "Check Responses API proxy status" — gate on `api-key` only
  - "Start Responses API proxy" — gate on `api-key` only
  - "Wait for Responses API proxy" — gate on `api-key` only
  - "Read server info" — gate on `api-key` OR `oauth`
  - "Write Codex proxy config" — gate on `api-key` OR `oauth`
  - "Drop sudo" — gate on `api-key` OR `oauth`
  - "Verify sudo removed" — gate on `api-key` OR `oauth`
  - "Run codex exec" — unchanged (gates on prompt, not auth)

### 4.4 Add OAuth proxy steps

```
[auth-mode == 'api-key']               [auth-mode == 'oauth']
  ├── Install API proxy npm pkg           ├── (no install needed — built in)
  ├── Start API proxy                     ├── Start OAuth proxy
  ├── Wait for API proxy                  ├── Wait for OAuth proxy
  └── Read server info                    └── Read server info
                    \                    /
                     └── Write proxy config
                     └── Drop sudo
                     └── Run codex exec
```

New steps for OAuth path:
- **Start OAuth proxy:** run `node dist/main.js start-oauth-proxy --server-info-file <path> &`
- **Wait for OAuth proxy:** same polling logic as existing proxy wait step

### 4.5 Token security

- Pass tokens via `env:` block (never as CLI args — would show in process list)
- Mask tokens in logs: use `::add-mask::` for both tokens
- Remove tokens from environment after proxy starts (proxy holds them in memory)

### 4.6 Existing proxy steps remain unchanged

- The API key flow stays exactly as-is for backward compatibility
- Only the conditionals change (from checking `openai-api-key` to checking `auth-mode`)

### How to test Phase 4

- Run full workflow with `act` or in GitHub Actions
- Test OAuth mode: provide tokens, verify Codex runs against ChatGPT backend
- Test API key mode: provide API key, verify existing flow still works
- Test no-auth mode: provide neither, verify steps are skipped correctly
- Test both-provided: verify clear error message

---

## Phase 5: Testing & Validation

**Goal:** End-to-end verification and regression testing.

### 5.1 Manual local testing

- Start proxy locally with test tokens
- Send curl requests to verify request transformation
- Verify SSE → JSON conversion
- Verify token refresh flow (set expired token, confirm refresh)
- Verify error handling (invalid token, network failure)

### 5.2 Integration test workflow

- Create `.github/workflows/test-oauth.yml`
- Use `workflow_dispatch` with token inputs
- Run a simple prompt and verify output
- Test both `api-key` and `oauth` modes in same workflow

### 5.3 Regression testing

- Verify existing API key flow is unaffected
- All existing examples still work
- Build still passes (`pnpm run check && pnpm run build`)

---

## File Change Summary

| File | Action | Description |
|------|--------|-------------|
| `src/oauth/tokenManager.ts` | **Create** | Token loading, refresh, JWT decode |
| `src/oauth/requestTransformer.ts` | **Create** | URL rewrite, body transform, header creation |
| `src/oauth/responseHandler.ts` | **Create** | SSE→JSON, stream passthrough, error mapping |
| `src/oauth/modelMap.ts` | **Create** | Model normalization map |
| `src/oauthProxy.ts` | **Create** | HTTP proxy server (ties it all together) |
| `src/main.ts` | Modify | Add `start-oauth-proxy` command |
| `action.yml` | Modify | Add inputs, auth-mode step, OAuth proxy steps, update conditionals |
| `dist/main.js` | Rebuild | Updated bundle |

**Files NOT changed:**
- `src/writeProxyConfig.ts` — works as-is (just needs a port)
- `src/readServerInfo.ts` — works as-is (just reads `{ port }`)
- `src/runCodexExec.ts` — works as-is (talks to proxy URL from config.toml)
- `src/dropSudo.ts` — works as-is
- `src/checkActorPermissions.ts` — works as-is
- `src/checkOutput.ts` — works as-is

---

## Open Questions

1. **System instructions:** The reference repo fetches Codex system instructions from a GitHub URL and injects them. Do we need this, or does Codex CLI already handle its own system prompt?

2. **Model normalization scope:** The reference has 87 model mappings. Do we need all of them, or just the models Codex CLI actually sends? We could start minimal and add as needed.

3. **Prompt caching headers:** The reference sends `session_id` and `conversation_id` for prompt caching. Is this important for the GitHub Actions use case (likely single-shot), or can we skip it?

4. **`store: false` requirement:** The reference always sets this. Need to verify this is required or just recommended for the ChatGPT backend.

5. **Do we want to support both auth methods in a single run?** Current plan fails if both are provided. Alternative: prefer OAuth, fall back to API key.

---

## Implementation Order

Each phase is testable before moving to the next:

1. **Phase 1** (OAuth proxy code) — develop and unit test in isolation
2. **Phase 2** (CLI command) — wire proxy into main.ts, test locally with `node dist/main.js`
3. **Phase 3** (Build) — verify compilation and bundling
4. **Phase 4** (action.yml) — all YAML changes in one shot, test end-to-end
5. **Phase 5** (Testing) — full validation and regression
