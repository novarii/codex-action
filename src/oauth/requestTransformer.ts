/**
 * Request transformation pipeline for the OAuth proxy.
 *
 * Transforms Codex CLI requests into the format expected by the ChatGPT
 * backend API at `https://chatgpt.com/backend-api/codex/responses`.
 */

import { normalizeModel } from "./modelMap";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CODEX_BACKEND_URL =
  "https://chatgpt.com/backend-api/codex/responses";

// ---------------------------------------------------------------------------
// Types (minimal — only what the proxy needs)
// ---------------------------------------------------------------------------

interface InputItem {
  id?: string;
  type: string;
  [key: string]: unknown;
}

interface ReasoningConfig {
  effort?: string;
  summary?: string;
}

export interface RequestBody {
  model: string;
  store?: boolean;
  stream?: boolean;
  instructions?: string;
  input?: InputItem[];
  tools?: unknown;
  reasoning?: ReasoningConfig;
  text?: { verbosity?: string };
  include?: string[];
  max_output_tokens?: number;
  max_completion_tokens?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// URL rewriting
// ---------------------------------------------------------------------------

/** Return the full ChatGPT backend URL for a Codex responses request. */
export function getBackendUrl(): string {
  return CODEX_BACKEND_URL;
}

// ---------------------------------------------------------------------------
// Body transformation
// ---------------------------------------------------------------------------

/**
 * Transform a request body from Codex CLI format into the ChatGPT backend
 * format.  Returns the transformed body and the *original* value of `stream`
 * (so the response handler knows whether to convert SSE → JSON).
 */
export function transformRequestBody(body: RequestBody): {
  transformed: RequestBody;
  wasStreaming: boolean;
} {
  const wasStreaming = body.stream === true;

  // Normalize model name
  body.model = normalizeModel(body.model);

  // ChatGPT backend requires store=false (stateless)
  body.store = false;

  // Always stream from the backend; the response handler converts to JSON
  // when the original request was non-streaming.
  body.stream = true;

  // Strip message IDs from input items (stateless operation)
  if (Array.isArray(body.input)) {
    body.input = filterInput(body.input);
  }

  // Ensure reasoning defaults
  if (!body.reasoning) {
    body.reasoning = { effort: "medium", summary: "auto" };
  } else {
    if (!body.reasoning.effort) body.reasoning.effort = "medium";
    if (!body.reasoning.summary) body.reasoning.summary = "auto";
  }

  // Add include for encrypted reasoning content (required for store=false)
  if (!body.include || !body.include.includes("reasoning.encrypted_content")) {
    body.include = [
      ...(body.include ?? []),
      "reasoning.encrypted_content",
    ];
  }

  // Remove unsupported parameters
  delete body.max_output_tokens;
  delete body.max_completion_tokens;

  return { transformed: body, wasStreaming };
}

// ---------------------------------------------------------------------------
// Input filtering
// ---------------------------------------------------------------------------

/**
 * Filter input items for the stateless Codex backend:
 * - Remove `item_reference` types (AI SDK construct)
 * - Strip `id` fields from all items
 */
function filterInput(input: InputItem[]): InputItem[] {
  return input
    .filter((item) => item.type !== "item_reference")
    .map((item) => {
      if (item.id) {
        const { id, ...rest } = item;
        return rest as InputItem;
      }
      return item;
    });
}

// ---------------------------------------------------------------------------
// Header creation
// ---------------------------------------------------------------------------

/**
 * Build the headers required by the ChatGPT backend.
 */
export function createHeaders(
  accessToken: string,
  accountId: string,
): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "chatgpt-account-id": accountId,
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
    accept: "text/event-stream",
  };
}
