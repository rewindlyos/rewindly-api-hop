import { globalCeiling, type Lane, LANES, limitsFor } from "./budgets";
import { bearerToken, parseApiKeys, tokenMatches } from "./config";
import { callGemini } from "./gemini";
import { INTENTS } from "./intents";
import { QuotaBroker } from "./quota_broker";
import { relayChatStream } from "./stream";
import { UserBudget } from "./user_budget";
import { AppError, BadRequestError, UnauthorizedError } from "./utils/error";

export { QuotaBroker, UserBudget };

/**
 * The Rewindly API hop.
 *
 * One endpoint, one gateway key, for every AI task the backend performs. The
 * caller says what it is trying to do; which Gemini model and which of our four
 * free-tier keys serves it is decided here, against live per-key counters, and
 * never by the caller.
 *
 * Public surface:
 *   POST /v1/invoke     the only task endpoint
 *   GET  /health        no auth, liveness only
 *   GET  /debug/usage   same auth, current counters
 */

/** How many (key, model) pairs one request may burn through before giving up. */
const MAX_ATTEMPTS = 12;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function broker(env: Env): DurableObjectStub<QuotaBroker> {
  // One instance, globally. Counters that were per-isolate would be no counters
  // at all -- the point is that every request on every colo sees the same
  // numbers.
  return env.QUOTA_BROKER.get(env.QUOTA_BROKER.idFromName("global"));
}

function requireAuth(request: Request, env: Env): void {
  const expected = env.HOP_GATEWAY_API_KEY;
  // Fails closed. An unset secret must not mean an open gateway holding four
  // live provider credentials.
  if (!expected) throw new AppError("gateway key is not configured", 503);
  const presented = bearerToken(request);
  if (!presented || !tokenMatches(presented, expected)) throw new UnauthorizedError();
}

/**
 * A 400 means the request itself is wrong, so every other key and model rejects
 * it too -- failing over would burn the whole chain to reach the same answer
 * more slowly. Everything else is worth trying elsewhere: 429 (quota), 404 (the
 * model is retired on this project), 401/403 (that key is dead), 5xx.
 */
function worthRetrying(status: number): boolean {
  return status !== 400;
}

/**
 * A budget's refusal, distinguishable from the provider running out: a reason
 * of its own, and when to come back.
 */
function budgetRefusal(reason: "user_budget" | "global_budget", retryAt: number): Response {
  return json(
    {
      error: {
        message:
          reason === "user_budget"
            ? `this person's budget is spent until ${new Date(retryAt).toISOString()}`
            : `today's spending ceiling is reached until ${new Date(retryAt).toISOString()}`,
        status: 429,
        reason,
        retry_at: retryAt,
      },
      status: 429,
    },
    429,
  );
}

