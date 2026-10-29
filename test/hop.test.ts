import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseApiKeys, tokenMatches } from "../src/config";
import { clock } from "../src/files";
import { INTENTS } from "../src/intents";
import { relayChatStream } from "../src/stream";
import { MODEL_QUOTAS } from "../src/quotas";
import type { QuotaBroker } from "../src/quota_broker";

/**
 * The checks that fail if the routing logic breaks. Not a suite for its own
 * sake -- each one stands in for an acceptance criterion, and the broker tests
 * exercise the real Durable Object rather than a stand-in, because the whole
 * argument for using a DO is behaviour a mock would not reproduce.
 */

function withBroker<T>(fn: (b: QuotaBroker) => Promise<T>): Promise<T> {
  const id = env.QUOTA_BROKER.idFromName(`t-${Math.random()}`);
  return runInDurableObject(env.QUOTA_BROKER.get(id), fn);
}

const KEYS = ["key-1", "key-2", "key-3", "key-4"];

describe("parseApiKeys", () => {
  it("reads the documented JSON-array-of-objects form", () => {
    expect(parseApiKeys('[{"id":"key-1","key":"AIzaA"},{"id":"key-2","key":"AIzaB"}]')).toEqual(
      [
        { id: "key-1", key: "AIzaA" },
        { id: "key-2", key: "AIzaB" },
      ],
    );
  });

  it("also reads bare strings, arrays and comma-separated lists", () => {
    expect(parseApiKeys("AIzaA")).toEqual([{ id: "key-1", key: "AIzaA" }]);
    expect(parseApiKeys("AIzaA, AIzaB")).toEqual([
      { id: "key-1", key: "AIzaA" },
      { id: "key-2", key: "AIzaB" },
    ]);
    expect(parseApiKeys('["AIzaA","AIzaB"]')).toEqual([
      { id: "key-1", key: "AIzaA" },
      { id: "key-2", key: "AIzaB" },
    ]);
  });

  it("drops duplicate ids, which would make two keys share one budget", () => {
    const keys = parseApiKeys('[{"id":"a","key":"1"},{"id":"a","key":"2"}]');
    expect(keys).toHaveLength(1);
  });

  it("is empty rather than throwing when unset", () => {
    expect(parseApiKeys(undefined)).toEqual([]);
    expect(parseApiKeys("")).toEqual([]);
  });
});

describe("tokenMatches", () => {
  it("accepts only an exact match", () => {
    expect(tokenMatches("secret", "secret")).toBe(true);
    expect(tokenMatches("secrez", "secret")).toBe(false);
    expect(tokenMatches("secre", "secret")).toBe(false);
    expect(tokenMatches("", "secret")).toBe(false);
  });
});

describe("intent wiring", () => {
  it("routes every intent only to models that have a measured quota", () => {
    for (const [name, intent] of Object.entries(INTENTS)) {
      expect(intent.models.length, `${name} has no candidate models`).toBeGreaterThan(0);
      for (const model of intent.models) {
        expect(MODEL_QUOTAS[model], `${name} routes to unbudgeted ${model}`).toBeDefined();
      }
    }
  });

  it("never routes to the 2.5 models, which 404 on this account", () => {
    const routed = Object.values(INTENTS).flatMap((i) => i.models);
    expect(routed).not.toContain("gemini-2.5-flash");
    expect(routed).not.toContain("gemini-2.5-flash-lite");
  });
});

