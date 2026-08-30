/**
 * Reading the two secrets this Worker has.
 */

export interface ApiKey {
  id: string;
  key: string;
}

/**
 * `GEMINI_API_KEYS`, in any of the four shapes the fork's environment parser
 * accepted, because the shape is not the interesting part:
 *
 *   [{ "id": "key-1", "key": "AIza..." }, ...]   the documented form
 *   ["AIza...", "AIza..."]                        ids become key-1, key-2, ...
 *   "AIza...,AIza..."                             comma-separated
 *   "AIza..."                                     one key
 *
 * Adding a fifth key is a new entry in the secret and a redeploy. No code here
 * counts keys, and nothing downstream does either -- the broker takes whatever
 * list it is handed.
 *
 * Ids matter: they are what `/debug/usage` reports and what the usage counters
 * are keyed by, so an id that moves between deploys silently resets that key's
 * quota bookkeeping. Give every key a stable explicit id.
 */
export function parseApiKeys(raw: string | undefined): ApiKey[] {
  if (!raw) return [];

  const trimmed = raw.trim();
  let parsed: unknown = trimmed;

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Falls through to the comma-separated reading below, which is what a
      // truncated paste of a JSON array most resembles.
    }
  }

  const list: unknown[] = Array.isArray(parsed)
    ? parsed
    : String(parsed)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

  const out: ApiKey[] = [];
  for (const entry of list) {
    if (typeof entry === "string" && entry) {
      out.push({ id: `key-${out.length + 1}`, key: entry });
    } else if (entry && typeof entry === "object") {
      const { id, key } = entry as { id?: unknown; key?: unknown };
      if (typeof key === "string" && key) {
        out.push({ id: typeof id === "string" && id ? id : `key-${out.length + 1}`, key });
      }
    }
  }

  // A duplicate id would make two keys share one set of counters, so the
  // broker would believe it had half the capacity it has and spend it twice.
  const seen = new Set<string>();
  return out.filter((k) => !seen.has(k.id) && seen.add(k.id));
}

/**
 * Compares in time independent of how much of the token matched.
 *
 * The gateway key is high-entropy and this is a network boundary, so the
 * timing channel is not a realistic attack -- but it is six lines, and this is
 * the check standing between the open internet and four live provider
 * credentials.
 */
export function tokenMatches(presented: string, expected: string): boolean {
  const a = new TextEncoder().encode(presented);
  const b = new TextEncoder().encode(expected);
  // Length is not secret; comparing unequal lengths byte-wise is what leaks.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** The bearer token on the request, or null. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}