async function invoke(request: Request, env: Env): Promise<Response> {
  let body: {
    intent?: unknown;
    payload?: unknown;
    options?: unknown;
    stream?: unknown;
    user_id?: unknown;
    plan?: unknown;
    lane?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    throw new BadRequestError("body must be JSON");
  }

  const name = typeof body.intent === "string" ? body.intent : "";
  const intent = INTENTS[name];
  // Never a passthrough attempt. An unrecognised intent is a caller bug, and
  // guessing at it would put an unbudgeted model on a key.
  if (!intent) {
    throw new BadRequestError(
      `unknown intent ${JSON.stringify(name)}. Known: ${Object.keys(INTENTS).join(", ")}`,
    );
  }

  // Opt-in, per request. Every caller that does not ask gets the JSON envelope
  // exactly as before.
  const stream = body.stream === true;
  if (stream && !intent.streams) {
    throw new BadRequestError(`intent ${name} does not stream`);
  }

  const payload = (body.payload ?? {}) as Record<string, unknown>;
  const options = (body.options ?? {}) as Record<string, unknown>;
  if (typeof payload !== "object" || Array.isArray(payload)) {
    throw new BadRequestError("payload must be an object");
  }

  const keys = parseApiKeys(env.GEMINI_API_KEYS);
  if (keys.length === 0) throw new AppError("no Gemini keys configured", 503);
  const keyById = new Map(keys.map((k) => [k.id, k.key]));
  const keyIds = keys.map((k) => k.id);

  const gw = {
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    name: env.AI_GATEWAY_NAME,
    token: env.CF_AIG_TOKEN,
  };

  const est = intent.estimate(payload);
  const hop = broker(env);
  const tried: Array<[string, string]> = [];
  const failures: string[] = [];

  /**
   * Whose call this is. The Worker names the person, their plan and the lane;
   * a caller that names nobody (a Worker from before budgets) is served as
   * before and counted only against the global ceiling.
   */
  const userId = typeof body.user_id === "string" && body.user_id ? body.user_id : null;
  const lane: Lane = LANES.includes(body.lane as Lane) ? (body.lane as Lane) : "chat";
  const plan = typeof body.plan === "string" ? body.plan : "free";
  const now = Date.now();
  const budget = userId ? env.USER_BUDGET.get(env.USER_BUDGET.idFromName(userId)) : null;
  let ticket: string | null = null;
  if (budget) {
    const reserved = await budget.reserve(lane, limitsFor(plan, env.PLAN_LIMITS), est, now);
    if (!reserved.ok) return budgetRefusal("user_budget", reserved.retryAt);
    ticket = reserved.ticket;
  }
  const spend = await hop.reserveSpend(est, globalCeiling(env.GLOBAL_DAILY_TOKENS), now);
  if (!spend.ok) {
    if (budget && ticket) await budget.settle(ticket, est, 0, Date.now());
    return budgetRefusal("global_budget", spend.retryAt);
  }
  /** What the call really cost, against both; a call that never ran cost nothing. */
  const settle = async (actual: number) => {
    await Promise.all([
      budget && ticket ? budget.settle(ticket, est, actual, Date.now()) : null,
      hop.settleSpend(est, actual, Date.now()),
    ]);
  };

  try {
    return await callWithRetries();
  } catch (err) {
    // A request that throws (a payload the intent cannot build) never ran.
    await settle(0);
    throw err;
  }

  async function callWithRetries(): Promise<Response> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const reservation = await hop.reserve(keyIds, intent.models, est, tried);
      // Every key on every candidate model is spent or blocked. This is the only
      // path that 429s the caller, and it means the whole intent has no capacity
      // left -- not that one key ran out.
      if (!reservation) {
        await settle(0);
        return json(
          {
            error: {
              message: `no capacity for intent ${name} on any key or candidate model`,
              status: 429,
              tried: tried.map(([k, m]) => `${k}/${m}`),
              failures,
            },
            status: 429,
          },
          429,
        );
      }

      const { keyId, model } = reservation;
      tried.push([keyId, model]);

      const upstream = intent.build(model, payload, options, stream);
      const res = await callGemini(
        upstream.path,
        upstream.body,
        keyById.get(keyId) as string,
        gw,
        upstream.timeoutMs,
      );

      if (!res.ok) {
        const detail = (await res.text()).slice(0, 600);
        failures.push(`${keyId}/${model}: ${res.status} ${detail}`);

        // 429 for a key we believed had headroom: clock drift, a stale estimate,
        // or traffic against this key from outside this system. Believe upstream
        // over the counter, and take that pair out of rotation for a minute.
        if (res.status === 429) await hop.markExhausted(keyId, model);

        if (worthRetrying(res.status)) continue;

        // A 400 is the caller's request, not our routing. Surfaced as-is so the
        // caller sees Gemini's own complaint rather than a laundered one.
        await settle(0);
        return json({ error: { message: detail, status: 400, model_used: model } }, 400);
      }

      // Everything above -- auth, the reservation, the retry walk, a 400 or a 429
      // -- is the same for a stream. Only a 200 from Gemini turns into SSE.
      if (stream && res.body) {
        const head = {
          intent: name,
          model_used: model,
          key_id: keyId,
          ...(failures.length ? { retries: failures } : {}),
        };
        const body = relayChatStream(res.body, head, async (usage) => {
          if (usage.total_tokens > 0)
            await hop.reconcile(keyId, model, est, usage.total_tokens);
          // No usage reported keeps the estimate charged, which is the safe side.
          await settle(usage.total_tokens || est);
        });
        return new Response(body, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        });
      }

      const parsed = intent.parse((await res.json()) as Record<string, unknown>);
      // Correct the TPM estimate with what was actually billed. Not awaited into
      // the caller's latency budget -- the next request must see the true number,
      // but this one has already been served.
      if (parsed.usage.total_tokens > 0) {
        await hop.reconcile(keyId, model, est, parsed.usage.total_tokens);
      }
      // A live session is admitted here and spends on its own socket, which this
      // never sees: its estimate stays charged.
      await settle(parsed.usage.total_tokens || est);

      return json({
        intent: name,
        model_used: model,
        key_id: keyId,
        result: parsed.result,
        usage: parsed.usage,
        // Present only when the request did not land first try, so a caller can
        // see quota exhaustion happening instead of only its eventual 429.
        ...(failures.length ? { retries: failures } : {}),
      });
    }

    await settle(0);
    return json(
      { error: { message: `gave up after ${MAX_ATTEMPTS} attempts`, status: 429, failures } },
      429,
    );
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);

    try {
      if (pathname === "/health") {
        return json({ ok: true, intents: Object.keys(INTENTS) });
      }

      if (pathname === "/v1/invoke") {
        if (request.method !== "POST") throw new AppError("method not allowed", 405);
        // Before any upstream call, on purpose: an unauthenticated request must
        // not be able to spend a key even by accident.
        requireAuth(request, env);
        return await invoke(request, env);
      }

      if (pathname === "/debug/usage") {
        requireAuth(request, env);
        return json({
          keys: parseApiKeys(env.GEMINI_API_KEYS).map((k) => k.id),
          usage: await broker(env).snapshot(),
          spent_today: await broker(env).spentToday(Date.now()),
          ceiling: globalCeiling(env.GLOBAL_DAILY_TOKENS),
        });
      }

      throw new AppError("not found", 404);
    } catch (err) {
      const status = err instanceof AppError ? err.status : 500;
      const message =
        err instanceof AppError
          ? err.message
          : // Never the raw error: an upstream failure body can echo an API key
            // back, and this response goes to the caller.
            "internal";
      if (!(err instanceof AppError)) console.error("Unhandled error:", err);
      return json({ error: { message, status } }, status);
    }
  },
} satisfies ExportedHandler<Env>;
