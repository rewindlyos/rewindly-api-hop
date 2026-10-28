import { fetch2 } from "./utils/helpers";

/**
 * Inception's Mercury models: diffusion LLMs behind an OpenAI-compatible
 * surface at `api.inceptionlabs.ai/v1`. Text in, text or JSON out, with tools,
 * strict `json_schema` and SSE -- the same wire shape the chat-shaped intents
 * already send Gemini, so only the path and the auth header change.
 *
 * Not reached through Cloudflare AI Gateway: it has no Inception provider, and
 * the logging that buys is not worth a custom-provider setup for an overflow.
 */
const ORIGIN = "https://api.inceptionlabs.ai";

export const isInceptionModel = (model: string): boolean => model.startsWith("mercury");

/**
 * Ids from `INCEPTION_API_KEYS` are stored under this prefix, so they can never
 * collide with a Gemini `key-1` and the broker can tell whose key it holds.
 */
export const INCEPTION_KEY_PREFIX = "inception-";
export const isInceptionKey = (keyId: string): boolean =>
  keyId.startsWith(INCEPTION_KEY_PREFIX);

export async function callInception(
  path: string,
  body: unknown,
  apiKey: string,
  timeoutMs = 120_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch2(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
