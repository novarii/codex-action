# High-Level Handoff: Adapting openai/codex-action to Use OAuth Instead of API Keys

## Context

**Goal:** Modify `openai/codex-action` (GitHub Action) to authenticate using OAuth 2.0 (like OpenCode does) instead of requiring OpenAI Platform API keys.

**Why:** Allow users to leverage their ChatGPT Plus/Pro subscriptions for CI/CD automation instead of paying separately for API access.

## Current Architecture (openai/codex-action)

### Authentication Flow:
1. **Input:** User provides `openai-api-key` (format: `sk-proj-...`) as GitHub Actions secret
2. **Proxy Installation:** Action installs `@openai/codex-responses-api-proxy` npm package (closed-source)
3. **Proxy Startup:** Proxy runs on localhost (dynamic port), accepts API key via stdin
4. **Codex Configuration:** Creates `~/.codex/config.toml` pointing Codex CLI to `http://127.0.0.1:<port>/v1`
5. **Request Flow:** Codex CLI → Local Proxy → OpenAI Platform API (`platform.openai.com/v1/responses`)

### Key Files:
- `action.yml` (lines 138-201): Installs proxy, starts it, configures Codex
- `src/writeProxyConfig.ts`: Writes `config.toml` with proxy URL
- `src/readServerInfo.ts`: Reads proxy port from JSON file after startup

## Target Architecture (OAuth-Based)

### Reference Implementation:
- **Repository:** `numman-ali/opencode-openai-codex-auth` (MIT licensed)
- **Key Feature:** Uses OAuth 2.0 PKCE flow to authenticate with ChatGPT backend

### Desired Authentication Flow:
1. **Input:** User provides pre-generated OAuth tokens as GitHub secrets:
   - `OPENAI_OAUTH_ACCESS_TOKEN`
   - `OPENAI_OAUTH_REFRESH_TOKEN`
2. **Token Management:** Proxy checks token expiration, auto-refreshes using refresh token
3. **Request Transformation:** Intercepts Codex CLI requests, transforms them for ChatGPT backend
4. **Endpoint:** Proxy forwards to `https://chatgpt.com/backend-api/codex/responses` (not Platform API)
5. **Headers:** Uses `Authorization: Bearer <oauth_access_token>` instead of API key

## Implementation Plan

### Phase 1: Replace the Proxy
**Files to Modify:** `action.yml` (lines 138-184)

**Current Code:**
```yaml
- name: Install Codex Responses API proxy
  run: npm install -g "@openai/codex-responses-api-proxy@..."

- name: Start Responses API proxy
  env:
    PROXY_API_KEY: ${{ inputs['openai-api-key'] }}
  run: |
    printenv PROXY_API_KEY | codex-responses-api-proxy [args] &
```

**Target Code:**
```yaml
- name: Install OAuth-based proxy
  run: npm install -g opencode-openai-codex-auth

- name: Configure OAuth tokens
  env:
    OAUTH_ACCESS: ${{ inputs['oauth-access-token'] }}
    OAUTH_REFRESH: ${{ inputs['oauth-refresh-token'] }}
  run: |
    mkdir -p ~/.opencode/auth
    # Write tokens to file (opencode format)
    cat > ~/.opencode/auth/openai.json <<EOF
    {
      "access_token": "$OAUTH_ACCESS",
      "refresh_token": "$OAUTH_REFRESH",
      "expires_at": $(date -d '+1 hour' +%s)000
    }
    EOF

- name: Start OAuth proxy server
  run: |
    # Start HTTP server using opencode's fetch wrapper
    node start-oauth-proxy.js &
```

### Phase 2: Create OAuth Proxy Server
**New File:** `src/oauthProxy.ts` (to be added)