describe("QuotaBroker", () => {
  it("hops to a second key once the first is spent on that model", async () => {
    await withBroker(async (b) => {
      // gemini-3.5-flash-lite is 15 rpm. One key alone therefore serves 15
      // requests a minute; four serve 60.
      const seen: string[] = [];
      for (let i = 0; i < 20; i++) {
        const r = await b.reserve(KEYS, ["gemini-3.5-flash-lite"], 1);
        expect(r).not.toBeNull();
        seen.push(r!.keyId);
      }
      // Lowest-utilisation-first spreads rather than draining key-1 first.
      expect(new Set(seen).size).toBeGreaterThan(1);
      const counts = KEYS.map((k) => seen.filter((s) => s === k).length);
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    });
  });

  it("falls through to the next candidate model when every key is spent", async () => {
    await withBroker(async (b) => {
      const models = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];
      // 4 keys x 15 rpm = 60 on the first model, then it must move on.
      for (let i = 0; i < 60; i++) {
        const r = await b.reserve(KEYS, models, 1);
        expect(r?.model).toBe("gemini-3.5-flash-lite");
      }
      const overflow = await b.reserve(KEYS, models, 1);
      expect(overflow?.model).toBe("gemini-3.1-flash-lite");
    });
  });

  it("returns null only once every key on every candidate model is spent", async () => {
    await withBroker(async (b) => {
      // gemini-3.5-flash is 5 rpm: 4 keys x 5 = 20, then nothing is left.
      for (let i = 0; i < 20; i++) {
        expect(await b.reserve(KEYS, ["gemini-3.5-flash"], 1)).not.toBeNull();
      }
      expect(await b.reserve(KEYS, ["gemini-3.5-flash"], 1)).toBeNull();
    });
  });

  it("refuses a reservation that would break the TPM budget", async () => {
    await withBroker(async (b) => {
      // 20,000 TPM on the live-translate model; one key cannot take 21k.
      const r = await b.reserve(["key-1"], ["gemini-3.5-live-translate-preview"], 21_000);
      expect(r).toBeNull();
    });
  });

  it("counts a Live model as available despite unlimited RPM and RPD", async () => {
    await withBroker(async (b) => {
      const r = await b.reserve(KEYS, ["gemini-3.1-flash-live-preview"], 4_000);
      expect(r?.model).toBe("gemini-3.1-flash-live-preview");
      const row = (await b.snapshot())[0];
      // Unlimited travels as null; Infinity survives neither SQLite nor JSON.
      expect(row.limits.rpm).toBeNull();
      expect(row.limits.tpm).toBe(65_000);
    });
  });

  it("takes a 429'd pair out of rotation and reconciles real token counts", async () => {
    await withBroker(async (b) => {
      const first = await b.reserve(KEYS, ["gemini-3.5-flash-lite"], 100);
      await b.markExhausted(first!.keyId, "gemini-3.5-flash-lite");
      for (let i = 0; i < 10; i++) {
        const next = await b.reserve(KEYS, ["gemini-3.5-flash-lite"], 100);
        expect(next!.keyId).not.toBe(first!.keyId);
      }

      await b.reconcile(first!.keyId, "gemini-3.5-flash-lite", 100, 4_321);
      const row = (await b.snapshot()).find((r) => r.key_id === first!.keyId);
      expect(row!.tpm_used).toBe(4_321);
      expect(row!.blocked_for_ms).toBeGreaterThan(0);
    });
  });

  it("never hands back a pair the caller already tried", async () => {
    await withBroker(async (b) => {
      const first = await b.reserve(KEYS, ["gemini-3.5-flash-lite"], 1);
      const second = await b.reserve(KEYS, ["gemini-3.5-flash-lite"], 1, [
        [first!.keyId, first!.model],
      ]);
      expect(second!.keyId).not.toBe(first!.keyId);
    });
  });

  it("never pairs a key with another provider's model", async () => {
    await withBroker(async (b) => {
      const mercury = ["inception-a", "inception-b"];
      expect(await b.reserve(KEYS, ["mercury-3"], 1)).toBeNull();
      expect(await b.reserve(mercury, ["gemini-3.5-flash-lite"], 1)).toBeNull();
      const r = await b.reserve([...KEYS, ...mercury], ["mercury-3"], 1);
      expect(mercury).toContain(r!.keyId);
    });
  });
});

