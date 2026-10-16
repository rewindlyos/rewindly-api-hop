import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { globalCeiling, limitsFor } from "../src/budgets";
import type { QuotaBroker } from "../src/quota_broker";
import type { UserBudget } from "../src/user_budget";

/**
 * Per-user budgets. The hop is the one place every model call passes, so it is
 * where one person's calls are counted against what their plan allows: cost is
 * reserved before a call and settled at what it really cost after, per day and
 * per minute, with a cap on how many pipeline calls one person runs at once —
 * and one ceiling on what everyone together may spend in a day. A refusal says
 * `reason: "user_budget"` and when to come back, so the caller can tell it from
 * the provider running out.
 */

const LIMITS = { dailyTokens: 1_000, minuteTokens: 400, pipelineConcurrency: 2 };
const DAY = 86_400_000;

function withBudget<T>(fn: (b: UserBudget) => Promise<T>): Promise<T> {
  const id = env.USER_BUDGET.idFromName(`u-${Math.random()}`);
  return runInDurableObject(env.USER_BUDGET.get(id), fn);
}

describe("UserBudget", () => {
  it("refuses past the day's tokens, until the next UTC midnight", async () => {
    await withBudget(async (b) => {
      const now = Date.UTC(2026, 9, 17, 10, 0, 0);
      expect((await b.reserve("chat", LIMITS, 300, now)).ok).toBe(true);
      expect((await b.reserve("chat", LIMITS, 300, now + 61_000)).ok).toBe(true);
      expect((await b.reserve("chat", LIMITS, 300, now + 122_000)).ok).toBe(true);
      const refused = await b.reserve("chat", LIMITS, 300, now + 183_000);
      expect(refused).toEqual({ ok: false, why: "daily", retryAt: Date.UTC(2026, 9, 18) });
    });
  });

  it("refuses a burst past the minute's tokens, until the next minute", async () => {
    await withBudget(async (b) => {
      const now = Date.UTC(2026, 9, 17, 10, 0, 5);
      expect((await b.reserve("chat", LIMITS, 300, now)).ok).toBe(true);
      const refused = await b.reserve("chat", LIMITS, 300, now + 1_000);
      expect(refused).toEqual({
        ok: false,
        why: "minute",
        retryAt: Date.UTC(2026, 9, 17, 10, 1),
      });
    });
  });

  it("caps one person's pipeline calls running at once, and frees a slot when one settles", async () => {
    await withBudget(async (b) => {
      const now = Date.UTC(2026, 9, 17, 10, 0, 0);
      const a = await b.reserve("pipeline", LIMITS, 10, now);
      const second = await b.reserve("pipeline", LIMITS, 10, now);
      expect(a.ok && second.ok).toBe(true);
      const third = await b.reserve("pipeline", LIMITS, 10, now);
      expect(third).toMatchObject({ ok: false, why: "concurrency" });
      // Chat is not the pipeline's lane: a person can still talk to Rem.
      expect((await b.reserve("chat", LIMITS, 10, now)).ok).toBe(true);
      if (a.ok) await b.settle(a.ticket, 10, 10, now);
      expect((await b.reserve("pipeline", LIMITS, 10, now)).ok).toBe(true);
    });
  });

  it("settles at what a call really cost", async () => {
    await withBudget(async (b) => {
      const now = Date.UTC(2026, 9, 17, 10, 0, 0);
      const r = await b.reserve("chat", LIMITS, 900, now);
      if (r.ok) await b.settle(r.ticket, 900, 100, now);
      // 100 used, so 900 more fits today.
      expect(
        (await b.reserve("chat", { ...LIMITS, minuteTokens: 10_000 }, 900, now + 1)).ok,
      ).toBe(true);
    });
  });

  it("frees a pipeline slot a caller never settled, once it is too old to be running", async () => {
    await withBudget(async (b) => {
      const now = Date.UTC(2026, 9, 17, 10, 0, 0);
      await b.reserve("pipeline", LIMITS, 1, now);
      await b.reserve("pipeline", LIMITS, 1, now);
      expect((await b.reserve("pipeline", LIMITS, 1, now + 11 * 60_000)).ok).toBe(true);
    });
  });
});

