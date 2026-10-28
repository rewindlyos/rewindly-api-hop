import { BadRequestError } from "./utils/error";
import { liveSocketUrl } from "./gemini";
import { isInceptionModel } from "./inception";

/**
 * The task list, taken from what the Rewindly backend actually calls -- see the
 * audit table in the README. Nothing here is speculative: every intent below
 * replaces a real call site, and there is no intent for a capability the app
 * does not use yet.
 *
 * The caller never names a model. It names what it is trying to do, and
 * `models` here is the candidate list in preference order, walked by the broker
 * until one has headroom.
 */

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface Upstream {
  path: string;
  body: unknown;
  timeoutMs?: number;
}

export interface Intent {
  /** Candidate model ids, most preferred first. Every id must be in MODEL_QUOTAS. */
  models: string[];
  /** Answers `"stream": true` with SSE (src/stream.ts). Only `chat` does. */
  streams?: boolean;
  /** Tokens to charge against TPM before the call; corrected afterwards. */
  estimate(payload: Record<string, unknown>): number;
  build(
    model: string,
    payload: Record<string, unknown>,
    options: Record<string, unknown>,
    stream?: boolean,
  ): Upstream;
  parse(json: Record<string, unknown>): { result: unknown; usage: Usage };
}

const NO_USAGE: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

function need<T>(payload: Record<string, unknown>, key: string, kind: string): T {
  const v = payload[key];
  if (v === undefined || v === null) {
    throw new BadRequestError(`payload.${key} is required and must be ${kind}`);
  }
  return v as T;
}

// ---------------------------------------------------------------------------
// Model preferences
//
// The lite models carry 500 rpd against the full flash models' 20, so they are
// the workhorses and the others are the overflow -- not the other way around,
// which is what "prefer the bigger model" would give you and what would put the
// whole day's capacity in the first twenty saves.
//
// `gemini-2.5-flash` and `gemini-2.5-flash-lite` are deliberately absent from
// every list. They are still returned by `GET /v1beta/models` and every call to
// them 404s on this account with "no longer available to new users", so they
// remain in MODEL_QUOTAS as a record of their console quota and are routed to
// by nothing.
// ---------------------------------------------------------------------------

/** Text in, text or JSON out. The 3.x ladder, cheapest-per-day first. */
const TEXT_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
  // Inception, after every Gemini model: overflow for when the free tier is
  // spent, not a replacement for it. Moving these to the front makes Mercury
  // the primary text model with no other change.
  "mercury-3",
  "mercury-2.5",
];

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

/**
 * Four intents share this. That is not a missing abstraction boundary -- they
 * are the same wire shape (OpenAI-compatible chat completions) differing only
 * in which models serve them, and splitting one function into four identical
 * copies to satisfy a file layout would be the actual mistake.
 *
 * `messages` and `tools` pass through verbatim, which is what makes Gemini 3's
 * `extra_content` (the thought_signature it attaches to any tool-calling turn,
 * and rejects the follow-up with a 400 if you drop) round-trip without this
 * gateway having to understand it.
 */
function chatShaped(models: string[]): Intent {
  return {
    models,
    estimate(payload) {
      // ponytail: four characters per token, the usual English rule of thumb.
      // It only has to be close enough to gate TPM between the reserve and the
      // reconcile a second later, and every text model here has a 250k/min
      // budget that no single request comes near. Count properly if a model
      // with a tight TPM ever joins this list.
      return Math.ceil(JSON.stringify(payload.messages ?? "").length / 4);
    },
    build(model, payload, options, stream = false) {
      const messages = need<unknown[]>(payload, "messages", "an array");
      if (!Array.isArray(messages) || messages.length === 0) {
        throw new BadRequestError("payload.messages must be a non-empty array");
      }
      const mercury = isInceptionModel(model);
      // Mercury takes temperature in [0.5, 1] and resets anything else to 1
      // with a warning -- the opposite of what a caller asking for 0 wanted.
      const temperature =
        mercury && typeof options.temperature === "number"
          ? Math.min(1, Math.max(0.5, options.temperature))
          : options.temperature;
      return {
        path: mercury ? "/v1/chat/completions" : "/v1beta/openai/chat/completions",
        body: {
          model,
          messages,
          stream,
          // Usage rides on the last chunk only when asked for.
          ...(stream ? { stream_options: { include_usage: true } } : {}),
          ...(payload.response_format ? { response_format: payload.response_format } : {}),
          ...(payload.tools
            ? { tools: payload.tools, tool_choice: payload.tool_choice ?? "auto" }
            : {}),
          ...(temperature !== undefined ? { temperature } : {}),
          ...(options.max_output_tokens !== undefined
            ? { max_completion_tokens: options.max_output_tokens }
            : {}),
        },
      };
    },
    parse(json) {
      const choice = (json.choices as ChatChoice[] | undefined)?.[0];
      const msg = choice?.message;
      return {
        result: {
          content: msg?.content ?? "",
          tool_calls: msg?.tool_calls ?? [],
          // Echoed back untouched. See the note on pass-through above.
          ...(msg?.extra_content === undefined ? {} : { extra_content: msg.extra_content }),
          finish_reason: choice?.finish_reason ?? null,
        },
        usage: readUsage(json),
      };
    },
  };
}