describe("the public surface", () => {
  it("answers /health without auth", async () => {
    const res = await SELF.fetch("https://hop/health");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { intents: string[] }).intents).toContain("classify");
  });

  it("401s a missing or wrong gateway key, before any upstream call", async () => {
    const bare = await SELF.fetch("https://hop/v1/invoke", {
      method: "POST",
      body: JSON.stringify({ intent: "classify", payload: { messages: [] } }),
    });
    expect(bare.status).toBe(401);

    const wrong = await SELF.fetch("https://hop/v1/invoke", {
      method: "POST",
      headers: { authorization: "Bearer nope" },
      body: JSON.stringify({ intent: "classify", payload: { messages: [] } }),
    });
    expect(wrong.status).toBe(401);

    expect((await SELF.fetch("https://hop/debug/usage")).status).toBe(401);
  });

  it("400s an unrecognised intent rather than passing it through", async () => {
    const res = await SELF.fetch("https://hop/v1/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${env.HOP_GATEWAY_API_KEY}` },
      body: JSON.stringify({ intent: "definitely_not_an_intent", payload: {} }),
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("unknown intent");
  });

  it("400s a valid intent whose payload is missing its required field", async () => {
    const res = await SELF.fetch("https://hop/v1/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${env.HOP_GATEWAY_API_KEY}` },
      body: JSON.stringify({ intent: "transcribe", payload: {} }),
    });
    expect(res.status).toBe(400);
  });

  it("reads a document on the native surface, where PDFs are accepted", () => {
    const up = INTENTS.document_read!.build(
      "gemini-3.5-flash-lite",
      { document_base64: "JVBERi0=", mime: "application/pdf" },
      {},
    );
    expect(up.path).toBe("/v1beta/models/gemini-3.5-flash-lite:generateContent");
    expect(JSON.stringify(up.body)).toContain('"mime_type":"application/pdf"');
    const { result } = INTENTS.document_read!.parse({
      candidates: [{ content: { parts: [{ text: "Monday · 08:45" }] } }],
    });
    expect(result).toEqual({ text: "Monday · 08:45" });
  });

  it("reads a saved video inline on the native surface, at low resolution", () => {
    const up = INTENTS.video_read!.build(
      "gemini-3.5-flash-lite",
      { video_base64: "AAAAIGZ0eXA=", mime: "video/mp4" },
      {},
    );
    expect(up.path).toBe("/v1beta/models/gemini-3.5-flash-lite:generateContent");
    const body = JSON.stringify(up.body);
    expect(body).toContain('"mime_type":"video/mp4"');
    expect(body).toContain("MEDIA_RESOLUTION_LOW");
    const { result } = INTENTS.video_read!.parse({
      candidates: [{ content: { parts: [{ text: "A walk along the beach." }] } }],
    });
    expect(result).toEqual({ text: "A walk along the beach." });
  });

  it("400s a video read with no video", async () => {
    const res = await SELF.fetch("https://hop/v1/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${env.HOP_GATEWAY_API_KEY}` },
      body: JSON.stringify({ intent: "video_read", payload: { mime: "video/mp4" } }),
    });
    expect(res.status).toBe(400);
  });

  it("400s a document read with no document", async () => {
    const res = await SELF.fetch("https://hop/v1/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${env.HOP_GATEWAY_API_KEY}` },
      body: JSON.stringify({ intent: "document_read", payload: { mime: "application/pdf" } }),
    });
    expect(res.status).toBe(400);
  });

  it("404s anything else", async () => {
    expect((await SELF.fetch("https://hop/v1/chat/completions")).status).toBe(404);
    expect((await SELF.fetch("https://hop/openai/v1/models")).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Streaming chat
// ---------------------------------------------------------------------------

/** Gemini's OpenAI-compatible stream: one `data:` line per chunk, then [DONE]. */
function upstream(chunks: unknown[], done = true): ReadableStream<Uint8Array> {
  const text =
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
    (done ? "data: [DONE]\n\n" : "");
  const bytes = new TextEncoder().encode(text);
  // Split mid-line, the way a network delivers it.
  const cut = Math.floor(bytes.length / 2) + 3;
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes.slice(0, cut));
      c.enqueue(bytes.slice(cut));
      c.close();
    },
  });
}

async function frames(body: ReadableStream<Uint8Array> | null) {
  const text = await new Response(body).text();
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
      const data = /^data: (.*)$/m.exec(block)?.[1] ?? "";
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}

const delta = (d: Record<string, unknown>, finish: string | null = null) => ({
  choices: [{ index: 0, delta: d, finish_reason: finish }],
});

const HEAD = { intent: "chat", model_used: "gemini-3.5-flash-lite", key_id: "key-1" };

describe("relayChatStream", () => {
  it("passes text on as it arrives and ends with the whole envelope and its usage", async () => {
    const usages: unknown[] = [];
    const out = await frames(
      relayChatStream(
        upstream([
          delta({ role: "assistant", content: "You saved " }),
          delta({ content: "three ramen places." }),
          {
            ...delta({}, "stop"),
            usage: { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46 },
          },
        ]),
        HEAD,
        async (u) => {
          usages.push(u);
        },
      ),
    );

    expect(out.filter((f) => f.event === "delta").map((f) => f.data.content)).toEqual([
      "You saved ",
      "three ramen places.",
    ]);
    const done = out.at(-1);
    expect(done?.event).toBe("done");
    expect(done?.data).toEqual({
      ...HEAD,
      result: {
        content: "You saved three ramen places.",
        tool_calls: [],
        finish_reason: "stop",
      },
      usage: { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46 },
    });
    // Usage is handed over once, when the stream ends, for the broker to reconcile.
    expect(usages).toEqual([{ prompt_tokens: 40, completion_tokens: 6, total_tokens: 46 }]);
  });

  it("assembles tool calls split across chunks, thought signature included", async () => {
    const out = await frames(
      relayChatStream(
        upstream([
          delta({
            tool_calls: [
              {
                index: 0,
                id: "call_a",
                type: "function",
                function: { name: "search_library", arguments: '{"query":' },
                extra_content: { google: { thought_signature: "sig" } },
              },
            ],
          }),
          delta({ tool_calls: [{ index: 0, function: { arguments: '"ramen"}' } }] }),
          delta({}, "tool_calls"),
        ]),
        HEAD,
        async () => {},
      ),
    );

    expect(out.some((f) => f.event === "delta")).toBe(false);
    expect((out.at(-1)?.data.result as Record<string, unknown>).tool_calls).toEqual([
      {
        id: "call_a",
        type: "function",
        function: { name: "search_library", arguments: '{"query":"ramen"}' },
        extra_content: { google: { thought_signature: "sig" } },
      },
    ]);
  });

  it("ends with an error, not a done, when the upstream stops before finishing", async () => {
    const usages: unknown[] = [];
    const out = await frames(
      relayChatStream(upstream([delta({ content: "You saved" })], false), HEAD, async (u) => {
        usages.push(u);
      }),
    );
    expect(out.map((f) => f.event)).toEqual(["delta", "error"]);
    expect(usages).toEqual([]);
  });

  it("ends with an error when the upstream sends one mid-stream", async () => {
    const out = await frames(
      relayChatStream(
        upstream([delta({ content: "You" }), { error: { message: "overloaded", code: 503 } }]),
        HEAD,
        async () => {},
      ),
    );
    expect(out.map((f) => f.event)).toEqual(["delta", "error"]);
  });
});

