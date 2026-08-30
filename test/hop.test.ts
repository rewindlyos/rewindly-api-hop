import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { parseApiKeys, tokenMatches } from "../src/config";
import { INTENTS } from "../src/intents";
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