interface ChatChoice {
  message?: {
    content?: string;
    tool_calls?: unknown[];
    extra_content?: unknown;
  };
  finish_reason?: string;
}

export function readUsage(json: Record<string, unknown>): Usage {
  const u = json.usage as
    { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
  const prompt = u?.prompt_tokens ?? 0;
  const completion = u?.completion_tokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: u?.total_tokens ?? prompt + completion,
  };
}

/**
 * ponytail: a flat estimate for anything carrying media bytes, reconciled from
 * the response a moment later. Deriving tokens from a base64 length means
 * guessing a bitrate for audio and a tile count for images, and both text
 * models here have a 250k/min budget that makes the guess irrelevant. Replace
 * it with Google's `countTokens` if media ever routes to a tight-TPM model.
 */
const MEDIA_TOKEN_ESTIMATE = 2_000;

const DEFAULT_TRANSCRIBE_PROMPT =
  "Transcribe this audio verbatim, in its original language. " +
  "Output only the transcript text - no preamble, no translation, no commentary.";

const DEFAULT_VISION_PROMPT =
  "Describe this image for a personal search index. State what it shows, and " +
  "transcribe any legible text verbatim. Be concise and factual. Never invent detail.";

const DEFAULT_DOCUMENT_PROMPT =
  "Write out everything this document says, as plain text, in its own language and in " +
  "its own order. Put each heading on its own line. Write every table one row per line, " +
  "naming each value by its column header, e.g. 'Monday · 08:45-09:40 · Deep Learning Lab " +
  "· Room L-1'. A merged cell applies to every row it spans. Do not summarise, skip or add " +
  "anything; no markdown, no commentary.";

const DEFAULT_VIDEO_PROMPT =
  "Watch this video for a personal search index. Write, in the video's own language: " +
  "what it is about in one or two sentences; everything said that carries information, " +
  "close to verbatim; every piece of on-screen text, verbatim; and every specific place " +
  "that is named or shown. Plain text, no preamble. Never invent a place or a detail.";

/** A native `generateContent` response reduced to its text and usage. */
interface NativeResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

function readNative(json: Record<string, unknown>): { text: string; usage: Usage } {
  const r = json as NativeResponse;
  const text = (r.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  const prompt = r.usageMetadata?.promptTokenCount ?? 0;
  const completion = r.usageMetadata?.candidatesTokenCount ?? 0;
  return {
    text,
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: r.usageMetadata?.totalTokenCount ?? prompt + completion,
    },
  };
}