**Requirements:**
1. **HTTP Server:** Listen on localhost (e.g., port 8080 or dynamic)
2. **Token Management:** 
   - Load tokens from `~/.opencode/auth/openai.json`
   - Check expiration before each request
   - Call `refreshAccessToken()` if expired (use opencode's auth lib)
3. **Request Handling:**
   - Accept POST requests to `/v1/responses`
   - Transform request body if needed (match ChatGPT backend format)
   - Forward to `https://chatgpt.com/backend-api/codex/responses`
   - Add OAuth header: `Authorization: Bearer <access_token>`
   - Handle Server-Sent Events (SSE) → JSON conversion
4. **Server Info File:** Write port to JSON file (like current proxy does)
   - Format: `{ "port": 8080, "pid": <process_id> }`
   - Path: `~/.codex/<github_run_id>.json`

**Key Code Structure:**
```typescript
import express from 'express';
import { readTokens, refreshAccessToken } from 'opencode-openai-codex-auth';

const app = express();

app.post('/v1/responses', async (req, res) => {
  // 1. Load tokens
  let tokens = await readTokens();
  
  // 2. Refresh if expired
  if (tokens.expires_at < Date.now()) {
    tokens = await refreshAccessToken(tokens.refresh_token);
  }
  
  // 3. Forward to ChatGPT backend
  const response = await fetch('https://chatgpt.com/backend-api/codex/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${tokens.access_token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(req.body)
  });
  
  // 4. Handle SSE/streaming response
  res.json(await response.json());
});

// Write server info file before starting
const port = 8080;
fs.writeFileSync(`~/.codex/${process.env.GITHUB_RUN_ID}.json`, 
  JSON.stringify({ port, pid: process.pid }));

app.listen(port);
```

### Phase 3: Update Action Inputs
**File to Modify:** `action.yml` (lines 1-90)

**Add New Inputs:**
```yaml
inputs:
  oauth-access-token:
    description: "OAuth access token from ChatGPT. Get this by running OpenCode auth locally."
    required: false
    default: ""
  oauth-refresh-token:
    description: "OAuth refresh token from ChatGPT."
    required: false
    default: ""
```

**Deprecate (but keep for backwards compatibility):**
```yaml
  openai-api-key:
    description: "DEPRECATED: Use oauth tokens instead. OpenAI Platform API key."
    required: false
    default: ""
```

### Phase 4: Update Configuration Logic
**File to Modify:** `src/writeProxyConfig.ts`

**No Changes Needed:** The proxy URL configuration remains the same - Codex CLI will still talk to `http://127.0.0.1:<port>/v1`

**Only Change:** Ensure the OAuth proxy writes the same server info format

### Phase 5: Documentation Updates
**Files to Modify:**
- `README.md`: Add section "Using with OAuth (ChatGPT Account)"
- New file: `docs/oauth-setup.md`

**Instructions to Include:**
1. How to get OAuth tokens:
   ```bash
   # Install OpenCode CLI
   npm install -g @opencode/cli
   
   # Authenticate (opens browser)
   opencode auth login
   
   # Extract tokens
   cat ~/.opencode/auth/openai.json
   ```

2. Add tokens to GitHub Secrets:
   - Settings → Secrets and variables → Actions
   - Add `OPENAI_OAUTH_ACCESS_TOKEN`
   - Add `OPENAI_OAUTH_REFRESH_TOKEN`

3. Update workflow:
   ```yaml
   - uses: your-username/codex-action@oauth-support
     with:
       oauth-access-token: ${{ secrets.OPENAI_OAUTH_ACCESS_TOKEN }}
       oauth-refresh-token: ${{ secrets.OPENAI_OAUTH_REFRESH_TOKEN }}
       prompt: "Review this PR"
   ```

## Key Technical Challenges

### 1. **Token Refresh Logic**
- **Challenge:** Access tokens expire (typically 1 hour)
- **Solution:** Use `opencode-openai-codex-auth` library's `refreshAccessToken()` function
- **Reference:** Check `numman-ali/opencode-openai-codex-auth/lib/auth/auth.ts` lines 200-230

### 2. **Request Format Compatibility**
- **Challenge:** ChatGPT backend API might expect different request format than Platform API
- **Solution:** Inspect opencode's `fetch()` wrapper to see any transformations
- **Reference:** `numman-ali/opencode-openai-codex-auth/index.ts` lines 141-226

### 3. **SSE (Server-Sent Events) Handling**
- **Challenge:** ChatGPT backend uses SSE streaming, may need conversion
- **Solution:** Check if opencode does SSE→JSON conversion, replicate if needed
- **Reference:** Look for streaming response handling in opencode's fetch wrapper

### 4. **GitHub Actions Headless Environment**
- **Challenge:** Cannot run interactive OAuth flow (no browser)
- **Solution:** Require users to pre-authenticate locally and provide tokens as secrets
- **Limitation:** Users must manually refresh tokens periodically (refresh tokens typically last 90 days)

## Testing Strategy

### Local Testing:
1. Clone forked repo
2. Build action: `npm run build`
3. Create test workflow in `.github/workflows/test-oauth.yml`
4. Use `act` tool to test locally: `act -s OPENAI_OAUTH_ACCESS_TOKEN=... -s OPENAI_OAUTH_REFRESH_TOKEN=...`

### Integration Testing:
1. Create sample repo with PR
2. Trigger action, verify it posts comment
3. Test token expiration: Set expired token, verify refresh works
4. Test error handling: Invalid tokens, network failures

## Estimated Effort

- **Phase 1 (Replace proxy):** 2-3 hours
- **Phase 2 (OAuth proxy server):** 4-6 hours
- **Phase 3 (Update inputs):** 1 hour
- **Phase 4 (Config updates):** 1 hour
- **Phase 5 (Documentation):** 2 hours
- **Testing & debugging:** 4-6 hours

**Total:** 14-19 hours

## Success Criteria

- [ ] Action works with OAuth tokens instead of API keys
- [ ] Tokens auto-refresh when expired
- [ ] Backward compatible (still accepts API keys)
- [ ] Clear documentation for token setup
- [ ] All existing tests pass
- [ ] New tests for OAuth flow
- [ ] Security: Tokens properly protected (not leaked in logs)

## Key Files to Reference

**From openai/codex-action:**
- `action.yml` (main workflow)
- `src/writeProxyConfig.ts` (proxy configuration)
- `src/readServerInfo.ts` (proxy port discovery)
- `src/main.ts` (CLI commands)

**From numman-ali/opencode-openai-codex-auth:**
- `lib/auth/auth.ts` (OAuth flow implementation)
- `index.ts` (fetch wrapper with token injection)
- `lib/auth/config.ts` (token storage paths)

## Final Notes

This modification transforms the action from **application-level authentication** (API keys) to **user-level authentication** (OAuth), enabling use of ChatGPT subscriptions for CI/CD. The core challenge is replacing the closed-source `@openai/codex-responses-api-proxy` with an open-source OAuth-aware proxy that handles token management and request forwarding to ChatGPT's backend.