describe("POST /v1/invoke with stream", () => {
  afterEach(() => vi.restoreAllMocks());

  const invoke = (body: Record<string, unknown>) =>
    SELF.fetch("https://hop/v1/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${env.HOP_GATEWAY_API_KEY}` },
      body: JSON.stringify(body),
    });

  const chatPayload = { messages: [{ role: "user", content: "what ramen did I save?" }] };

  it("400s an intent that does not stream, before any upstream call", async () => {
    const google = vi.spyOn(globalThis, "fetch");
    const res = await invoke({ intent: "classify", payload: chatPayload, stream: true });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("does not stream");
    expect(google).not.toHaveBeenCalled();
  });

  it("streams chat as SSE and reconciles the real token count when the stream ends", async () => {
    const sent: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(
        upstream([
          delta({ content: "Tonkotsu" }),
          {
            ...delta({}, "stop"),
            usage: { prompt_tokens: 7000, completion_tokens: 777, total_tokens: 7777 },
          },
        ]),
        { headers: { "content-type": "text/event-stream" } },
      );
    });

    const res = await invoke({ intent: "chat", payload: chatPayload, stream: true });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const out = await frames(res.body);
    expect(out.map((f) => f.event)).toEqual(["delta", "done"]);
    expect(sent[0]).toMatchObject({ stream: true, stream_options: { include_usage: true } });

    const done = out[1]?.data as { key_id: string; model_used: string };
    const usage = await SELF.fetch("https://hop/debug/usage", {
      headers: { authorization: `Bearer ${env.HOP_GATEWAY_API_KEY}` },
    });
    const rows = ((await usage.json()) as { usage: Array<Record<string, unknown>> }).usage;
    expect(
      rows.find((r) => r.key_id === done.key_id && r.model === done.model_used)?.tpm_used,
    ).toBe(7777);
  });

  it("answers chat as one JSON envelope, exactly as before, when the caller does not ask to stream", async () => {
    const sent: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({
        choices: [{ message: { content: "Tonkotsu." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      });
    });

    const res = await invoke({ intent: "chat", payload: chatPayload });

    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toMatchObject({
      intent: "chat",
      result: { content: "Tonkotsu.", tool_calls: [], finish_reason: "stop" },
      usage: { total_tokens: 7 },
    });
    expect(sent[0]?.stream).toBe(false);
    expect(sent[0]).not.toHaveProperty("stream_options");
  });
});

// ---------------------------------------------------------------------------
// A video too big to send inline, read through the Files API
// ---------------------------------------------------------------------------

const GOOGLE = "https://generativelanguage.googleapis.com";
const UPLOAD_URL = `${GOOGLE}/upload/v1beta/files?upload_id=u-1&upload_protocol=resumable`;
const CLIP = {
  name: "files/clip-1",
  uri: `${GOOGLE}/v1beta/files/clip-1`,
  mimeType: "video/mp4",
};
const VIDEO = "stands in for a video: what matters is that every byte arrives";
const MODEL = "gemini-3.5-flash-lite";
const READ = {
  candidates: [{ content: { parts: [{ text: "A walk along Juhu beach at sunset." }] } }],
  usageMetadata: { promptTokenCount: 6_100, candidatesTokenCount: 40, totalTokenCount: 6_140 },
};

/** One sub-request the hop made, named by the step of the upload it belongs to. */
interface Call {
  step: string;
  method: string;
  url: string;
  headers: Headers;
  body: string;
  /** Whether it was sent with a signal that can cut it off. */
  timed: boolean;
}

type Answer = (call: Call, n: number) => Response;

