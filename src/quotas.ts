/**
 * Per-key free-tier quota, taken from our Google AI Studio console.
 *
 * Hardcoded on purpose: it is not derivable from the API, and a table that
 * silently disagrees with the console is worse than one that is obviously
 * stale. `rpm` requests/minute, `tpm` tokens/minute, `rpd` requests/day.
 * `Infinity` is the console's "Unlimited".
 *
 * The console shows DISPLAY names; the API takes model ids, and several of the
 * two do not match. Every id below is the API id, verified against
 * `GET /v1beta/models` on 2026-08-30 — the display name it came from is noted
 * wherever they differ, because the failure mode of a wrong id is a silent 404
 * that reads as a dead gateway.
 *
 * TODO: Gemini's grounding tools (map grounding, search grounding) carry their
 * own daily caps, which are a resource dimension on top of model usage rather
 * than part of it. Nothing here requests grounding, so nothing tracks it. When
 * something does, it wants its own counter keyed by (key, tool) — not a column
 * on this table, since a grounded request spends from both budgets at once.
 */
export interface Quota {
  rpm: number;
  tpm: number;
  rpd: number;
}

export const MODEL_QUOTAS: Record<string, Quota> = {
  // --- text-out --------------------------------------------------------
  "gemini-2.5-flash": { rpm: 5, tpm: 250_000, rpd: 20 },
  "gemini-2.5-flash-lite": { rpm: 10, tpm: 250_000, rpd: 20 },
  /** console "Gemini 3 Flash" */
  "gemini-3-flash-preview": { rpm: 5, tpm: 250_000, rpd: 20 },
  "gemini-3.1-flash-lite": { rpm: 15, tpm: 250_000, rpd: 500 },
  "gemini-3.5-flash": { rpm: 5, tpm: 250_000, rpd: 20 },
  "gemini-3.5-flash-lite": { rpm: 15, tpm: 250_000, rpd: 500 },
  "gemini-3.6-flash": { rpm: 5, tpm: 250_000, rpd: 20 },
  "gemini-3.7-flash": { rpm: 5, tpm: 250_000, rpd: 20 },

  // --- agents / other --------------------------------------------------
  /** console "Antigravity" */
  "antigravity-preview-05-2026": { rpm: 60, tpm: 100_000, rpd: 100 },
  /** console "Gemini Embedding 1" */
  "gemini-embedding-001": { rpm: 100, tpm: 30_000, rpd: 1_000 },
  "gemini-embedding-2": { rpm: 100, tpm: 30_000, rpd: 1_000 },
  "gemini-robotics-er-1.6-preview": { rpm: 5, tpm: 250_000, rpd: 20 },
  "gemini-robotics-er-2-preview": { rpm: 5, tpm: 250_000, rpd: 20 },
  /** console "Gemma 4 26B" */
  "gemma-4-26b-a4b-it": { rpm: 30, tpm: 16_000, rpd: 14_400 },
  /** console "Gemma 4 31B" */
  "gemma-4-31b-it": { rpm: 30, tpm: 16_000, rpd: 14_400 },

  // --- TTS -------------------------------------------------------------
  /** console "Gemini 2.5 Flash TTS" */
  "gemini-2.5-flash-preview-tts": { rpm: 3, tpm: 10_000, rpd: 10 },
  /** console "Gemini 3.1 Flash TTS" */
  "gemini-3.1-flash-tts-preview": { rpm: 3, tpm: 10_000, rpd: 10 },

  // --- transcribe (non-live) -------------------------------------------
  "gemini-3.5-transcribe": { rpm: 3, tpm: 10_000, rpd: 25 },

  // --- Live API: RPM/RPD unlimited, only TPM capped --------------------
  /** console "Gemini 2.5 Flash Native Audio Dialog" */
  "gemini-2.5-flash-native-audio-latest": {
    rpm: Infinity,
    tpm: 1_000_000,
    rpd: Infinity,
  },
  /** console "Gemini 3 Flash Live" — the only non-native-audio 3.x Live model. */
  "gemini-3.1-flash-live-preview": { rpm: Infinity, tpm: 65_000, rpd: Infinity },
  /** console "Gemini 3.5 Live Translate" */
  "gemini-3.5-live-translate-preview": {
    rpm: Infinity,
    tpm: 20_000,
    rpd: Infinity,
  },
  "gemini-3.5-transcribe-live": { rpm: Infinity, tpm: 20_000, rpd: Infinity },
};

/**
 * Per-key quota overrides, consulted before `MODEL_QUOTAS`.
 *
 * Empty today — all four keys are free tier and carry identical limits. It
 * exists as a lookup step rather than a later refactor because the day one key
 * moves to a paid tier, the broker has to stop assuming that.
 */
export const KEY_OVERRIDES: Record<string, Record<string, Quota>> = {};

export function quotaFor(keyId: string, model: string): Quota | undefined {
  return KEY_OVERRIDES?.[keyId]?.[model] ?? MODEL_QUOTAS[model];
}
