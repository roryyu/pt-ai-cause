import { beforeEach, it, expect, vi } from "vitest";
const mockEnv = vi.hoisted(() => ({ MODEL_GATEWAY_BASE_URL: "https://foundation.test/openai/v1", MODEL_GATEWAY_API_KEY: "isolated-agent-fixture", MODEL_GATEWAY_DEFAULT_MODEL: "openai/gpt-5.6-sol", MODEL_GATEWAY_TIMEOUT_MS: 1000 }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
import { chatCompletionStream, chatCompletion, getChatModel, withModelRequestSignal } from "@/lib/server/model-gateway";
beforeEach(() => { vi.restoreAllMocks(); mockEnv.MODEL_GATEWAY_DEFAULT_MODEL = "openai/gpt-5.6-sol"; mockEnv.MODEL_GATEWAY_BASE_URL = "https://foundation.test/openai/v1"; });
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\r\n\r\n`;
const completed = frame({ type: "response.completed", response: { status: "completed" } });
const tokenLimited = frame({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } });
const response = (data: string | ReadableStream) => new Response(data, { headers: { "content-type": "text/event-stream" } });
it("yields each native text delta before completion, across UTF-8 and CRLF boundaries", async () => {
  let output!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { output = c; } });
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(response(stream));
  const generator = chatCompletionStream([{ role: "system", content: "Guide" }, { role: "user", content: "test" }], { temperature: 0.3 });
  const first = generator.next();
  const bytes = new TextEncoder().encode(frame({ type: "response.output_text.delta", delta: "你好" }));
  // Split inside a multibyte character, then between CR and LF.
  const split = bytes.findIndex(x => x > 127) + 1;
  output.enqueue(bytes.subarray(0, split)); output.enqueue(bytes.subarray(split, bytes.length - 1)); output.enqueue(bytes.subarray(-1));
  expect(await first).toEqual({ done: false, value: "你好" });
  output.enqueue(new TextEncoder().encode(frame({ type: "response.output_text.delta", delta: "，世界" })));
  expect(await generator.next()).toEqual({ done: false, value: "，世界" });
  output.enqueue(new TextEncoder().encode(completed)); output.close();
  expect((await generator.next()).done).toBe(true);
  expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://foundation.test/openai/v1/responses");
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ model: "openai/gpt-5.6-sol", input: [{ role: "system", content: "Guide" }, { role: "user", content: "test" }], reasoning: { effort: "low" }, max_output_tokens: 4096, stream: true, store: false });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each(["response.failed", "response.incomplete", "error", "missing-terminal", "max_output_tokens"])("does not retry %s after partial output", async type => {
  const tail = type === "missing-terminal" ? "" : type === "max_output_tokens" ? tokenLimited : frame({ type, error: { code: "denied" } });
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(response(frame({ type: "response.output_text.delta", delta: "partial" }) + tail));
  const generator = chatCompletionStream([{ role: "user", content: "test" }]);
  expect((await generator.next()).value).toBe("partial");
  const reason = type === "missing-terminal" ? "terminal" : type === "max_output_tokens" ? "max_output_tokens" : "denied";
  await expect(generator.next()).rejects.toThrow(reason);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("uses low effort and no unsupported sampling in unary and LangChain tool calls", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "answer" } }] }), { headers: { "content-type": "application/json" } }));
  expect(await chatCompletion([{ role: "user", content: "test" }], { temperature: 0 })).toBe("answer");
  const params = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(params).toMatchObject({ model: "openai/gpt-5.6-sol", reasoning_effort: "low" });
  expect(params.temperature).toBeUndefined();
  const toolParams = getChatModel({ temperature: 0 }).invocationParams({});
  expect("reasoning" in toolParams && toolParams.reasoning).toEqual({ effort: "low" }); expect(toolParams.temperature).toBeUndefined();
});
it("propagates cancellation to Foundation without starting a retry", async () => {
  const controller = new AbortController();
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    controller.abort(); init?.signal?.throwIfAborted(); return response(completed);
  });
  await expect(withModelRequestSignal(controller.signal, async () => {
    for await (const delta of chatCompletionStream([{ role: "user", content: "test" }])) void delta;
  })).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("does not start a buffered retry after cancellation", async () => {
  const controller = new AbortController();
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
    controller.abort();
    return response(tokenLimited);
  });
  await expect(withModelRequestSignal(controller.signal, async () => {
    for await (const delta of chatCompletionStream([{ role: "user", content: "test" }], { bufferOutput: true })) void delta;
  })).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("buffers a token-limited attempt and retries with a larger output budget", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(response(frame({ type: "response.output_text.delta", delta: "discarded" }) + tokenLimited))
    .mockResolvedValueOnce(response(frame({ type: "response.output_text.delta", delta: "complete" }) + completed));
  const chunks: string[] = [];
  for await (const chunk of chatCompletionStream([{ role: "user", content: "test" }], { maxTokens: 4096, bufferOutput: true })) chunks.push(chunk);
  expect(chunks).toEqual(["complete"]);
  expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).max_output_tokens)).toEqual([4096, 8192]);
});
it("stops buffered token-limit retries at the output budget ceiling", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => response(tokenLimited));
  await expect((async () => {
    for await (const delta of chatCompletionStream([{ role: "user", content: "test" }], { maxTokens: 8192, bufferOutput: true })) void delta;
  })()).rejects.toThrow("Foundation generation failed (max_output_tokens)");
  expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).max_output_tokens)).toEqual([8192, 16384, 32768]);
});

// ─── Claude（Bedrock 路由）：原生 Anthropic /anthropic/v1/messages，不走 OpenAI Responses ───
const CLAUDE = "anthropic/claude-sonnet-5";
const anthropicDelta = (text: string) => frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
const anthropicStop = frame({ type: "message_delta", delta: { stop_reason: "end_turn" } }) + frame({ type: "message_stop" });
const anthropicTokenLimited = frame({ type: "message_delta", delta: { stop_reason: "max_tokens" } });
it("routes Claude unary calls to Anthropic messages without reasoning params", async () => {
  mockEnv.MODEL_GATEWAY_DEFAULT_MODEL = CLAUDE;
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ content: [{ type: "text", text: "answer" }] }), { headers: { "content-type": "application/json" } }));
  expect(await chatCompletion([{ role: "system", content: "Guide" }, { role: "user", content: "test" }], { temperature: 0 })).toBe("answer");
  expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://foundation.test/anthropic/v1/messages");
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(body).toEqual({ model: CLAUDE, system: "Guide", messages: [{ role: "user", content: "test" }], max_tokens: 4096, temperature: 0 });
});
it("streams Claude text deltas from Anthropic SSE until message_stop", async () => {
  mockEnv.MODEL_GATEWAY_DEFAULT_MODEL = CLAUDE;
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(response(anthropicDelta("你好") + anthropicDelta("，世界") + anthropicStop));
  const chunks: string[] = [];
  for await (const chunk of chatCompletionStream([{ role: "system", content: "Guide" }, { role: "user", content: "test" }])) chunks.push(chunk);
  expect(chunks).toEqual(["你好", "，世界"]);
  expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://foundation.test/anthropic/v1/messages");
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ model: CLAUDE, system: "Guide", messages: [{ role: "user", content: "test" }], max_tokens: 4096, stream: true });
});
it("retries Claude token-limited buffered output with a larger max_tokens", async () => {
  mockEnv.MODEL_GATEWAY_DEFAULT_MODEL = CLAUDE;
  const fetcher = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(response(anthropicDelta("discarded") + anthropicTokenLimited))
    .mockResolvedValueOnce(response(anthropicDelta("complete") + anthropicStop));
  const chunks: string[] = [];
  for await (const chunk of chatCompletionStream([{ role: "user", content: "test" }], { maxTokens: 4096, bufferOutput: true })) chunks.push(chunk);
  expect(chunks).toEqual(["complete"]);
  expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).max_tokens)).toEqual([4096, 8192]);
});
it("fails Claude streams on error events without retry", async () => {
  mockEnv.MODEL_GATEWAY_DEFAULT_MODEL = CLAUDE;
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(response(anthropicDelta("partial") + frame({ type: "error", error: { type: "overloaded_error" } })));
  const generator = chatCompletionStream([{ role: "user", content: "test" }]);
  expect((await generator.next()).value).toBe("partial");
  await expect(generator.next()).rejects.toThrow("overloaded_error");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("uses ChatAnthropic for Claude tool calls", () => {
  mockEnv.MODEL_GATEWAY_DEFAULT_MODEL = CLAUDE;
  const params = getChatModel({ temperature: 0 }).invocationParams({});
  expect(params.model).toBe(CLAUDE);
  expect("reasoning" in params).toBe(false);
});
it("derives the Anthropic route from the gateway origin regardless of OpenAI path prefix", async () => {
  mockEnv.MODEL_GATEWAY_DEFAULT_MODEL = CLAUDE;
  mockEnv.MODEL_GATEWAY_BASE_URL = "https://ai-foundation.pmdevops.com/api/gateway/v1";
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(response(anthropicDelta("ok") + anthropicStop));
  for await (const delta of chatCompletionStream([{ role: "user", content: "test" }])) void delta;
  expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://ai-foundation.pmdevops.com/anthropic/v1/messages");
});