function stepOf(method: string, url: string): string {
  if (method === "POST" && url === `${GOOGLE}/upload/v1beta/files`) return "start";
  if (method === "POST" && url === UPLOAD_URL) return "upload";
  if (method === "GET" && url === `${GOOGLE}/v1beta/${CLIP.name}`) return "status";
  if (method === "POST" && url.endsWith(":generateContent")) return "read";
  if (method === "DELETE" && url === `${GOOGLE}/v1beta/${CLIP.name}`) return "delete";
  return `unexpected ${method} ${url}`;
}

const WORKING_GOOGLE: Partial<Record<string, Answer>> = {
  start: () => new Response(null, { headers: { "x-goog-upload-url": UPLOAD_URL } }),
  // A video is still processing when its upload finishes.
  upload: () => Response.json({ file: { ...CLIP, state: "PROCESSING" } }),
  status: () => Response.json({ ...CLIP, state: "ACTIVE" }),
  read: () => Response.json(READ),
  delete: () => Response.json({}),
};

/**
 * Stands in for Google, one step of the upload at a time. Every step answers
 * the way a working Gemini does unless the test says otherwise; `n` counts
 * earlier calls to the same step. Each sub-request is recorded, the uploaded
 * bytes included.
 */
function google(answers: Partial<Record<string, Answer>> = {}): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const method = init?.method ?? "GET";
    const url = String(input instanceof Request ? input.url : input);
    const call: Call = {
      step: stepOf(method, url),
      method,
      url,
      headers: new Headers(init?.headers),
      body: init?.body ? await new Response(init.body).text() : "",
      timed: init?.signal != null,
    };
    const n = calls.filter((c) => c.step === call.step).length;
    calls.push(call);
    const answer = answers[call.step] ?? WORKING_GOOGLE[call.step];
    if (!answer) throw new Error(call.step);
    return answer(call, n);
  });
  return calls;
}

