import { AsyncLocalStorage } from "node:async_hooks";
import OpenAI from "openai";
import { ChatOpenAI } from "@langchain/openai";
import { env } from "@/lib/env";

// Cause's approved model policy: Foundation-managed GPT-5.6 Sol, low effort.
// The route alias and Agent credential remain operator-owned configuration.
const requestSignal = new AsyncLocalStorage<AbortSignal>();
export function withModelRequestSignal<T>(signal: AbortSignal, operation: () => T): T {
  return requestSignal.run(signal, operation);
}
const gatewayFetch: typeof fetch = (input, init) => {
  const signals = [init?.signal, requestSignal.getStore(), AbortSignal.timeout(env.MODEL_GATEWAY_TIMEOUT_MS)]
    .filter((signal): signal is AbortSignal => !!signal);
  return fetch(input, { ...init, signal: AbortSignal.any(signals), redirect: "error" });
};
export function activeGateway() {
  return { name: "primary" as const, baseURL: env.MODEL_GATEWAY_BASE_URL, apiKey: env.MODEL_GATEWAY_API_KEY, model: env.MODEL_GATEWAY_DEFAULT_MODEL };
}
export function getDefaultModel() { return env.MODEL_GATEWAY_DEFAULT_MODEL; }
let client: OpenAI | undefined;
function getClient() {
  client ??= new OpenAI({ baseURL: env.MODEL_GATEWAY_BASE_URL, apiKey: env.MODEL_GATEWAY_API_KEY,
    timeout: env.MODEL_GATEWAY_TIMEOUT_MS, maxRetries: 0, fetch: gatewayFetch });
  return client;
}
// Retain callers' legacy temperature option without forwarding unsupported sampling to Sol.
type Options = { model?: string; temperature?: number; maxTokens?: number };
type StreamOptions = Options & {
  /** 缓冲完整正文后再输出，使预算耗尽重试不会重复下发已生成内容。 */
  bufferOutput?: boolean;
};

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_STREAM_MAX_TOKENS_LIMIT = 32768;

class FoundationOutputTokenLimitError extends Error {
  constructor() {
    super("Foundation generation failed (max_output_tokens)");
    this.name = "FoundationOutputTokenLimitError";
  }
}

export async function chatCompletion(messages: OpenAI.ChatCompletionMessageParam[], options?: Options): Promise<string> {
  const response = await getClient().chat.completions.create({
    model: options?.model ?? getDefaultModel(), messages, reasoning_effort: "low", max_tokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
  });
  return response.choices[0]?.message.content ?? "";
}

