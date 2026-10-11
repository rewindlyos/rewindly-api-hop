import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseApiKeys, tokenMatches } from "../src/config";
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