export const INTENTS: Record<string, Intent> = {
  /**
   * Types a save and files it into a collection, on its way through the
   * pipeline. Structured JSON out (`response_format`).
   */
  classify: chatShaped(TEXT_MODELS),

  /** Pulls the typed fields out of a save. Structured JSON out. */
  extract: chatShaped(TEXT_MODELS),

  /** Expands a search query before retrieval runs. Structured JSON out. */
  query_understand: chatShaped(TEXT_MODELS),

  /**
   * Rem's tool-calling turn. Sends `tools`, reads back `tool_calls`. The one
   * intent that streams: Rem's answer is the only output a person watches
   * arrive. See src/stream.ts.
   */
  chat: { ...chatShaped(TEXT_MODELS), streams: true },

  /**
   * Speech in, text out.
   *
   * NOT `gemini-3.5-transcribe`, despite the name and a listing in
   * `GET /models`: it reads the audio (usage comes back `modality: AUDIO`) and
   * then returns an empty part with `completion_tokens: 0` and
   * `finishReason: STOP`. Reproduced across projects, on both the OpenAI-compat
   * and native surfaces, streaming and not. The lite models transcribe the same
   * fixture correctly, so they carry this until a probe says otherwise.
   *
   * 3.1 leads: acoustic errors are its strength, and it keeps the 3.5 lite
   * day-budget free for the text path that has nowhere else to go.
   */
  transcribe: {
    models: ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"],
    estimate: () => MEDIA_TOKEN_ESTIMATE,
    build(model, payload, options) {
      const audio = need<string>(payload, "audio_base64", "a base64 string");
      const mime = need<string>(payload, "mime", "a mime type");
      // Gemini has no /audio/transcriptions endpoint at all; audio rides as a
      // content part on a chat completion.
      const format = mime.split("/")[1]?.split(";")[0] ?? "wav";
      return {
        path: "/v1beta/openai/chat/completions",
        body: {
          model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: payload.prompt ?? DEFAULT_TRANSCRIBE_PROMPT },
                { type: "input_audio", input_audio: { data: audio, format } },
              ],
            },
          ],
          max_completion_tokens: options.max_output_tokens ?? 4096,
          temperature: options.temperature ?? 0,
        },
      };
    },
    parse(json) {
      const text = (json.choices as ChatChoice[] | undefined)?.[0]?.message?.content ?? "";
      // No duration and no language on this path -- Gemini reports neither.
      // Absent rather than zero: a caller must not read 0 as "silent".
      return { result: { text }, usage: readUsage(json) };
    },
  },

  /**
   * An image as multimodal input to a vision-capable text-out model.
   *
   * Not image generation: the dedicated image models on this account show no
   * usable quota, and the app has never wanted one. What it wants is the
   * picture read back as text when on-device OCR came up too thin to index.
   */
  vision_describe: {
    models: ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"],
    estimate: () => MEDIA_TOKEN_ESTIMATE,
    build(model, payload, options) {
      const image = need<string>(payload, "image_base64", "a base64 string");
      const mime = need<string>(payload, "mime", "a mime type");
      return {
        path: "/v1beta/openai/chat/completions",
        body: {
          model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: payload.prompt ?? DEFAULT_VISION_PROMPT },
                { type: "image_url", image_url: { url: `data:${mime};base64,${image}` } },
              ],
            },
          ],
          max_completion_tokens: options.max_output_tokens ?? 1024,
          temperature: options.temperature ?? 0,
        },
      };
    },
    parse(json) {
      const description =
        (json.choices as ChatChoice[] | undefined)?.[0]?.message?.content ?? "";
      return { result: { description }, usage: readUsage(json) };
    },
  },

  /**
   * A whole document -- a PDF today -- read back as text.
   *
   * Native `generateContent`, not the OpenAI-compatible surface: that surface
   * takes images and audio but refuses a PDF, and Gemini's document
   * understanding (every page, tables with their layout) exists only here.
   * The Rewindly Worker has no PDF parser and the phone's extractor reads none,
   * so without this a saved timetable is indexed as its filename.
   */
  document_read: {
    models: ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"],
    // ponytail: ~258 tokens a page, so this admits a ~30-page file before the
    // reconcile corrects it. Count pages if a long document ever trips TPM.
    estimate: () => 8_000,
    build(model, payload, options) {
      const data = need<string>(payload, "document_base64", "a base64 string");
      const mime = need<string>(payload, "mime", "a mime type");
      return {
        path: `/v1beta/models/${model}:generateContent`,
        body: {
          contents: [
            {
              role: "user",
              parts: [
                { inline_data: { mime_type: mime, data } },
                { text: payload.prompt ?? DEFAULT_DOCUMENT_PROMPT },
              ],
            },
          ],
          generationConfig: {
            maxOutputTokens: options.max_output_tokens ?? 8192,
            temperature: options.temperature ?? 0,
          },
        },
        timeoutMs: 120_000,
      };
    },
    parse(json) {
      const { text, usage } = readNative(json);
      return { result: { text }, usage };
    },
  },

  /**
   * A video someone saved from their phone, read back as text: what it shows,
   * what is said in it and what is written on screen. Inline bytes on native
   * `generateContent`, like `document_read`, because the OpenAI-compatible
   * surface takes no video. The caller keeps the file under Gemini's 20 MB
   * inline request; a larger one would need the Files API.
   */
  video_read: {
    models: ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"],
    // ponytail: about two minutes at low media resolution (~100 tokens a
    // second, a frame a second plus the audio), reconciled from the real count.
    estimate: () => 12_000,
    build(model, payload, options) {
      const data = need<string>(payload, "video_base64", "a base64 string");
      const mime = need<string>(payload, "mime", "a mime type");
      return {
        path: `/v1beta/models/${model}:generateContent`,
        body: {
          contents: [
            {
              role: "user",
              parts: [
                { inline_data: { mime_type: mime, data } },
                { text: payload.prompt ?? DEFAULT_VIDEO_PROMPT },
              ],
            },
          ],
          generationConfig: {
            mediaResolution: "MEDIA_RESOLUTION_LOW",
            maxOutputTokens: options.max_output_tokens ?? 4096,
            temperature: options.temperature ?? 0,
          },
        },
        timeoutMs: 120_000,
      };
    },
    parse(json) {
      const { text, usage } = readNative(json);
      return { result: { text }, usage };
    },
  },

  /**
   * Admission for a duplex Live session: mint a single-use ephemeral token and
   * hand back the complete socket URL.
   *
   * This is the one intent whose upstream work does not happen here. The broker
   * reserves a key, this mints against it, and the socket that follows runs
   * directly between the caller and Google for the length of the call --
   * nothing in this Worker sits in the audio path, and no Durable Object bills
   * for the silence.
   *
   * `setup` is passed through verbatim and is the security property: the token
   * carries the system prompt and tool list, and the socket ignores whatever
   * the client's own `setup` frame claims. Building that object is the caller's
   * business (it is product, not credentials); locking it into the token is
   * this gateway's.
   */
  live_session: {
    models: ["gemini-3.1-flash-live-preview"],
    /**
     * ponytail: one minute of duplex audio at Gemini's ~32 tokens/sec, each
     * way. A session outlives the TPM window it is charged to, so this admits
     * roughly `tpm / 4000` concurrent sessions per key and then stops -- which
     * is a cap on concurrency, not on total talk time. Upgrade path if that
     * ever binds: a lease with a duration, re-charged each minute it is held.
     */
    estimate: () => 4_000,
    build(model, payload, options) {
      const setup = need<Record<string, unknown>>(payload, "setup", "an object");
      const expire = Number(options.expire_seconds ?? 1_800);
      const connect = Number(options.new_session_expire_seconds ?? 60);
      return {
        path: "/v1alpha/auth_tokens",
        body: {
          // Dies with the session. A refund on a failed connect is what makes
          // a retry loop free to the client and billed to us.
          uses: 1,
          expireTime: new Date(Date.now() + expire * 1_000).toISOString(),
          // The window to OPEN the socket, not to talk.
          newSessionExpireTime: new Date(Date.now() + connect * 1_000).toISOString(),
          // `model` last, so it wins: the broker reserved capacity against a
          // specific Live model and a caller's `setup.model` must not silently
          // spend it on a different one.
          bidiGenerateContentSetup: { ...setup, model: `models/${model}` },
        },
        timeoutMs: 30_000,
      };
    },
    parse(json) {
      const name = json.name as string | undefined;
      if (!name) throw new BadRequestError("live mint returned no token name");
      return { result: { url: liveSocketUrl(name), token: name }, usage: NO_USAGE };
    },
  },
};

export const INTENT_MODEL_MAP: Record<string, string[]> = Object.fromEntries(
  Object.entries(INTENTS).map(([name, i]) => [name, i.models]),
);
