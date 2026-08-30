import { bearerToken, parseApiKeys, tokenMatches } from "./config";
import { callGemini } from "./gemini";
import { INTENTS } from "./intents";
import { QuotaBroker } from "./quota_broker";
import { AppError, BadRequestError, UnauthorizedError } from "./utils/error";

export { QuotaBroker };

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

async function invoke(request: Request, env: Env): Promise<Response> {
  let body: { intent?: unknown; payload?: unknown; options?: unknown };
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

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const reservation = await hop.reserve(keyIds, intent.models, est, tried);
    // Every key on every candidate model is spent or blocked. This is the only
    // path that 429s the caller, and it means the whole intent has no capacity
    // left -- not that one key ran out.
    if (!reservation) {
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

    const upstream = intent.build(model, payload, options);
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
      return json({ error: { message: detail, status: 400, model_used: model } }, 400);
    }

    const parsed = intent.parse((await res.json()) as Record<string, unknown>);
    // Correct the TPM estimate with what was actually billed. Not awaited into
    // the caller's latency budget -- the next request must see the true number,
    // but this one has already been served.
    if (parsed.usage.total_tokens > 0) {
      await hop.reconcile(keyId, model, est, parsed.usage.total_tokens);
    }

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

  return json(
    { error: { message: `gave up after ${MAX_ATTEMPTS} attempts`, status: 429, failures } },
    429,
  );
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
