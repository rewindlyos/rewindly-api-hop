# rewindly-api-hop

The AI gateway for Rewindly. **One URL, one API key, one endpoint** — for every AI task
the backend performs, whatever kind of task it is. The one exception is a video too big to
send inline, which has a route of its own.

The backend does not choose a model, does not hold a provider key, and does not know
how many keys exist. It names an **intent**; this Worker decides which model and which of
our four free-tier Gemini keys serves it, against live per-key quota counters, and hops to
another when one runs out. The text intents go to Inception's Mercury models first, with
Gemini as their overflow — see [Inception](#inception).

Deployed at **`https://api-hop.rewindly.workers.dev`**, placed in **`gcp:us-central1`** rather
than next to its caller: Gemini refuses some Cloudflare egress locations with `400
FAILED_PRECONDITION` _"User location is not supported"_ (SIN was refused on 2026-10-28), and
the hint covers the service binding's `fetch` the Rewindly API calls it through.

```bash
curl -X POST https://api-hop.rewindly.workers.dev/v1/invoke \
  -H "Authorization: Bearer $HOP_GATEWAY_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"intent":"classify","payload":{"messages":[{"role":"user","content":"..."}]}}'
```

---

## Public surface

| Route                       | Auth                                          | What it does                                                                             |
| --------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `POST /v1/invoke`           | `Authorization: Bearer <HOP_GATEWAY_API_KEY>` | Every task, named by its intent.                                                         |
| `POST /v1/files/video_read` | same bearer                                   | A video too big to send inline, as raw bytes — see [video_read, from a file](#examples). |
| `GET /health`               | none                                          | Liveness, plus the list of implemented intents.                                          |
| `GET /debug/usage`          | same bearer                                   | Current per-key, per-model counters and limits.                                          |

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

### Streaming (`chat` only)

Add `"stream": true` to the request and `chat` answers as server-sent events instead of
one JSON body. Everything before the first byte is unchanged: auth, the reservation,
the retry walk across keys and models, and the `400` / `429` JSON errors. Only a `200`
from Gemini becomes a stream.

```
event: delta
data: {"content":"You saved three "}

event: delta
data: {"content":"ramen places."}

event: done
data: {"intent":"chat","model_used":"gemini-3.5-flash-lite","key_id":"key-2","result":{"content":"You saved three ramen places.","tool_calls":[],"finish_reason":"stop"},"usage":{"prompt_tokens":34,"completion_tokens":7,"total_tokens":41}}
```

`done` carries the same envelope the JSON path returns. Tool calls are not streamed:
they arrive in pieces and are assembled into `done`'s `result.tool_calls`, thought
signature included. Usage arrives with Gemini's last chunk, so the TPM reconcile happens
when the stream ends, just before `done`. A stream Gemini breaks off ends with
`event: error` (`{"message":"upstream stream failed","status":502}`) and no `done`; treat
a stream without `done` as failed. Any other intent with `"stream": true` is a `400`.
Callers that do not send `stream` get the JSON envelope exactly as before.

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

The Inception keys that serve the text intents and `decide`. Unset, the text intents start
at Gemini and `decide` has no capacity (same shapes as `GEMINI_API_KEYS`; ids are stored as `inception-<id>`):

```bash
npx wrangler secret put INCEPTION_API_KEYS
# [{"id":"acct-1","key":"sk_..."},{"id":"acct-2","key":"sk_..."}]
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

| Intent             | What it does                                | Models, in order                                                                                                                                     |
| ------------------ | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `classify`         | Types a save and files it into a collection | `mercury-3` → `mercury-2.5` → `gemini-3.5-flash-lite` → `gemini-3.1-flash-lite` → `gemini-3.6-flash` → `gemini-3.5-flash` → `gemini-3-flash-preview` |
| `extract`          | Pulls typed fields out of a save            | same ladder                                                                                                                                          |
| `query_understand` | Expands a search query before retrieval     | same ladder                                                                                                                                          |
| `decide`           | Typed questions answered as probabilities   | `mercury-decide`                                                                                                                                     |
| `chat`             | Rem's tool-calling turn                     | same ladder                                                                                                                                          |
| `transcribe`       | Speech in, text out                         | `gemini-3.1-flash-lite` → `gemini-3.5-flash-lite`                                                                                                    |
| `vision_describe`  | Reads an image back as text                 | `gemini-3.5-flash-lite` → `gemini-3.1-flash-lite`                                                                                                    |
| `document_read`    | Reads a whole PDF back as text, tables too  | `gemini-3.5-flash-lite` → `gemini-3.1-flash-lite`                                                                                                    |
| `video_read`       | Reads a saved video back as text            | `gemini-3.5-flash-lite` → `gemini-3.1-flash-lite`                                                                                                    |
| `live_session`     | Mints a Live API session                    | `gemini-3.1-flash-live-preview`                                                                                                                      |

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

**chat, streamed** — the same request plus `"stream": true`; `-N` so curl prints each
event as it lands:

```bash
curl -N -X POST $HOP/v1/invoke -H "$AUTH" -H "$JSON" -d '{
  "intent": "chat", "stream": true,
  "payload": {"messages":[{"role":"user","content":"What did I save about ramen?"}]}
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

**document_read** — a PDF inline, on the native `generateContent` surface (the
OpenAI-compatible one refuses PDFs). Tables come back one row per line:

```bash
curl -X POST $HOP/v1/invoke -H "$AUTH" -H "$JSON" -d "{
  \"intent\": \"document_read\",
  \"payload\": {\"document_base64\": \"$(base64 -i timetable.pdf)\", \"mime\": \"application/pdf\"}
}"
# -> {"result": {"text": "Monday · 08:45-09:40 · Deep Learning Lab · Room L-1\n..."}}
```

**video_read** — a video from the phone, inline on the same surface, read at low media
resolution: what it shows, what is said and what is on screen. The caller keeps it under
the 20 MB inline request (about 14 MB of video once base64-encoded):

```bash
curl -X POST $HOP/v1/invoke -H "$AUTH" -H "$JSON" -d "{
  \"intent\": \"video_read\",
  \"payload\": {\"video_base64\": \"$(base64 -i clip.mp4)\", \"mime\": \"video/mp4\"}
}"
# -> {"result": {"text": "A walk along Juhu beach at sunset..."}}
```

**video_read, from a file** — a bigger video, up to 100 MB, goes to its own route as raw
bytes. They are piped, never buffered, into a Gemini Files API upload on one reserved key;
Gemini reads the file there with `video_read`'s own prompt and settings, and the hop deletes
it afterwards (`src/files.ts`). A video is read to its own end, or to ten minutes if it runs
longer. While Google processes the upload the hop looks again after 2, 2, 3, 5 and 8 s, then
every 10 s, and the last look starts at two minutes, never after (each look, like the upload's
start and the delete, is cut off at 15 s); the looks are capped so that a read, delete included,
stays inside Workers Free's 50 subrequests. `content-length` is required; `x-duration-ms` is
optional and only sizes the token estimate:

```bash
curl -X POST $HOP/v1/files/video_read -H "$AUTH" \
  -H 'content-type: video/mp4' -H 'x-duration-ms: 95000' \
  --data-binary @clip.mp4
# -> the same envelope /v1/invoke answers video_read with
```

Errors: `400` no content-length or not `video/*`; `413` over 100,000,000 bytes; `422` Google
could not process the file (permanent); `429` no capacity, or the reserved key was refused
for quota — that pair leaves rotation for a minute and the bytes are not uploaded again on
another key; `503` Gemini refused this location, Google failed (`5xx`) or could not be
reached, or the file was not ready within 120 s, all worth retrying. Any other `4xx` from
Google passes through with its status.

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

### Inception

`mercury-3` and `mercury-2.5` lead the four text intents' ladder, and the Gemini 3.x models
are their overflow. Inception's API is OpenAI-compatible, so the same request goes to
`api.inceptionlabs.ai/v1/chat/completions` with a Bearer key (`src/inception.ts`); strict
`json_schema`, tools and SSE all work unchanged. Two differences are handled here: Mercury
resets a temperature outside 0.5–1 to 1, so the hop clamps it, and a spent token credit
answers **402**, which is treated like a 429.

Mercury runs at its default reasoning effort (`low` on `mercury-3`). `instant` was measured on
2026-10-28 for `classify` and `extract` (8 saves, 2 runs, Rewindly's production prompts): twice
as fast and 21% fewer tokens, but 3 of 16 classifications broke the schema's array limits on
long articles and documents, and 2 of 8 saves came back in the wrong language or script. Not
adopted.

`decide` sends `state` and `questions` to `mercury-decide` on `/v1/decisions` verbatim and
returns `answers`: `noul` probabilities, `choice`, `score`, `extract` spans. Only input
tokens are billed. A 413 or 422 from it is the caller's request, like a 400.

A key only ever serves its own provider's models (`quotaFor` in `src/quotas.ts`). Mercury
is text-only, so `transcribe`, `vision_describe`, `document_read`, `video_read` and
`live_session` stay on Gemini.

**Inception trains on API inputs unless told not to.** Before setting `INCEPTION_API_KEYS`,
turn off "Improve the model for everyone" under User Settings on every account whose key
goes in.

---

## The audit

Every AI call site in the Rewindly backend, as found on **staging and production**, before
this gateway existed.

| Call site                                   | Method                                        | Intent it becomes      |
| ------------------------------------------- | --------------------------------------------- | ---------------------- |
| `apps/api/src/jobs/steps.ts:317`            | `llm.completeStructured` (`classify`)         | `classify`             |
| `apps/api/src/jobs/steps.ts:354`            | `llm.completeStructured` (`extract`)          | `extract`              |
| `apps/api/src/routes.ts:889`, `chat.ts:108` | `llm.completeStructured` (`query_understand`) | `query_understand`     |
| `apps/api/src/chat.ts:528`                  | `llm.converse` (tool loop)                    | `chat`                 |
| `apps/api/src/routes.ts:1269`, `:1310`      | `llm.stream` (SSE)                            | `chat`, streamed       |
| `apps/api/src/jobs/steps.ts:193`            | `transcript.transcribe` (pipeline)            | `transcribe`           |
| `apps/api/src/routes.ts:510`                | `transcript.transcribe` (talk turn)           | `transcribe`           |
| `apps/api/src/jobs/steps.ts:224`            | `vision.describe`                             | `vision_describe`      |
| `apps/api/src/live.ts` `mintLiveSession`    | `POST /v1alpha/auth_tokens`                   | `live_session`         |
| `providers.embedding`                       | mocked; `SEMANTIC_SEARCH_ENABLED=false`       | none — see Assumptions |

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

5. **Streaming is `chat` only, and opt-in.** It was left out at first because the
   envelope's usage block needs the whole response. It came back when Rem's answers had
   to arrive as they are generated: the `done` event carries the same envelope, usage
   included, once the stream ends. The other intents feed the pipeline, where nobody
   watches the output arrive, so they stay JSON.

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
