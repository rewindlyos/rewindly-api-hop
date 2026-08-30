/**
 * Kept from blue-pen5805/llm-proxy-on-cloudflare-workers.
 *
 * Every upstream call is logged with its URL, and Gemini's native endpoints
 * take the key as a `?key=` query parameter — so an unmasked log line puts a
 * live provider credential into Workers Logs, where it is readable by anyone
 * with dashboard access and retained for days.
 */
const SENSITIVE_PARAMS = [
  "apikey",
  "api_key",
  "api-key",
  "key",
  "token",
  "access_token",
  "accesstoken",
  "auth",
  "authorization",
  "password",
  "secret",
];

export function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    if (!u.search) return u.toString();

    const masked = new URLSearchParams();
    for (const [k, v] of new URLSearchParams(u.search)) {
      if (!SENSITIVE_PARAMS.includes(k.toLowerCase()) || v.length === 0) {
        masked.set(k, v);
      } else {
        // A prefix is kept on long values so a log line can still tell two
        // keys apart, which is the whole point of logging the URL at all.
        masked.set(k, v.length > 10 ? `${v.slice(0, 3)}***` : "***");
      }
    }
    u.search = masked.toString();
    return u.toString();
  } catch {
    return url.split("?")[0] + (url.includes("?") ? "?***" : "");
  }
}

/** `fetch`, with the sub-request logged and its credentials masked. */
export const fetch2: typeof fetch = async (input, init) => {
  console.info(`Sub-Request: ${init?.method ?? "GET"} ${maskUrl(input.toString())}`);
  return fetch(input, init);
};
