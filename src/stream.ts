import { readUsage, type Usage } from "./intents";

/**
 * The `chat` intent as a stream: Gemini's OpenAI-compatible SSE in, this
 * gateway's own SSE out. Asked for with `"stream": true` on `/v1/invoke`.
 *
 *   event: delta   data: {"content":"..."}       text, as Gemini sends it
 *   event: done    data: {intent, model_used, key_id, result, usage, retries?}
 *   event: error   data: {"message":"...","status":502}
 *
 * `done` carries the same envelope the JSON path answers with, so a caller
 * reads `result.tool_calls` and `usage` from one place either way. Tool calls
 * are not streamed: they arrive in pieces (arguments split across chunks, the
 * thought_signature on the first) and are only worth anything whole.
 *
 * Usage is handed to `onEnd` once, after Gemini's last chunk and before `done`,
 * because only the last chunk has it -- the reconcile the JSON path does at
 * once happens here when the stream ends. A stream that stops without a finish
 * reason ends with `error` and no reconcile: the reservation stands, which
 * over-counts by one, the safe direction (README, assumption 8).
 */

interface ToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
  extra_content?: unknown;
}

interface Chunk {
  choices?: Array<{
    delta?: { content?: string | null; tool_calls?: ToolCallDelta[]; extra_content?: unknown };
    finish_reason?: string | null;
  }>;
  usage?: unknown;
  error?: { message?: string };
}

interface ToolCall {
  id?: string;
  type: string;
  function: { name: string; arguments: string };
  extra_content?: unknown;
}

/** Gemini's `data:` payloads, one per line, until `[DONE]` or the body ends. */
async function* chunks(reader: ReadableStreamDefaultReader<string>): AsyncGenerator<Chunk> {
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        yield JSON.parse(data) as Chunk;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function relayChatStream(
  upstream: ReadableStream<Uint8Array>,
  head: { intent: string; model_used: string; key_id: string; retries?: string[] },
  onEnd: (usage: Usage) => Promise<void>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const frame = (event: string, data: unknown) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const reader = upstream.pipeThrough(new TextDecoderStream()).getReader();

  return new ReadableStream({
    async start(controller) {
      let content = "";
      let extraContent: unknown;
      let finishReason: string | null = null;
      let usage: Usage | null = null;
      const calls: ToolCall[] = [];
      try {
        for await (const chunk of chunks(reader)) {
          if (chunk.error) throw new Error(chunk.error.message ?? "upstream error");
          if (chunk.usage) usage = readUsage(chunk as Record<string, unknown>);
          const choice = chunk.choices?.[0];
          const d = choice?.delta;
          finishReason = choice?.finish_reason ?? finishReason;
          if (d?.extra_content !== undefined) extraContent = d.extra_content;
          for (const t of d?.tool_calls ?? []) {
            const call = (calls[t.index ?? calls.length] ??= {
              type: "function",
              function: { name: "", arguments: "" },
            });
            call.id ??= t.id;
            call.function.name ||= t.function?.name ?? "";
            call.function.arguments += t.function?.arguments ?? "";
            if (t.extra_content !== undefined) call.extra_content = t.extra_content;
          }
          if (d?.content) {
            content += d.content;
            controller.enqueue(frame("delta", { content: d.content }));
          }
        }
        if (!finishReason) throw new Error("upstream stream ended before it finished");

        const final = usage ?? readUsage({});
        await onEnd(final);
        controller.enqueue(
          frame("done", {
            ...head,
            result: {
              content,
              tool_calls: calls.filter(Boolean),
              ...(extraContent === undefined ? {} : { extra_content: extraContent }),
              finish_reason: finishReason,
            },
            usage: final,
          }),
        );
      } catch (err) {
        // Never the raw upstream body: it can echo a key back (see index.ts).
        console.error("chat stream failed:", err);
        controller.enqueue(frame("error", { message: "upstream stream failed", status: 502 }));
      }
      controller.close();
    },
    cancel() {
      // The caller went away: cancel Gemini's body too, rather than read a
      // whole answer for no one.
      return reader.cancel().catch(() => {});
    },
  });
}