describe("plan limits", () => {
  it("treats a plan it does not know as free, and reads overrides from PLAN_LIMITS", () => {
    expect(limitsFor("mystery")).toEqual(limitsFor("free"));
    const raw = JSON.stringify({
      plus: { dailyTokens: 5, minuteTokens: 5, pipelineConcurrency: 1 },
    });
    expect(limitsFor("plus", raw)).toEqual({
      dailyTokens: 5,
      minuteTokens: 5,
      pipelineConcurrency: 1,
    });
  });
});

describe("POST /v1/invoke with a user", () => {
  afterEach(() => vi.restoreAllMocks());

  const invoke = (body: Record<string, unknown>) =>
    SELF.fetch("https://hop/v1/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${env.HOP_GATEWAY_API_KEY}` },
      body: JSON.stringify(body),
    });
  const classify = {
    intent: "classify",
    payload: { messages: [{ role: "user", content: "a ramen recipe" }] },
  };
  const ok = () =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
    );

  it("refuses a user whose budget is spent, says so, and calls no model", async () => {
    const google = ok();
    const user = `spent-${Math.random()}`;
    const stub = env.USER_BUDGET.get(env.USER_BUDGET.idFromName(user));
    const free = limitsFor("free");
    await runInDurableObject(stub, async (b: UserBudget) => {
      // The whole day at once: a minute's limit that does not stand in the way.
      b.reserve(
        "chat",
        { ...free, minuteTokens: free.dailyTokens },
        free.dailyTokens,
        Date.now(),
      );
    });

    const res = await invoke({ ...classify, user_id: user, plan: "free", lane: "pipeline" });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { reason: string; retry_at: number } };
    expect(body.error.reason).toBe("user_budget");
    expect(body.error.retry_at).toBeGreaterThan(Date.now());
    expect(google).not.toHaveBeenCalled();
  });

  it("charges the user what the call really cost", async () => {
    ok();
    const user = `paid-${Math.random()}`;
    const res = await invoke({ ...classify, user_id: user, plan: "free", lane: "chat" });
    expect(res.status).toBe(200);
    const stub = env.USER_BUDGET.get(env.USER_BUDGET.idFromName(user));
    const used = await runInDurableObject(stub, async (b: UserBudget) => b.usage(Date.now()));
    expect(used.dayTokens).toBe(7);
  });

  it("stops everyone once the day's global ceiling is reached, with a reason of its own", async () => {
    const google = ok();
    const broker = env.QUOTA_BROKER.get(env.QUOTA_BROKER.idFromName("global"));
    const ceiling = globalCeiling(undefined);
    // Whatever is left of today's ceiling: the broker is shared by every test here.
    const rest = await runInDurableObject(broker, async (b: QuotaBroker) => {
      const left = ceiling - b.spentToday(Date.now());
      b.reserveSpend(left, ceiling, Date.now());
      return left;
    });
    try {
      const res = await invoke({ ...classify, user_id: "anyone", plan: "free", lane: "chat" });
      expect(res.status).toBe(429);
      const body = (await res.json()) as { error: { reason: string; retry_at: number } };
      expect(body.error.reason).toBe("global_budget");
      expect(body.error.retry_at).toBeGreaterThan(Date.now());
      expect(google).not.toHaveBeenCalled();
    } finally {
      await runInDurableObject(broker, async (b: QuotaBroker) => {
        b.settleSpend(rest, 0, Date.now());
      });
    }
  });

  it("gives back what it reserved when the request itself is wrong", async () => {
    const user = `bad-${Math.random()}`;
    const res = await invoke({
      intent: "classify",
      payload: {},
      user_id: user,
      lane: "pipeline",
    });
    expect(res.status).toBe(400);
    const stub = env.USER_BUDGET.get(env.USER_BUDGET.idFromName(user));
    const used = await runInDurableObject(stub, async (b: UserBudget) => b.usage(Date.now()));
    expect(used).toEqual({ dayTokens: 0, minuteTokens: 0, pipelineInFlight: 0 });
  });

  it("serves a caller that sends no user, as callers did before budgets", async () => {
    ok();
    const res = await invoke(classify);
    expect(res.status).toBe(200);
  });
});