async function* streamOnce(
  input: Array<{ role: string; content: string }>,
  options: StreamOptions | undefined,
  maxTokens: number,
): AsyncGenerator<string> {
  const base = env.MODEL_GATEWAY_BASE_URL.replace(/\/$/, "");
  const response = await gatewayFetch(`${base}/responses`, {
    method: "POST", headers: { authorization: `Bearer ${env.MODEL_GATEWAY_API_KEY}`, "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ model: options?.model ?? getDefaultModel(), input, reasoning: { effort: "low" }, max_output_tokens: maxTokens, stream: true, store: false }),
  });
  if (!response.ok || !response.body) throw new Error(`Foundation request failed (HTTP ${response.status})`);
  if (!response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("Foundation did not return a native event stream");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let frameBuffer = "", completed = false, output = "";
  function parse(frame: string): string | null {
    const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return null;
    const event = JSON.parse(data) as { type?: string; delta?: unknown; error?: { code?: string }; response?: { status?: string; error?: { code?: string }; incomplete_details?: { reason?: string } } };
    if (event.type === "response.incomplete" && event.response?.incomplete_details?.reason === "max_output_tokens") {
      throw new FoundationOutputTokenLimitError();
    }
    if (["error", "response.failed", "response.incomplete"].includes(event.type ?? "")) {
      const reason = event.error?.code ?? event.response?.error?.code ?? event.response?.incomplete_details?.reason ?? event.type;
      throw new Error(`Foundation generation failed (${reason})`);
    }
    if (event.type === "response.completed") {
      if (event.response?.status !== "completed") throw new Error("Foundation terminal response is invalid");
      completed = true;
    }
    if (event.type !== "response.output_text.delta") return null;
    if (typeof event.delta !== "string") throw new Error("Foundation text delta is invalid");
    return event.delta;
  }
  try {
    while (!completed) {
      const chunk = await reader.read();
      frameBuffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      frameBuffer = frameBuffer.replaceAll("\r\n", "\n");
      if (frameBuffer.length > 1_000_000) throw new Error("Foundation stream frame exceeds the size limit");
      let boundary: number;
      while ((boundary = frameBuffer.indexOf("\n\n")) >= 0) {
        const delta = parse(frameBuffer.slice(0, boundary));
        frameBuffer = frameBuffer.slice(boundary + 2);
        if (delta !== null) {
          if (options?.bufferOutput) output += delta;
          else yield delta;
        }
        if (completed) break;
      }
      if (chunk.done) break;
    }
    if (!completed) throw new Error("Foundation stream ended without a successful terminal event");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (options?.bufferOutput && output) yield output;
}

/**
 * Web SSE 默认逐段转发；MCP 等同步消费方开启 bufferOutput 后，
 * 仅对 max_output_tokens 终态做有上限扩容，未拿到完整成功结果前不输出任何正文。
 */
export async function* chatCompletionStream(messages: OpenAI.ChatCompletionMessageParam[], options?: StreamOptions): AsyncGenerator<string> {
  // These text-generation callers do not contain tool transcripts or multimodal messages.
  const input = messages.map(message => {
    if (!["system", "developer", "user", "assistant"].includes(message.role) || typeof message.content !== "string" || ("tool_calls" in message && message.tool_calls?.length)) {
      throw new Error("Cause streaming requires text messages; tool conversations use the tool adapter");
    }
    return { role: message.role, content: message.content };
  });
  const initialMaxTokens = Math.max(1, Math.trunc(options?.maxTokens ?? DEFAULT_MAX_TOKENS));
  const maxTokensLimit = Math.max(initialMaxTokens, DEFAULT_STREAM_MAX_TOKENS_LIMIT);
  let maxTokens = initialMaxTokens;
  while (true) {
    try {
      yield* streamOnce(input, options, maxTokens);
      return;
    } catch (error) {
      if (!options?.bufferOutput || !(error instanceof FoundationOutputTokenLimitError) || maxTokens >= maxTokensLimit) throw error;
      requestSignal.getStore()?.throwIfAborted();
      maxTokens = Math.min(maxTokens * 2, maxTokensLimit);
    }
  }
}
export function getChatModel(options?: { temperature?: number; maxTokens?: number; streaming?: boolean }): ChatOpenAI {
  if (options?.streaming) throw new Error("Use chatCompletionStream for native Foundation Responses streaming");
  return new ChatOpenAI({ model: getDefaultModel(), apiKey: env.MODEL_GATEWAY_API_KEY,
    configuration: { baseURL: env.MODEL_GATEWAY_BASE_URL, timeout: env.MODEL_GATEWAY_TIMEOUT_MS, fetch: gatewayFetch },
    // LangChain only recognizes bare provider names as reasoning models. Foundation
    // aliases include a namespace, so set the native wire parameter explicitly.
    useResponsesApi: true, modelKwargs: { store: false, reasoning: { effort: "low" } },
    maxTokens: options?.maxTokens ?? 4096, streaming: false, maxRetries: 0 });
}
export async function gatewayHealth(): Promise<{ active: string; model: string; ok: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    // Discovery is read-only and does not create a paid inference.
    await getClient().models.list();
    return { active: "primary", model: getDefaultModel(), ok: true, latencyMs: Date.now() - start };
  } catch (error) {
    return { active: "primary", model: getDefaultModel(), ok: false, latencyMs: Date.now() - start, error: error instanceof Error ? error.message : "Gateway unavailable" };
  }
}
