# rewindly-api-hop

The AI gateway for Rewindly. **One URL, one API key, one endpoint** — for every AI task
the backend performs, whatever kind of task it is.

The backend does not choose a Gemini model, does not hold a Gemini key, and does not know
how many keys exist. It names an **intent**; this Worker decides which model and which of
our four free-tier keys serves it, against live per-key quota counters, and hops to
another when one runs out.

Deployed at **`https://api-hop.rewindly.workers.dev`**.

```bash
curl -X POST https://api-hop.rewindly.workers.dev/v1/invoke \
  -H "Authorization: Bearer $HOP_GATEWAY_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"intent":"classify","payload":{"messages":[{"role":"user","content":"..."}]}}'
```

---

## Public surface

| Route              | Auth                                          | What it does                                    |
| ------------------ | --------------------------------------------- | ----------------------------------------------- |
| `POST /v1/invoke`  | `Authorization: Bearer <HOP_GATEWAY_API_KEY>` | The only task endpoint.                         |
| `GET /health`      | none                                          | Liveness, plus the list of implemented intents. |
| `GET /debug/usage` | same bearer                                   | Current per-key, per-model counters and limits. |

There is nothing else. Every provider-prefixed passthrough, `/v1/chat/completions`,
`/v1/models`, and the `/key/{index}/` selector are gone — see [What was
stripped](#what-was-stripped).

### Request

```json
{
  "intent": "classify",
  "payload": { "messages": [{ "role": "user", "content": "..." }] },
  "options": { "temperature": 0, "max_output_tokens": 2048 }
}
```

### Response

```json
{
  "intent": "classify",
  "model_used": "gemini-3.5-flash-lite",
  "key_id": "key-2",
  "result": { "content": "...", "tool_calls": [], "finish_reason": "stop" },
  "usage": { "prompt_tokens": 34, "completion_tokens": 35, "total_tokens": 69 }
}
```

`retries` is added when the request did not land first try, so quota exhaustion is
visible rather than silently absorbed.

**Errors.** `401` no or wrong gateway key (before any upstream call). `400` unknown
intent, malformed payload, or a request Gemini itself rejected — never a passthrough
attempt. `429` only once **every** key on **every** candidate model for that intent is
spent; the body lists what was tried.

---

## Setup

```bash
npm install

# The four Gemini keys, as a JSON array. Ids are what /debug/usage reports and
# what the counters are keyed by, so keep them stable across deploys.
npx wrangler secret put GEMINI_API_KEYS
# [{"id":"key-1","key":"AIza..."},{"id":"key-2","key":"AIza..."},
#  {"id":"key-3","key":"AIza..."},{"id":"key-4","key":"AIza..."}]

# The one key every caller presents. Unrelated to the Gemini keys.
npx wrangler secret put HOP_GATEWAY_API_KEY   # openssl rand -hex 32

npx wrangler deploy
```

Optionally, for free request logging and analytics through **Cloudflare AI Gateway** —
set all three or none; unset means calls go straight to Google:

```bash
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put AI_GATEWAY_NAME
npx wrangler secret put CF_AIG_TOKEN
```

Local dev: copy `.dev.vars.example` to `.dev.vars`, then `npm run dev`.
Checks: `npm run gate` (tsc, lint, vitest).

### Adding a 5th, 6th, Nth key

Update the `GEMINI_API_KEYS` secret with the extra entry and redeploy. **No code
changes** — nothing counts keys, and the quota table is per-key, so every limit multiplies
by the number of keys you give it.

```bash
npx wrangler secret put GEMINI_API_KEYS   # paste the array with key-5 appended
npx wrangler deploy
```

A key with different limits (a paid-tier one, say) goes in `KEY_OVERRIDES` in
`src/quotas.ts`, which is consulted before `MODEL_QUOTAS`. It is empty today.

---

## Intents

Each intent is a real call site in the Rewindly backend — see [the audit](#the-audit).
Models are listed in preference order; the broker walks them until one has headroom.

| Intent             | What it does                                | Models, in order                                                                                                       |
| ------------------ | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `classify`         | Types a save and files it into a collection | `gemini-3.5-flash-lite` → `gemini-3.1-flash-lite` → `gemini-3.6-flash` → `gemini-3.5-flash` → `gemini-3-flash-preview` |
| `extract`          | Pulls typed fields out of a save            | same ladder                                                                                                            |
| `query_understand` | Expands a search query before retrieval     | same ladder                                                                                                            |
| `chat`             | Rem's tool-calling turn                     | same ladder                                                                                                            |
| `transcribe`       | Speech in, text out                         | `gemini-3.1-flash-lite` → `gemini-3.5-flash-lite`                                                                      |
| `vision_describe`  | Reads an image back as text                 | `gemini-3.5-flash-lite` → `gemini-3.1-flash-lite`                                                                      |
| `live_session`     | Mints a Live API session                    | `gemini-3.1-flash-live-preview`                                                                                        |

**Why the lite models lead.** They carry 500 requests/day against the full flash models' 20. Preferring the bigger model would spend the entire day's capacity on the first twenty
saves.

**`gemini-2.5-flash` and `gemini-2.5-flash-lite` are routed to by nothing.** They are
still returned by `GET /v1beta/models` and every call to them 404s on this account with
_"no longer available to new users"_. They stay in `MODEL_QUOTAS` as a record of their
console quota, and out of every candidate list.

### Examples

```bash
HOP=https://api-hop.rewindly.workers.dev
AUTH="Authorization: Bearer $HOP_GATEWAY_API_KEY"
JSON='content-type: application/json'
```

**classify / extract / query_understand** — chat-shaped, `response_format` optional:

```bash
curl -X POST $HOP/v1/invoke -H "$AUTH" -H "$JSON" -d '{
  "intent": "extract",
  "payload": {
    "messages": [{"role":"user","content":"Extract fields from: Dinner with Priya at Toit, Friday 8pm"}],
    "response_format": {"type":"json_schema","json_schema":{"name":"extract","strict":true,
      "schema":{"type":"object","additionalProperties":false,
        "required":["place","people","when"],
        "properties":{"place":{"type":"string"},
                      "people":{"type":"array","items":{"type":"string"}},
                      "when":{"type":"string"}}}}}
  },
  "options": {"temperature": 0}
}'
```

**chat** — send `tools`, read back `tool_calls`:

```bash
curl -X POST $HOP/v1/invoke -H "$AUTH" -H "$JSON" -d '{
  "intent": "chat",
  "payload": {
    "messages": [{"role":"user","content":"What did I save about ramen?"}],
    "tools": [{"type":"function","function":{"name":"search_saves",
      "description":"Search the saves.",
      "parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}}]
  }
}'
```

**transcribe** — audio rides inline; Gemini has no `/audio/transcriptions` endpoint:

```bash
curl -X POST $HOP/v1/invoke -H "$AUTH" -H "$JSON" -d "{
  \"intent\": \"transcribe\",
  \"payload\": {\"audio_base64\": \"$(base64 -i memo.wav)\", \"mime\": \"audio/wav\"}
}"
# -> {"result": {"text": "Remind me to buy paneer, spinach and kasuri methi..."}}
```

**vision_describe** — an image as multimodal input to a text-out model:

```bash
curl -X POST $HOP/v1/invoke -H "$AUTH" -H "$JSON" -d "{
  \"intent\": \"vision_describe\",
  \"payload\": {\"image_base64\": \"$(base64 -i shot.png)\", \"mime\": \"image/png\"}
}"
# -> {"result": {"description": "..."}}
```

**live_session** — returns a complete socket URL with a single-use token in it:

```bash
curl -X POST $HOP/v1/invoke -H "$AUTH" -H "$JSON" -d '{
  "intent": "live_session",
  "payload": {"setup": {
    "generationConfig": {"responseModalities": ["AUDIO"]},
    "systemInstruction": {"parts": [{"text": "You are Rem."}]}
  }}
}'
# -> {"result": {"url": "wss://...BidiGenerateContentConstrained?access_token=...",
#                "token": "auth_tokens/..."}}
```

**usage**:

```bash
curl $HOP/debug/usage -H "$AUTH"
```

```json
{
  "keys": ["key-1", "key-2", "key-3", "key-4"],
  "usage": [
    {
      "key_id": "key-1",
      "model": "gemini-3.5-flash-lite",
      "rpm_used": 15,
      "tpm_used": 153,
      "rpd_used": 15,
      "blocked_for_ms": 0,
      "limits": { "rpm": 15, "tpm": 250000, "rpd": 500 }
    }
  ]
}
```

A `null` limit means unlimited — `Infinity` survives neither SQLite nor JSON.

---

## How routing works

`QuotaBroker` (`src/quota_broker.ts`) is a **Durable Object**, and that is load-bearing.
Workers KV is eventually consistent: on a 5 RPM budget with one request of headroom left,
two concurrent requests both read `4 used`, both decide they fit, and both fire. A DO is
single-threaded, so the check and the increment cannot interleave. That is the whole
mechanism, not a style preference.

- **Selection.** Candidate models in preference order; within a model, the key with the
  lowest `max(rpm_used/rpm_limit, rpd_used/rpd_limit)` among keys with headroom on RPM,
  TPM and RPD. Not round-robin — the keys stop carrying equal usage the moment one retry
  lands.
- **Reservation, not tracking.** RPM and RPD increment _before_ the upstream call, with an
  estimated token count checked against TPM. The real usage reconciles TPM afterwards.
  This is what stops a burst all picking the same key in the gap between "checked" and
  "used".
- **Retry, two levels.** A 429 marks that key+model exhausted and retries with the
  next-best key for the same model; when every key is spent, it falls through to the next
  candidate model. Only when every key × model combination is exhausted does the caller
  get a 429. (404 and 5xx also advance — a retired model or an overloaded one is worth
  trying elsewhere. A 400 never does: the request is wrong and every other key rejects it
  too.)
- **24h disposal.** RPD resets on a rolling 24h window anchored to first use, checked
  lazily on every read. An hourly alarm sweeps expired rows so stale counters do not
  accumulate.

**Live sessions touch the broker once.** A key is reserved at admission, the token is
minted against it, and the socket that follows runs directly between the caller and Google
for the length of the call. Nothing in this Worker sits in the audio path, and no Durable
Object bills for the silence.

Measured on the live deployment — 70 concurrent `classify` calls:

```
by status: { '200': 70 }
by key:    { key-1: 17, key-2: 18, key-3: 18, key-4: 17 }
by model:  { gemini-3.5-flash-lite: 59, gemini-3.1-flash-lite: 11 }
first fall-through to a 2nd-choice model: request #59
requests that saw an upstream 429: 0
```

Request #59 is exactly where 4 keys x 15 rpm exhausts the first model. Zero upstream 429s:
the counters kept every request inside real quota.

---

## The audit

Every AI call site in the Rewindly backend, as found on **staging and production**, before
this gateway existed.

| Call site                                   | Method                                        | Intent it becomes        |
| ------------------------------------------- | --------------------------------------------- | ------------------------ |
| `apps/api/src/jobs/steps.ts:317`            | `llm.completeStructured` (`classify`)         | `classify`               |
| `apps/api/src/jobs/steps.ts:354`            | `llm.completeStructured` (`extract`)          | `extract`                |
| `apps/api/src/routes.ts:889`, `chat.ts:108` | `llm.completeStructured` (`query_understand`) | `query_understand`       |
| `apps/api/src/chat.ts:528`                  | `llm.converse` (tool loop)                    | `chat`                   |
| `apps/api/src/routes.ts:1269`, `:1310`      | `llm.stream` (SSE)                            | `chat` — see Assumptions |
| `apps/api/src/jobs/steps.ts:193`            | `transcript.transcribe` (pipeline)            | `transcribe`             |
| `apps/api/src/routes.ts:510`                | `transcript.transcribe` (talk turn)           | `transcribe`             |
| `apps/api/src/jobs/steps.ts:224`            | `vision.describe`                             | `vision_describe`        |
| `apps/api/src/live.ts` `mintLiveSession`    | `POST /v1alpha/auth_tokens`                   | `live_session`           |
| `providers.embedding`                       | mocked; `SEMANTIC_SEARCH_ENABLED=false`       | none — see Assumptions   |

**Existing rotation logic found: none in the backend.** Both staging and production hold
exactly one `LLM_API_KEY` and one `LLM_BASE_URL`. The only key-rotation code in the repo is
`tools/provider-router/router.ts` (`keysFor` / `chainFor` / `withFailover`), a local probe
tool that is never deployed. `apps/api/src/config-store.ts` lets the app overwrite the
single key at runtime from D1; that is configuration, not rotation.

---

## Calling this from another Worker

A Worker on this account **cannot reach the hop by URL**. Cloudflare refuses a
Worker-to-Worker subrequest across the same `workers.dev` zone, and answers
`404, error code: 1042` from the edge — which reads exactly like this gateway missing a
route, not like a platform rule. Use a service binding:

```jsonc
// the caller's wrangler config
"services": [{ "binding": "HOP", "service": "api-hop" }]
```

```ts
await env.HOP.fetch("https://api-hop/v1/invoke", { method: "POST", headers, body });
```

The binding ignores the hostname and routes straight to this Worker, skipping the public
internet. The `Authorization` header still applies, so the gateway key is still required.

Anything that is not a Worker on this account — `curl`, a local `wrangler dev`, a phone —
reaches the URL normally. 1042 is Worker-to-Worker only.

## Domain naming

The requested hostname was `api.hop.rewindly.workers.dev`. **That shape is not achievable
on workers.dev.** A workers.dev address is `<script-name>.<account-subdomain>.workers.dev`,
and the script-name segment is a single DNS label — it cannot contain a dot. So the Worker
is named `api-hop` and deploys at `api-hop.rewindly.workers.dev`.

A dotted hostname like `api.hop.rewindly.<yourdomain>` is a different mechanism entirely:
it needs the apex zone on this Cloudflare account, plus a **Custom Domain** or **Route**
pointed at this Worker in the dashboard. Nothing in `wrangler.jsonc` can produce it.

---

## Credit

Built from **[blue-pen5805/llm-proxy-on-cloudflare-workers](https://github.com/blue-pen5805/llm-proxy-on-cloudflare-workers)**
(MIT). `LICENSE` and its copyright notice are retained unchanged.

### What was kept

- The Cloudflare Workers scaffold: `tsconfig.json`, eslint/prettier config, the CI
  workflow, the vitest Workers pool.
- Google AI Studio knowledge: the base URL, the OpenAI-compatible path, and the auth
  split — `/v1beta/openai` wants `Authorization: Bearer`, native surfaces want
  `x-goog-api-key`. Sending the wrong one is a 401 that reads like a dead key.
- `maskUrl` / `fetch2`. Gemini's native endpoints take the key as a `?key=` parameter, so
  an unmasked sub-request log line puts a live credential into Workers Logs.
- The multi-shape API-key config parsing (single string / comma-separated / JSON array),
  reimplemented in `src/config.ts` with the same semantics.
- Cloudflare AI Gateway, as an **origin swap only** (`src/gemini.ts`). The fork also used
  its universal endpoint to declare a fallback chain across every key at once, which is
  exactly the decision `QuotaBroker` owns — two things choosing the key would make the
  usage counters fiction.

### What was stripped

Every provider adapter and env var except Google AI Studio: OpenAI, Anthropic, Cerebras,
Cohere, DeepSeek, Grok, Groq, Mistral, Perplexity, Azure OpenAI, Vertex AI, Amazon
Bedrock, OpenRouter, Workers AI, HuggingFace, Replicate, Ollama, Cartesia, ElevenLabs —
code, config schema, env vars and docs. Also gone: `CUSTOM_OPENAI_ENDPOINTS`, the
`/key/{index|range}/` path selector, `/v1/chat/completions`, `/v1/models`, every
provider-prefixed passthrough route, the middleware chain that existed to layer them, and
the config-generation scripts that configured them.

### What was rebuilt

`QuotaBroker` (a rewrite, not an extension — the old DO was a 70-line round-robin counter
with no line worth keeping once selection became quota-aware), the `MODEL_QUOTAS` table,
the seven intent adapters, and the `/v1/invoke` endpoint.

---

## Assumptions made

Decisions taken during implementation that the brief did not settle.

1. **Model ids differ from the console's display names, and several had to be corrected.**
   The brief's table was derived from console display names; a mismatch silently 404s.
   Every id was verified against `GET /v1beta/models` and a live call on 2026-08-30.
   Corrections: `gemini-3-flash` → `gemini-3-flash-preview`, `antigravity` →
   `antigravity-preview-05-2026`, `gemini-embedding-1` → `gemini-embedding-001`,
   `gemma-4-26b` → `gemma-4-26b-a4b-it`, `gemma-4-31b` → `gemma-4-31b-it`,
   `gemini-2.5-flash-tts` → `gemini-2.5-flash-preview-tts`, `gemini-3.1-flash-tts` →
   `gemini-3.1-flash-tts-preview`, `gemini-2.5-flash-native-audio-dialog` →
   `gemini-2.5-flash-native-audio-latest`, `gemini-3.5-live-translate` →
   `gemini-3.5-live-translate-preview`.

2. **`gemini-3-flash-live` does not exist; its quota was mapped to
   `gemini-3.1-flash-live-preview`.** That is the only non-native-audio Live model in the
   3.x flash family, and it is the one talk mode is verified against. Without this mapping
   there would be no routable Live model at all.

3. **`gemini-2.5-flash` and `gemini-2.5-flash-lite` are in the quota table but in no
   candidate list.** Both 404 on this account ("no longer available to new users") despite
   being listed by `GET /models`. Routing to them would spend a request to be told no.

4. **`gemini-3.7-flash` is a late candidate only.** It returned 503 on probe. It stays in
   the list because 503 is transient and the retry loop advances past it.

5. **No streaming through `/v1/invoke`.** The response contract is a JSON envelope with a
   usage block, which requires reading the whole response. Of the backend's two
   `llm.stream` call sites, one already accumulates the deltas into a string (so it loses
   nothing), and the other only runs when Rem's tool loop hits its round ceiling without
   settling on an answer — a rare path whose output the backend can chunk locally through
   the `chunkForStream` it already has. Add an SSE variant if that path ever becomes
   common.

6. **No `embed` intent.** The backend's embedding provider is mocked,
   `SEMANTIC_SEARCH_ENABLED` is `false` in both environments, and `runVectorArm()` is
   stubbed. `gemini-embedding-001` and `gemini-embedding-2` carry quota entries so the
   intent is a few lines when Phase 5 lands.

7. **Prompts for `transcribe` and `vision_describe` default here but are
   caller-overridable via `payload.prompt`.** Wording is product logic and belongs to the
   backend; a default is what makes the gateway usable on its own.

8. **A reservation is not released when a request fails for a non-quota reason.** The
   counter over-counts by one. Over-counting a free tier is the safe direction, and
   releasing correctly would mean distinguishing "Google counted this" from "it never
   arrived", which the response does not tell us.

9. **Token estimates before the call are deliberately rough** — 4 chars/token for text, a
   flat 2,000 for media, 4,000 for a Live session. They only gate TPM in the second
   between reserving and reconciling, and every text model here has a 250k/min budget no
   single request approaches. Each is marked with a `ponytail:` comment naming its
   ceiling.

10. **A Live session is charged one minute of audio at admission and never reconciled** —
    the socket bypasses this Worker, so its real usage is unobservable here. This caps
    _concurrency_ (roughly `tpm / 4000` sessions per key), not total talk time.

11. **`markExhausted` blocks a key+model for 60s without asking which limit was hit.** A
    daily exhaustion therefore costs one wasted request per key per minute to rediscover.
    The upgrade path is Google's `RetryInfo` on the 429 body.

12. **Intent ids are `snake_case` and match the backend's existing `task` names**
    (`classify`, `extract`, `query_understand`, `chat`) so the port is a rename, not a
    remapping.

13. **The grounding-tool budget is not tracked.** Map and search grounding carry their own
    daily caps, layered on top of model usage. Nothing here requests grounding; a `TODO`
    in `src/quotas.ts` marks where a counter would plug in.
