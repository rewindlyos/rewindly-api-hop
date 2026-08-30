import { fetch2 } from "./utils/helpers";

/**
 * The one upstream this gateway talks to.
 *
 * Two auth schemes, and the split is not cosmetic -- it is the detail carried
 * over from the fork's Google AI Studio adapter. The OpenAI-compatible surface
 * under `/v1beta/openai` wants `Authorization: Bearer`; every native surface
 * (`/v1alpha/auth_tokens`, `generateContent`) wants `x-goog-api-key`. Sending
 * the wrong one is a 401 that reads like a dead key.
 */
const ORIGIN = "https://generativelanguage.googleapis.com";

export interface AiGatewayConfig {
  accountId?: string;
  name?: string;
  token?: string;
}

/**
 * Cloudflare AI Gateway, when configured: same paths, different origin, free
 * request logging and analytics. Opt-in -- unset the vars and every call goes
 * straight to Google.
 *
 * Kept as an origin swap only. The fork also used AI Gateway's universal
 * endpoint to declare a fallback chain across every key at once, and that is
 * precisely the decision `QuotaBroker` exists to own; two things choosing the
 * key would make the usage counters fiction.
 */
export function geminiOrigin(gw: AiGatewayConfig): string {
  return gw.accountId && gw.name
    ? `https://gateway.ai.cloudflare.com/v1/${gw.accountId}/${gw.name}/google-ai-studio`
    : ORIGIN;
}

export async function callGemini(
  path: string,
  body: unknown,
  apiKey: string,
  gw: AiGatewayConfig,
  timeoutMs = 120_000,
): Promise<Response> {
  const openaiCompat = path.startsWith("/v1beta/openai");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch2(`${geminiOrigin(gw)}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(openaiCompat
          ? { authorization: `Bearer ${apiKey}` }
          : { "x-goog-api-key": apiKey }),
        ...(gw.token ? { "cf-aig-authorization": `Bearer ${gw.token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The Live API socket address.
 *
 * Built here rather than by the caller, for the same reason the Rewindly
 * backend used to build it rather than the phone: Google has renamed the host,
 * the API version and the RPC method at least once each, and the address
 * belongs on the side that redeploys in a minute.
 *
 * `BidiGenerateContentConstrained`, not `BidiGenerateContent`. An ephemeral
 * token is rejected by the latter with `1008 Method doesn't allow unregistered
 * callers`, which sounds like a credential problem and is a method problem.
 */
export function liveSocketUrl(tokenName: string): string {
  const host = "generativelanguage.googleapis.com";
  return (
    `wss://${host}/ws/google.ai.generativelanguage.v1alpha.GenerativeService` +
    `.BidiGenerateContentConstrained?access_token=${encodeURIComponent(tokenName)}`
  );
}
