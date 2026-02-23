/**
 * OAuth-aware HTTP proxy server.
 *
 * Sits between Codex CLI and the ChatGPT backend API, handling:
 * - OAuth token management (refresh on expiry)
 * - Request transformation (model normalization, stateless flags, etc.)
 * - Response adaptation (SSE → JSON for non-streaming requests)
 *
 * Usage:
 *   const proxy = createOAuthProxy({ serverInfoFile, accessToken, refreshToken });
 *   await proxy.start();   // binds to a dynamic port, writes server info
 *   // ...
 *   proxy.stop();           // graceful shutdown
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFile } from "node:fs/promises";

import {
  loadTokens,
  ensureValidToken,
  type TokenState,
} from "./oauth/tokenManager";
import {
  getBackendUrl,
  transformRequestBody,
  createHeaders,
  type RequestBody,
} from "./oauth/requestTransformer";
import { handleUpstreamResponse } from "./oauth/responseHandler";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OAuthProxyOptions {
  /** Path to the JSON file where `{ port, pid }` will be written. */
  serverInfoFile: string;
  /** Initial OAuth access token. */
  accessToken: string;
  /** OAuth refresh token (empty string in relay mode). */
  refreshToken: string;
  /** Token relay URL for fetching fresh tokens (relay mode). */
  relayUrl?: string;
  /** API key for the token relay. */
  relayKey?: string;
}

export interface OAuthProxy {
  start(): Promise<void>;
  stop(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOAuthProxy(options: OAuthProxyOptions): OAuthProxy {
  const { serverInfoFile, accessToken, refreshToken, relayUrl, relayKey } = options;

  let tokenState: TokenState;
  try {
    tokenState = loadTokens(accessToken, refreshToken);
    if (relayUrl) {
      tokenState.relayUrl = relayUrl;
      tokenState.relayKey = relayKey;
    }
  } catch (err) {
    throw new Error(
      `Failed to initialise OAuth tokens: ${err instanceof Error ? err.message : err}`,
    );
  }

  const server = createServer((req, res) => {
    handleRequest(req, res, tokenState).catch((err) => {
      console.error("[oauth-proxy] Unhandled error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
      }
      res.end(JSON.stringify({ error: "Internal proxy error" }));
    });
  });

  return {
    async start() {
      // Refresh token immediately if it is already expired.
      tokenState = await ensureValidToken(tokenState);

      await new Promise<void>((resolve, reject) => {
        server.listen(0, "127.0.0.1", async () => {
          const addr = server.address();
          if (!addr || typeof addr === "string") {
            reject(new Error("Failed to bind server"));
            return;
          }

          const port = addr.port;
          console.log(`[oauth-proxy] Listening on 127.0.0.1:${port}`);

          try {
            await writeFile(
              serverInfoFile,
              JSON.stringify({ port, pid: process.pid }),
            );
            console.log(
              `[oauth-proxy] Server info written to ${serverInfoFile}`,
            );
          } catch (writeErr) {
            reject(writeErr);
            return;
          }

          resolve();
        });

        server.on("error", reject);
      });
    },

    stop() {
      server.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  tokenState: TokenState,
): Promise<void> {
  // Only accept POST /v1/responses
  if (req.method !== "POST" || !req.url?.startsWith("/v1/responses")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  // Read the full request body
  const rawBody = await readBody(req);
  let body: RequestBody;
  try {
    body = JSON.parse(rawBody) as RequestBody;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON body" }));
    return;
  }

  // Ensure we have a valid token
  try {
    await ensureValidToken(tokenState);
  } catch (err) {
    console.error("[oauth-proxy] Token refresh failed:", err);
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ error: "OAuth token refresh failed. Re-authenticate." }),
    );
    return;
  }

  // Transform the request
  const { transformed, wasStreaming } = transformRequestBody(body);

  // Forward to ChatGPT backend
  const headers = createHeaders(tokenState.accessToken, tokenState.accountId);
  let upstream: Response;
  try {
    upstream = await fetch(getBackendUrl(), {
      method: "POST",
      headers,
      body: JSON.stringify(transformed),
    });
  } catch (err) {
    console.error("[oauth-proxy] Upstream request failed:", err);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to reach ChatGPT backend" }));
    return;
  }

  // Handle the response (adapts streaming vs JSON, remaps errors)
  await handleUpstreamResponse(upstream, res, wasStreaming);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
