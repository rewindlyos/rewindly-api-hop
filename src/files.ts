import type { ApiKey } from "./config";
import { type AiGatewayConfig, callGemini } from "./gemini";
import { INTENTS, videoReadRequest } from "./intents";
import type { QuotaBroker } from "./quota_broker";
import { AppError, BadRequestError } from "./utils/error";
import { fetch2 } from "./utils/helpers";

/**
 * `POST /v1/files/video_read`: a saved video read back as text through
 * Gemini's Files API, for one too big for `/v1/invoke`.
 *
 * `/v1/invoke` carries a video as base64 inside JSON, and Gemini takes at most
 * 20 MB inline -- about a 14 MB video once it is encoded. Here the caller sends
 * the raw bytes instead. They stream through this Worker into a resumable
 * upload without being held in memory, Gemini reads the file by its URI, and
 * the file is deleted once it has been read. The prompt, the generation
 * settings and the parse are `video_read`'s own, so the answer is the envelope
 * `/v1/invoke` gives for that intent.
 *
 * One reserved key does every step. An uploaded file belongs to the project of
 * the key that uploaded it, so only that key can read it, and a refusal partway
 * cannot move to another key without uploading the bytes again.
 */

/**
 * Google's own origin, for every Files API step. The upload is a resumable
 * session on Google's upload endpoint and its bytes go to the session URL
 * Google answers with, so the file steps go to Google directly, and only the
 * read itself takes AI Gateway when that is configured.
 */
const GOOGLE = "https://generativelanguage.googleapis.com";

/** The largest video this route takes, by its declared content-length. */
const MAX_BYTES = 100_000_000;

/**
 * ponytail: only the first ten minutes are read (`end_offset`), and only they
 * are charged; the rest of a longer video is never seen. Read it in segments,
 * one `start_offset`/`end_offset` window per call, if longer videos matter.
 */
const READ_SECONDS = 600;

/**
 * How often Google is asked whether an upload has finished processing, and how
 * long before giving up on it. An object rather than two constants only so the
 * tests can shorten the wait.
 */
export const PROCESSING = { pollMs: 2_000, giveUpMs: 120_000 };

/** What this route reads of a Files API `File`. */
interface GeminiFile {
  name: string;
  uri: string;
  mimeType?: string;
  state?: "STATE_UNSPECIFIED" | "PROCESSING" | "ACTIVE" | "FAILED";
  error?: { message?: string };
}

/** The (key, model) this request reserved, and what every step needs to use it. */
interface Held {
  keyId: string;
  model: string;
  apiKey: string;
  hop: DurableObjectStub<QuotaBroker>;
}

/** What index.ts owns and hands over: the keys, the one broker, AI Gateway's config. */
interface Gateway {
  keys: ApiKey[];
  hop: DurableObjectStub<QuotaBroker>;
  gw: AiGatewayConfig;
}

export async function readVideoFile(
  request: Request,
  ctx: ExecutionContext,
  { keys, hop, gw }: Gateway,
): Promise<Response> {
  const size = declaredSize(request.headers.get("content-length"));
  const mime = videoMime(request.headers.get("content-type"));
  if (!request.body) throw new BadRequestError("the body must be the video's bytes");

  if (keys.length === 0) throw new AppError("no provider keys configured", 503);
  const est = estimate(request.headers.get("x-duration-ms"));
  const ids = keys.map((k) => k.id);
  const reservation = await hop.reserve(ids, INTENTS.video_read.models, est, []);
  if (!reservation) {
    throw new AppError("no capacity for intent video_read on any key or candidate model", 429);
  }
  const { keyId, model } = reservation;
  const apiKey = keys.find((k) => k.id === keyId)?.key as string;
  const held: Held = { keyId, model, apiKey, hop };

  const file = await upload(await startUpload(size, mime, held), request.body, size, held);
  try {
    await untilActive(file, held);
    return await read(file, mime, est, held, gw);
  } finally {
    // Read, refused or given up on, the file is of no further use.
    ctx.waitUntil(forget(file.name, apiKey));
  }
}

