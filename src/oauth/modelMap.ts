/**
 * Model normalization map for ChatGPT backend API.
 *
 * Maps model config IDs (including reasoning-effort suffixes) to their
 * canonical API model names.  Extracted from the opencode-openai-codex-auth
 * reference implementation.
 */

export const MODEL_MAP: Record<string, string> = {
  // GPT-5.1 Codex
  "gpt-5.1-codex": "gpt-5.1-codex",
  "gpt-5.1-codex-low": "gpt-5.1-codex",
  "gpt-5.1-codex-medium": "gpt-5.1-codex",
  "gpt-5.1-codex-high": "gpt-5.1-codex",

  // GPT-5.1 Codex Max
  "gpt-5.1-codex-max": "gpt-5.1-codex-max",
  "gpt-5.1-codex-max-low": "gpt-5.1-codex-max",
  "gpt-5.1-codex-max-medium": "gpt-5.1-codex-max",
  "gpt-5.1-codex-max-high": "gpt-5.1-codex-max",
  "gpt-5.1-codex-max-xhigh": "gpt-5.1-codex-max",

  // GPT-5.2
  "gpt-5.2": "gpt-5.2",
  "gpt-5.2-none": "gpt-5.2",
  "gpt-5.2-low": "gpt-5.2",
  "gpt-5.2-medium": "gpt-5.2",
  "gpt-5.2-high": "gpt-5.2",
  "gpt-5.2-xhigh": "gpt-5.2",

  // GPT-5.2 Codex
  "gpt-5.2-codex": "gpt-5.2-codex",
  "gpt-5.2-codex-low": "gpt-5.2-codex",
  "gpt-5.2-codex-medium": "gpt-5.2-codex",
  "gpt-5.2-codex-high": "gpt-5.2-codex",
  "gpt-5.2-codex-xhigh": "gpt-5.2-codex",

  // GPT-5.1 Codex Mini
  "gpt-5.1-codex-mini": "gpt-5.1-codex-mini",
  "gpt-5.1-codex-mini-medium": "gpt-5.1-codex-mini",
  "gpt-5.1-codex-mini-high": "gpt-5.1-codex-mini",

  // GPT-5.1 General Purpose
  "gpt-5.1": "gpt-5.1",
  "gpt-5.1-none": "gpt-5.1",
  "gpt-5.1-low": "gpt-5.1",
  "gpt-5.1-medium": "gpt-5.1",
  "gpt-5.1-high": "gpt-5.1",
  "gpt-5.1-chat-latest": "gpt-5.1",

  // GPT-5.3
  "gpt-5.3": "gpt-5.3",
  "gpt-5.3-none": "gpt-5.3",
  "gpt-5.3-low": "gpt-5.3",
  "gpt-5.3-medium": "gpt-5.3",
  "gpt-5.3-high": "gpt-5.3",
  "gpt-5.3-xhigh": "gpt-5.3",

  // GPT-5.3 Codex
  "gpt-5.3-codex": "gpt-5.3-codex",
  "gpt-5.3-codex-low": "gpt-5.3-codex",
  "gpt-5.3-codex-medium": "gpt-5.3-codex",
  "gpt-5.3-codex-high": "gpt-5.3-codex",
  "gpt-5.3-codex-xhigh": "gpt-5.3-codex",

  // Legacy GPT-5 (maps to GPT-5.1)
  "gpt-5-codex": "gpt-5.1-codex",
  "codex-mini-latest": "gpt-5.1-codex-mini",
  "gpt-5-codex-mini": "gpt-5.1-codex-mini",
  "gpt-5-codex-mini-medium": "gpt-5.1-codex-mini",
  "gpt-5-codex-mini-high": "gpt-5.1-codex-mini",
  "gpt-5": "gpt-5.1",
  "gpt-5-mini": "gpt-5.1",
  "gpt-5-nano": "gpt-5.1",
};

/**
 * Normalize a model name to its canonical API form.
 *
 * 1. Strips provider prefix (e.g. "openai/gpt-5-codex" -> "gpt-5-codex")
 * 2. Tries exact lookup in MODEL_MAP
 * 3. Tries case-insensitive lookup
 * 4. Falls back to pattern matching
 */
export function normalizeModel(model: string | undefined): string {
  if (!model) return "gpt-5.1";

  // Strip provider prefix
  const modelId = model.includes("/") ? model.split("/").pop()! : model;

  // Exact lookup
  if (MODEL_MAP[modelId]) {
    return MODEL_MAP[modelId];
  }

  // Case-insensitive lookup
  const lower = modelId.toLowerCase();
  const match = Object.keys(MODEL_MAP).find(
    (key) => key.toLowerCase() === lower,
  );
  if (match) {
    return MODEL_MAP[match];
  }

  // Pattern-based fallback (most specific first)
  if (lower.includes("gpt-5.3-codex") || lower.includes("gpt 5.3 codex"))
    return "gpt-5.3-codex";
  if (lower.includes("gpt-5.3") || lower.includes("gpt 5.3")) return "gpt-5.3";
  if (lower.includes("gpt-5.2-codex") || lower.includes("gpt 5.2 codex"))
    return "gpt-5.2-codex";
  if (lower.includes("gpt-5.2") || lower.includes("gpt 5.2")) return "gpt-5.2";
  if (
    lower.includes("gpt-5.1-codex-max") ||
    lower.includes("gpt 5.1 codex max")
  )
    return "gpt-5.1-codex-max";
  if (
    lower.includes("gpt-5.1-codex-mini") ||
    lower.includes("gpt 5.1 codex mini")
  )
    return "gpt-5.1-codex-mini";
  if (
    lower.includes("codex-mini-latest") ||
    lower.includes("gpt-5-codex-mini") ||
    lower.includes("gpt 5 codex mini")
  )
    return "gpt-5.1-codex-mini";
  if (lower.includes("gpt-5.1-codex") || lower.includes("gpt 5.1 codex"))
    return "gpt-5.1-codex";
  if (lower.includes("gpt-5.1") || lower.includes("gpt 5.1")) return "gpt-5.1";

  // Unknown model — pass through as-is so the backend can decide
  return modelId;
}
