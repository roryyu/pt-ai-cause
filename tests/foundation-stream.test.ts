import { beforeEach, it, expect, vi } from "vitest";
vi.mock("@/lib/env", () => ({ env: { MODEL_GATEWAY_BASE_URL: "https://foundation.test/openai/v1", MODEL_GATEWAY_API_KEY: "isolated-agent-fixture", MODEL_GATEWAY_DEFAULT_MODEL: "openai/gpt-5.6-sol", MODEL_GATEWAY_TIMEOUT_MS: 1000 } }));
import { chatCompletionStream, chatCompletion, getChatModel, withModelRequestSignal } from "@/lib/server/model-gateway";
beforeEach(() => vi.restoreAllMocks());
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\r\n\r\n`;
const completed = frame({ type: "response.completed", response: { status: "completed" } });
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
it.each(["response.failed", "response.incomplete", "error", "missing-terminal"])("does not retry %s after partial output", async type => {
  const tail = type === "missing-terminal" ? "" : frame({ type, error: { code: "denied" } });
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(response(frame({ type: "response.output_text.delta", delta: "partial" }) + tail));
  const generator = chatCompletionStream([{ role: "user", content: "test" }]);
  expect((await generator.next()).value).toBe("partial");
  await expect(generator.next()).rejects.toThrow(type === "missing-terminal" ? "terminal" : "denied");
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