/**
 * Required, and checked before anything is spent: an upload session declares
 * its length up front, and a body of unknown length cannot be held to the cap
 * until it has already been sent.
 */
function declaredSize(header: string | null): number {
  if (header === null || !/^\d+$/.test(header)) {
    throw new BadRequestError("content-length is required: the video's size in bytes");
  }
  const size = Number(header);
  if (size < 1) throw new BadRequestError("the video is empty");
  if (size > MAX_BYTES) throw new AppError(`a video is at most ${MAX_BYTES} bytes`, 413);
  return size;
}

/** The video's own type, which Google stores the file as. Parameters are dropped. */
function videoMime(header: string | null): string {
  const mime = (header ?? "").split(";")[0].trim().toLowerCase();
  if (!/^video\/[a-z0-9][a-z0-9.+-]*$/.test(mime)) {
    throw new BadRequestError("content-type must be the video's own video/* type");
  }
  return mime;
}

/**
 * ponytail: ~100 tokens a second, Google's figure for video at low media
 * resolution (a frame a second plus the audio), for the part that is read,
 * and 2,000 for the prompt and the answer. It only gates TPM until the
 * reconcile; a caller that does not know the duration is charged the whole
 * ten minutes, which over-reserves, the safe direction. Ask `countTokens`
 * about the uploaded file if this ever routes to a tight-TPM model.
 */
function estimate(durationMs: string | null): number {
  const seconds =
    durationMs !== null && /^\d+$/.test(durationMs) ? Number(durationMs) / 1000 : READ_SECONDS;
  return Math.ceil(Math.min(seconds, READ_SECONDS) * 100) + 2_000;
}

/**
 * A sub-request that never got an answer -- a dropped connection, a timeout,
 * a body shorter or longer than it said -- is worth trying again later, so it
 * is a 503. Logged here, because the caller is only told which step failed.
 */
async function reach(step: string, call: () => Promise<Response>): Promise<Response> {
  try {
    return await call();
  } catch (err) {
    console.error(`video_read ${step} failed:`, err);
    throw new AppError(`video_read ${step} failed`, 503);
  }
}

/**
 * What an upstream refusal means for the caller. The same at every step,
 * because the same key is behind each one.
 */
async function refusal(res: Response, held: Held): Promise<AppError> {
  // Scrubbed before it is cut, so a key straddling the cut leaves no half of
  // itself behind.
  const body = (await res.text().catch(() => "")).split(held.apiKey).join("[key]");
  const detail = body.slice(0, 600);

  if (res.status === 429 || res.status === 402) {
    // ponytail: a refused key ends the request. The bytes are not uploaded
    // again on another key; the caller's job retries the whole read later.
    // Re-upload on the next reserved key if those retries start running out.
    await held.hop.markExhausted(held.keyId, held.model);
    return new AppError(`${held.keyId}/${held.model}: ${res.status} ${detail}`, 429);
  }
  // Gemini refuses some locations outright. The request is not at fault -- the
  // same video reads from elsewhere -- so the caller is told to come back, not
  // to give up.
  if (res.status === 400 && /User location is not supported|FAILED_PRECONDITION/.test(body)) {
    return new AppError(`Gemini refused this location: ${detail}`, 503);
  }
  if (res.status >= 400 && res.status < 500) return new AppError(detail, res.status);
  return new AppError(`Gemini answered ${res.status}: ${detail}`, 503);
}

/** Opens a resumable upload session. Google answers with the URL the bytes go to. */
async function startUpload(size: number, mime: string, held: Held): Promise<string> {
  const res = await reach("upload start", () =>
    fetch2(`${GOOGLE}/upload/v1beta/files`, {
      method: "POST",
      headers: {
        "x-goog-api-key": held.apiKey,
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(size),
        "X-Goog-Upload-Header-Content-Type": mime,
        "content-type": "application/json",
      },
      body: JSON.stringify({ file: { display_name: "video" } }),
    }),
  );
  if (!res.ok) throw await refusal(res, held);
  const url = res.headers.get("x-goog-upload-url");
  if (!url) throw new AppError("video_read upload start returned no upload URL", 503);
  return url;
}

