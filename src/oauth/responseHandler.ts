/**
 * Response handling for the OAuth proxy.
 *
 * - Streaming requests: pipe the upstream SSE stream directly to the client.
 * - Non-streaming requests: consume the SSE stream, extract the final
 *   `response.done` event, and return it as a single JSON object.
 * - Maps 404 "usage limit" errors to 429 so Codex CLI can retry.
 */

import type { ServerResponse } from "node:http";

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Forward the upstream (ChatGPT backend) response to the downstream (Codex
 * CLI) HTTP response, adapting the format based on whether the original
 * request was streaming.
 */
export async function handleUpstreamResponse(
  upstream: Response,
  downstream: ServerResponse,
  wasStreaming: boolean,
): Promise<void> {
  // Handle 404 with usage-limit detection → 429
  if (upstream.status === 404) {
    const body = await upstream.text().catch(() => "");
    const status = isUsageLimitBody(body) ? 429 : 404;
    downstream.writeHead(status, { "Content-Type": "application/json" });
    downstream.end(body);
    return;
  }

  // Forward other errors as-is
  if (!upstream.ok) {
    const body = await upstream.text().catch(() => "");
    downstream.writeHead(upstream.status, {
      "Content-Type": "application/json",
    });
    downstream.end(body);
    return;
  }

  // Success path
  if (wasStreaming) {
    await pipeStream(upstream, downstream);
  } else {
    await convertSseToJson(upstream, downstream);
  }
}

// ---------------------------------------------------------------------------
// Streaming passthrough
// ---------------------------------------------------------------------------

async function pipeStream(
  upstream: Response,
  downstream: ServerResponse,
): Promise<void> {
  downstream.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  if (!upstream.body) {
    downstream.end();
    return;
  }

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      downstream.write(value);
    }
  } catch (err) {
    console.error("[oauth-proxy] Error piping stream:", err);
  } finally {
    downstream.end();
  }
}

// ---------------------------------------------------------------------------
// SSE -> JSON conversion (for non-streaming requests)
// ---------------------------------------------------------------------------

async function convertSseToJson(
  upstream: Response,
  downstream: ServerResponse,
): Promise<void> {
  if (!upstream.body) {
    downstream.writeHead(502, { "Content-Type": "application/json" });
    downstream.end(
      JSON.stringify({ error: "No response body from upstream" }),
    );
    return;
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fullText += decoder.decode(value, { stream: true });
    }
  } catch (err) {
    console.error("[oauth-proxy] Error reading SSE stream:", err);
    downstream.writeHead(502, { "Content-Type": "application/json" });
    downstream.end(
      JSON.stringify({ error: "Failed to read upstream response" }),
    );
    return;
  }

  const finalResponse = parseSseStream(fullText);

  if (finalResponse != null) {
    const json = JSON.stringify(finalResponse);
    downstream.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
    });
    downstream.end(json);
  } else {
    // Could not find a response.done event — return the raw SSE text so the
    // caller can attempt to parse it.
    console.error(
      "[oauth-proxy] Could not find response.done event in SSE stream",
    );
    downstream.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
    });
    downstream.end(fullText);
  }
}

/**
 * Walk SSE lines looking for `data: {..., "type": "response.done", ...}` or
 * `"type": "response.completed"` and return the `.response` payload.
 */
function parseSseStream(sseText: string): unknown | null {
  const lines = sseText.split("\n");

  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    try {
      const data = JSON.parse(line.substring(6)) as {
        type?: string;
        response?: unknown;
      };
      if (
        data.type === "response.done" ||
        data.type === "response.completed"
      ) {
        return data.response;
      }
    } catch {
      // Skip malformed JSON lines
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Error remapping
// ---------------------------------------------------------------------------

function isUsageLimitBody(body: string): boolean {
  const haystack = body.toLowerCase();
  return /usage_limit_reached|usage_not_included|rate_limit_exceeded|usage limit/.test(
    haystack,
  );
}