const readVideo = (headers: Record<string, string> = {}, body: BodyInit = VIDEO) =>
  SELF.fetch("https://hop/v1/files/video_read", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.HOP_GATEWAY_API_KEY}`,
      "content-type": "video/mp4",
      ...headers,
    },
    body,
  });

/** The id of the configured key a sub-request presented. */
const keyIdOf = (call: Call | undefined) =>
  parseApiKeys(env.GEMINI_API_KEYS).find((k) => k.key === call?.headers.get("x-goog-api-key"))
    ?.id;

interface UsageRow {
  key_id: string;
  model: string;
  tpm_used: number;
  blocked_for_ms: number;
}

async function usage(): Promise<UsageRow[]> {
  const res = await SELF.fetch("https://hop/debug/usage", {
    headers: { authorization: `Bearer ${env.HOP_GATEWAY_API_KEY}` },
  });
  return ((await res.json()) as { usage: UsageRow[] }).usage;
}

const tpm = (rows: UsageRow[], keyId: string | undefined) =>
  rows.find((r) => r.key_id === keyId && r.model === MODEL)?.tpm_used ?? 0;

interface GenerateContent {
  contents: Array<{ parts: unknown[] }>;
  generationConfig: unknown;
}

describe("POST /v1/files/video_read", () => {
  const realClock = { ...clock };
  // Production's poll schedule, on a clock that moves only when the poll sleeps:
  // two minutes of waiting pass in no time at all.
  let now = 0;
  beforeEach(() => {
    now = 0;
    clock.now = () => now;
    clock.sleep = async (ms) => {
      now += ms;
    };
  });
  afterEach(() => {
    Object.assign(clock, realClock);
    vi.restoreAllMocks();
  });

  it("streams the video into an upload on one key, reads it there, and deletes it", async () => {
    const before = await usage();
    const calls = google({
      // Still processing at the first look, so the poll has to go round again.
      status: (_call, n) =>
        Response.json({ ...CLIP, state: n === 0 ? "PROCESSING" : "ACTIVE" }),
    });

    const res = await readVideo();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { key_id: string };
    expect(calls.map((c) => c.step)).toEqual([
      "start",
      "upload",
      "status",
      "status",
      "read",
      "delete",
    ]);
    const [start, upload, , , read] = calls;

    expect(Object.fromEntries(start!.headers)).toMatchObject({
      "x-goog-upload-protocol": "resumable",
      "x-goog-upload-command": "start",
      "x-goog-upload-header-content-length": String(VIDEO.length),
      "x-goog-upload-header-content-type": "video/mp4",
    });
    expect(JSON.parse(start!.body)).toEqual({ file: { display_name: "video" } });

    // The bytes go to the session URL Google answered with, their length declared.
    expect(Object.fromEntries(upload!.headers)).toMatchObject({
      "x-goog-upload-command": "upload, finalize",
      "x-goog-upload-offset": "0",
      "content-length": String(VIDEO.length),
    });
    expect(upload!.body).toBe(VIDEO);

    // Read by its URI, with the inline read's prompt and settings. Google gave no
    // duration here, so the read stops at ten minutes, the most this route reads.
    const inline = INTENTS.video_read!.build(
      MODEL,
      { video_base64: "AA==", mime: "video/mp4" },
      {},
    ).body as GenerateContent;
    const sent = JSON.parse(read!.body) as GenerateContent;
    expect(read!.url).toBe(`${GOOGLE}/v1beta/models/${MODEL}:generateContent`);
    expect(sent.contents[0]!.parts).toEqual([
      {
        file_data: { mime_type: "video/mp4", file_uri: CLIP.uri },
        video_metadata: { end_offset: "600s" },
      },
      inline.contents[0]!.parts[1],
    ]);
    expect(sent.generationConfig).toEqual(inline.generationConfig);

    // The small steps are cut off if they hang; the upload runs as long as its bytes.
    expect(
      Object.fromEntries(calls.filter((c) => c.step !== "read").map((c) => [c.step, c.timed])),
    ).toEqual({ start: true, upload: false, status: true, delete: true });

    // One key throughout: an uploaded file belongs to the key's own project.
    const key = start!.headers.get("x-goog-api-key");
    expect(key).toBeTruthy();
    expect(
      calls.filter((c) => c.step !== "upload").map((c) => c.headers.get("x-goog-api-key")),
    ).toEqual([key, key, key, key, key]);

    expect(body).toEqual({
      intent: "video_read",
      model_used: MODEL,
      key_id: keyIdOf(start),
      result: { text: "A walk along Juhu beach at sunset." },
      usage: { prompt_tokens: 6_100, completion_tokens: 40, total_tokens: 6_140 },
    });
    // The reservation's estimate is replaced by what Google billed.
    expect(tpm(await usage(), body.key_id)).toBe(tpm(before, body.key_id) + 6_140);
  });

  it("401s a missing gateway key, before any upstream call", async () => {
    const calls = google();
    const res = await SELF.fetch("https://hop/v1/files/video_read", {
      method: "POST",
      headers: { "content-type": "video/mp4" },
      body: VIDEO,
    });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("400s a body without a content-length, or one that is not a video, before any upstream call", async () => {
    const calls = google();
    // A stream of unknown length goes out chunked, with no content-length. Nothing
    // is ever written to it: the answer must not wait for a byte.
    const unsized = await readVideo({}, new TransformStream().readable);
    expect(unsized.status).toBe(400);
    expect(JSON.stringify(await unsized.json())).toContain("content-length");
    expect((await readVideo({ "content-type": "application/pdf" })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("413s a video over 100 MB on its content-length alone", async () => {
    const calls = google();
    // Declares 100,000,001 bytes and sends none: the answer must not wait for them.
    const { readable } = new FixedLengthStream(100_000_001);
    const res = await readVideo({}, readable);
    expect(res.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it("422s a video Google could not process, deletes it, and keeps the estimate charged", async () => {
    const before = await usage();
    const calls = google({
      status: () =>
        Response.json({ ...CLIP, state: "FAILED", error: { message: "unreadable" } }),
    });

    const res = await readVideo({ "x-duration-ms": "30000" });

    expect(res.status).toBe(422);
    expect(calls.map((c) => c.step)).toEqual(["start", "upload", "status", "delete"]);
    // Nothing was read, so nothing reconciles: 30 s at ~100 tokens a second, plus 2,000.
    const keyId = keyIdOf(calls[0]);
    expect(tpm(await usage(), keyId) - tpm(before, keyId)).toBe(5_000);
  });

  it("503s Gemini refusing this Worker's location, so the caller retries rather than gives up", async () => {
    const calls = google({
      upload: () => Response.json({ file: { ...CLIP, state: "ACTIVE" } }),
      read: () =>
        Response.json(
          {
            error: {
              code: 400,
              message: "User location is not supported for the API use.",
              status: "FAILED_PRECONDITION",
            },
          },
          { status: 400 },
        ),
    });

    const res = await readVideo({ "x-duration-ms": "5000" });

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { status: 503 } });
    expect(calls.map((c) => c.step)).toEqual(["start", "upload", "read", "delete"]);
  });

  it("503s a video still processing at two minutes, inside Workers Free's 50 subrequests, deleting it last", async () => {
    const calls = google({ status: () => Response.json({ ...CLIP, state: "PROCESSING" }) });

    const res = await readVideo({ "x-duration-ms": "5000" });

    expect(res.status).toBe(503);
    // 2, 2, 3, 5 and 8 s, then every 10 s: fifteen looks in two minutes, not sixty.
    expect(calls.filter((c) => c.step === "status")).toHaveLength(15);
    expect(now).toBe(120_000);
    expect(calls.map((c) => c.step)).not.toContain("read");
    expect(calls.length).toBeLessThanOrEqual(50);
    expect(calls.at(-1)?.step).toBe("delete");
  });

  it("stops looking at the poll cap even on a clock that never moves, so the delete still fits", async () => {
    // Time stands still, so only the cap can end the wait. The guard turns a
    // poll that never stops into a failure instead of a hung suite.
    let sleeps = 0;
    clock.sleep = async () => {
      if (++sleeps > 100) throw new Error("the poll never stopped");
    };
    const calls = google({ status: () => Response.json({ ...CLIP, state: "PROCESSING" }) });

    const res = await readVideo({ "x-duration-ms": "5000" });

    expect(res.status).toBe(503);
    // 50 subrequests, less start, upload, delete and the broker's three.
    expect(calls.filter((c) => c.step === "status")).toHaveLength(44);
    expect(calls.length).toBeLessThanOrEqual(50);
    expect(calls.at(-1)?.step).toBe("delete");
  });

  it("never sleeps past two minutes, however long each look takes", async () => {
    const wokeAt: number[] = [];
    clock.sleep = async (ms) => {
      now += ms;
      wokeAt.push(now);
    };
    // Each look takes Google a second and a half to answer.
    google({
      status: () => {
        now += 1_500;
        return Response.json({ ...CLIP, state: "PROCESSING" });
      },
    });

    expect((await readVideo({ "x-duration-ms": "5000" })).status).toBe(503);
    expect(Math.max(...wokeAt)).toBe(120_000);
  });

  it("reads a video to its own end when it is under ten minutes, and to ten minutes when longer", async () => {
    // The duration comes from the ACTIVE file the last look returned, not from the upload.
    const endOffsetFor = async (videoDuration: string) => {
      const calls = google({
        status: () =>
          Response.json({ ...CLIP, state: "ACTIVE", videoMetadata: { videoDuration } }),
      });
      expect((await readVideo({ "x-duration-ms": "30000" })).status).toBe(200);
      vi.restoreAllMocks();
      const read = calls.find((c) => c.step === "read");
      return (JSON.parse(read!.body) as GenerateContent).contents[0]!.parts[0];
    };

    expect(await endOffsetFor("30s")).toMatchObject({ video_metadata: { end_offset: "30s" } });
    expect(await endOffsetFor("1250.5s")).toMatchObject({
      video_metadata: { end_offset: "600s" },
    });
  });

  it("503s an upload that breaks off, and reads nothing", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = google({
      upload: () => {
        throw new TypeError("Network connection lost.");
      },
    });

    const res = await readVideo({ "x-duration-ms": "5000" });

    expect(res.status).toBe(503);
    expect(calls.map((c) => c.step)).toEqual(["start", "upload"]);
    expect(logged).toHaveBeenCalledWith(
      "video_read upload failed:",
      expect.objectContaining({ message: "Network connection lost." }),
    );
  });

  it("503s an upload session Google opened without saying where the bytes go", async () => {
    const calls = google({ start: () => new Response(null, { status: 200 }) });

    const res = await readVideo({ "x-duration-ms": "5000" });

    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).toContain("no upload URL");
    expect(calls.map((c) => c.step)).toEqual(["start"]);
  });

  it("503s Google failing the read, so the caller retries, and deletes the file", async () => {
    const calls = google({
      upload: () => Response.json({ file: { ...CLIP, state: "ACTIVE" } }),
      read: () => new Response("internal error", { status: 500 }),
    });

    const res = await readVideo({ "x-duration-ms": "5000" });

    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).toContain("Gemini answered 500");
    expect(calls.map((c) => c.step)).toEqual(["start", "upload", "read", "delete"]);
  });

  it("passes any other upstream 4xx through with its status, and never the key", async () => {
    const calls = google({
      upload: () => Response.json({ file: { ...CLIP, state: "ACTIVE" } }),
      read: (call) =>
        new Response(`key ${call.headers.get("x-goog-api-key")} may not read ${CLIP.name}`, {
          status: 403,
        }),
    });

    const res = await readVideo({ "x-duration-ms": "5000" });

    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toContain("may not read");
    expect(text).not.toContain(`key ${calls[0]!.headers.get("x-goog-api-key")} `);
  });

  // Last in this block: it leaves a key blocked on the model for a minute.
  it("429s and takes the pair out of rotation when Google refuses the upload for quota", async () => {
    const calls = google({
      start: () =>
        Response.json({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }, { status: 429 }),
    });

    const res = await readVideo({ "x-duration-ms": "5000" });

    expect(res.status).toBe(429);
    expect(calls.map((c) => c.step)).toEqual(["start"]);
    const row = (await usage()).find(
      (r) => r.key_id === keyIdOf(calls[0]) && r.model === MODEL,
    );
    expect(row?.blocked_for_ms).toBeGreaterThan(0);
  });

  // After the 429 above, so it reserves another key, and blocks that one in turn.
  it("429s and takes the pair out of rotation when Google refuses the key for want of credit", async () => {
    const calls = google({
      start: () => Response.json({ error: { code: 402, message: "billing" } }, { status: 402 }),
    });

    const res = await readVideo({ "x-duration-ms": "5000" });

    expect(res.status).toBe(429);
    expect(calls.map((c) => c.step)).toEqual(["start"]);
    const row = (await usage()).find((r) => r.key_id === keyIdOf(calls[0]) && r.model === MODEL);
    expect(row?.blocked_for_ms).toBeGreaterThan(0);
  });
});

// Last in the file: these leave Inception pairs blocked for a minute.
describe("Inception", () => {
  afterEach(() => vi.restoreAllMocks());

  const invoke = (body: Record<string, unknown>) =>
    SELF.fetch("https://hop/v1/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${env.HOP_GATEWAY_API_KEY}` },
      body: JSON.stringify(body),
    });

  /** Routes fetch by host: `inception(auth, url)` answers Mercury, Gemini always says 200. */
  function upstreams(inception: (auth: string, url: string) => Response) {
    const calls: Array<{ url: string; auth: string; body: Record<string, unknown> }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      calls.push({ url, auth, body: JSON.parse(String(init?.body)) });
      if (url.startsWith("https://api.inceptionlabs.ai/")) return inception(auth, url);
      return Response.json({
        choices: [{ message: { content: "from gemini" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    });
    return calls;
  }

  it("serves text on Mercury first, moving past a key out of credit", async () => {
    const calls = upstreams((auth) =>
      auth === "Bearer m1"
        ? new Response("credit spent", { status: 402 })
        : Response.json({
            choices: [
              {
                message: { content: '{"kind":"place"}', tool_calls: null },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
          }),
    );

    const res = await invoke({
      intent: "classify",
      payload: { messages: [{ role: "user", content: "Ippudo, Bandra" }] },
      options: { temperature: 0 },
    });

    expect(await res.json()).toMatchObject({
      model_used: "mercury-3",
      key_id: "inception-b",
      result: { content: '{"kind":"place"}', tool_calls: [] },
    });
    expect(calls.map((c) => c.auth)).toEqual(["Bearer m1", "Bearer m2"]);
    expect(calls[1]?.url).toBe("https://api.inceptionlabs.ai/v1/chat/completions");
    // Mercury resets a temperature below 0.5 to 1; the hop sends its floor instead.
    expect(calls[1]?.body.temperature).toBe(0.5);

    const usage = await SELF.fetch("https://hop/debug/usage", {
      headers: { authorization: `Bearer ${env.HOP_GATEWAY_API_KEY}` },
    });
    const rows = ((await usage.json()) as { usage: Array<Record<string, unknown>> }).usage;
    const spent = rows.find((r) => r.key_id === "inception-a" && r.model === "mercury-3");
    expect(spent?.blocked_for_ms).toBeGreaterThan(0);
  });

  it("falls back to Gemini once Mercury refuses on every key and model", async () => {
    const calls = upstreams(() => new Response("credit spent", { status: 402 }));

    const res = await invoke({
      intent: "extract",
      payload: { messages: [{ role: "user", content: "Ippudo, Bandra" }] },
    });

    expect(await res.json()).toMatchObject({
      model_used: "gemini-3.5-flash-lite",
      result: { content: "from gemini" },
    });
    expect(calls.filter((c) => c.url.includes("inceptionlabs")).length).toBeGreaterThan(0);
  });

  it("answers decide on Mercury Decide, passing state and questions through", async () => {
    const calls = upstreams(() =>
      Response.json({
        model: "mercury-decide",
        answers: { is_i1: { type: "noul", noul: 0.97 } },
        usage: { input_tokens: 48, output_tokens: 1 },
      }),
    );
    const questions = {
      is_i1: { type: "noul", instructions: "Is items.i1 what `query` means?" },
    };

    const res = await invoke({
      intent: "decide",
      payload: { state: { query: "ramen", items: { i1: "Ippudo" } }, questions },
    });

    expect(await res.json()).toMatchObject({
      model_used: "mercury-decide",
      result: { answers: { is_i1: { noul: 0.97 } } },
      usage: { prompt_tokens: 48, completion_tokens: 1, total_tokens: 49 },
    });
    expect(calls[0]?.url).toBe("https://api.inceptionlabs.ai/v1/decisions");
    expect(calls[0]?.body).toEqual({
      model: "mercury-decide",
      state: { query: "ramen", items: { i1: "Ippudo" } },
      questions,
    });
  });

  it("400s a decide without questions, before any upstream call", async () => {
    const calls = upstreams(() => new Response("unreachable", { status: 500 }));
    const res = await invoke({ intent: "decide", payload: { state: "x", questions: {} } });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