/**
 * Every byte in one request, then finalize. Piped, never buffered: a 100 MB
 * video held whole would take most of an isolate's 128 MB. `FixedLengthStream`
 * declares the length the upload protocol asks for, and errors if the
 * caller's body is shorter or longer than its content-length said, so a cut-off
 * upload fails here instead of being read as a shorter video.
 */
async function upload(
  url: string,
  body: ReadableStream,
  size: number,
  held: Held,
): Promise<GeminiFile> {
  const res = await reach("upload", () =>
    fetch2(url, {
      method: "POST",
      headers: {
        "X-Goog-Upload-Command": "upload, finalize",
        "X-Goog-Upload-Offset": "0",
        "content-length": String(size),
      },
      body: body.pipeThrough(new FixedLengthStream(size)),
    }),
  );
  if (!res.ok) throw await refusal(res, held);
  const { file } = (await res.json().catch(() => ({}))) as { file?: GeminiFile };
  if (!file?.name || !file.uri) throw new AppError("video_read upload returned no file", 503);
  return file;
}

/**
 * A video is usually still `PROCESSING` when its upload finishes, and Gemini
 * will not read it until it is `ACTIVE`.
 */
async function untilActive(file: GeminiFile, held: Held): Promise<void> {
  const giveUpAt = Date.now() + PROCESSING.giveUpMs;
  let current = file;
  while (current.state !== "ACTIVE") {
    // Google could not decode it. Permanent: the same bytes fail the same way.
    if (current.state === "FAILED") {
      const why = current.error?.message ? `: ${current.error.message}` : "";
      throw new AppError(`Gemini could not process this video${why}`, 422);
    }
    if (Date.now() >= giveUpAt) {
      throw new AppError(`the video was not ready within ${PROCESSING.giveUpMs / 1000} s`, 503);
    }
    await new Promise((resolve) => setTimeout(resolve, PROCESSING.pollMs));
    const res = await reach("status", () =>
      fetch2(`${GOOGLE}/v1beta/${file.name}`, { headers: { "x-goog-api-key": held.apiKey } }),
    );
    if (!res.ok) throw await refusal(res, held);
    current = (await res.json().catch(() => ({}))) as GeminiFile;
  }
}

/** The read itself, on the reserved key, as `video_read` reads an inline video. */
async function read(
  file: GeminiFile,
  mime: string,
  est: number,
  held: Held,
  gw: AiGatewayConfig,
): Promise<Response> {
  const upstream = videoReadRequest(held.model, {
    file_data: { mime_type: file.mimeType ?? mime, file_uri: file.uri },
    video_metadata: { end_offset: `${READ_SECONDS}s` },
  });
  const res = await reach("read", () =>
    callGemini(upstream.path, upstream.body, held.apiKey, gw, upstream.timeoutMs),
  );
  if (!res.ok) throw await refusal(res, held);

  const parsed = INTENTS.video_read.parse((await res.json()) as Record<string, unknown>);
  // Correct the TPM estimate with what was billed, as /v1/invoke does.
  if (parsed.usage.total_tokens > 0) {
    await held.hop.reconcile(held.keyId, held.model, est, parsed.usage.total_tokens);
  }
  return Response.json({
    intent: "video_read",
    model_used: held.model,
    key_id: held.keyId,
    result: parsed.result,
    usage: parsed.usage,
  });
}

/**
 * Best effort, off the answer's path. A file left behind counts against the
 * project's 20 GB of Files storage until Google expires it after 48 hours, so
 * a failed delete is logged -- but it never fails the read.
 */
async function forget(name: string, apiKey: string): Promise<void> {
  try {
    const res = await fetch2(`${GOOGLE}/v1beta/${name}`, {
      method: "DELETE",
      headers: { "x-goog-api-key": apiKey },
    });
    if (!res.ok) console.warn(`video_read could not delete ${name}: ${res.status}`);
  } catch (err) {
    console.warn(`video_read could not delete ${name}:`, err);
  }
}
