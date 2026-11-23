import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";

// 只替换外部依赖；保留真实 supervisor、worker、ReAct/ToolNode、连接器和任务落库流程。
const mocks = vi.hoisted(() => ({
  ads: vi.fn(), ga4: vi.fn(), getChatModel: vi.fn(), sources: vi.fn(),
  mode: "empty" as string | number, protocol: "google_ads", workerFails: false,
  toolResults: [] as Array<Record<string, unknown>>, synthesis: "",
  prisma: {
    user: { findUnique: vi.fn(), create: vi.fn() },
    question: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    researchTask: { createMany: vi.fn() },
    apiQueryCache: { findUnique: vi.fn(), update: vi.fn(), upsert: vi.fn() },
  },
}));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma, Prisma: {} }));
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("google-auth-library", () => ({ GoogleAuth: class {
  getClient = async () => ({});
  request = mocks.ads;
} }));
vi.mock("@google-analytics/data", () => ({ BetaAnalyticsDataClient: class {
  initialize = async () => ({});
  close = async () => {};
  runReport = mocks.ga4;
} }));
vi.mock("@/lib/server/connectors/deadline", async (original) => ({
  ...await original<typeof import("@/lib/server/connectors/deadline")>(),
  GOOGLE_INITIALIZATION_TIMEOUT_MS: 100,
  GOOGLE_OPERATION_TIMEOUT_MS: 300,
  GOOGLE_QUERY_TIMEOUT_MS: 400,
  CACHE_OPERATION_TIMEOUT_MS: 50,
}));
vi.mock("@/lib/server/connectors/datasources", async (original) => ({
  ...await original<typeof import("@/lib/server/connectors/datasources")>(),
  listDataSources: mocks.sources,
}));
vi.mock("@/lib/server/agents/tools", async (original) => ({
  ...await original<typeof import("@/lib/server/agents/tools")>(),
  runtimeRunOperatorToolDescription: async () => "测试算子",
  runtimeTablesHint: async () => "测试数据字典",
}));
vi.mock("@/lib/server/model-gateway", () => ({
  getChatModel: mocks.getChatModel,
  getDefaultModel: () => "isolated-test-model",
  chatCompletion: async () => JSON.stringify({ route: "data_analysis" }),
  chatCompletionStream: async function* (messages: Array<{ content: string }>) {
    mocks.synthesis = messages[1]!.content;
    yield mocks.synthesis;
  },
  withModelRequestSignal: (_signal: AbortSignal, run: () => Promise<unknown>) => run(),
}));
vi.mock("@/lib/server/agents/conversation", () => ({
  buildConversationContext: async () => ({ history: [], prevSummary: "" }),
  compressConversationContext: async () => "隔离测试摘要",
}));
vi.mock("@/lib/server/auth/session", () => ({ requireBusinessSession: async () => ({ id: "test", name: "测试", email: "test@example.test", role: "admin" }) }));
vi.mock("@/lib/server/agents/deep-research", () => ({ runDeepResearch: vi.fn() }));
vi.mock("@/lib/server/research-graph/store", () => ({ loadGraph: vi.fn() }));
vi.mock("@/lib/server/research-graph/query", () => ({ queryGraph: vi.fn() }));

import { runAskTask } from "../mcp/tasks";
import { POST } from "@/app/api/v1/ask/route";
import { createApiSourceTool } from "@/lib/server/agents/tools";
import { createRunContext } from "@/lib/server/agents/events";
import { googleAdsSourceConfig } from "@/lib/server/connectors/google-ads";
import { ga4SourceConfig } from "@/lib/server/connectors/google-analytics";
import type { ResolvedDataSource } from "@/lib/server/connectors/datasources";

let sources: ResolvedDataSource[];
let runId = 0;
const report = { dateRanges: [{ startDate: "2026-11-01", endDate: "2026-11-02" }], metrics: [{ name: "activeUsers" }] };
const actor = { id: "test", name: "测试", email: "test@example.test", role: "admin" as const };
const googleArgs = () => ({ sourceId: sources[1]!.id, method: "POST" as const, path: mocks.mode === "invalid" ? "invalid" : mocks.protocol === "ga4" ? "runReport" : "campaigns", body: JSON.stringify(mocks.protocol === "ga4" ? report : {}) });

class ScriptedChatModel extends BaseChatModel {
  constructor() { super({}); }
  _llmType() { return "scripted-test"; }
  override bindTools() { return this; }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const results = messages.filter((message) => message.type === "tool");
    if (results.length) {
      mocks.toolResults = results.map((message) => JSON.parse(String(message.content)));
      if (mocks.workerFails) throw new Error("模拟 worker 后续模型中断");
      return { generations: [{ text: "数据查询结束", message: new AIMessage("数据查询结束") }] };
    }
    return { generations: [{ text: "", message: new AIMessage({ content: "", tool_calls: [
      { id: "adjust-call", name: "query_api_source", args: { sourceId: sources[0]!.id, path: "csv_report" } },
      { id: "google-call", name: "query_api_source", args: googleArgs() },
    ] }) }] };
  }
  override async *_streamResponseChunks(messages: BaseMessage[]) {
    const result = await this._generate(messages);
    const message = result.generations[0]!.message as AIMessage;
    yield new ChatGenerationChunk({ text: String(message.content), message: new AIMessageChunk({ content: message.content, tool_calls: message.tool_calls }) });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  runId++;
  mocks.mode = "empty";
  mocks.protocol = "google_ads";
  mocks.workerFails = false;
  mocks.toolResults = [];
  mocks.synthesis = "";
  sources = [
    { id: `adjust-${runId}`, name: "Adjust", type: "api", builtin: false, apiConfig: { endpoint: "https://adjust.test/reports-service", protocol: "rest", authType: "none" } },
    { id: `google-${runId}`, name: "Google", type: "api", builtin: false, apiConfig: googleAdsSourceConfig("1234567890") },
  ];
  mocks.sources.mockImplementation(async () => sources.map((source) => ({ ...source, status: "active" })));
  mocks.getChatModel.mockImplementation(() => new ScriptedChatModel());
  mocks.prisma.user.findUnique.mockResolvedValue({ id: "test" });
  mocks.prisma.question.create.mockResolvedValue({});
  mocks.prisma.question.update.mockResolvedValue({});
  mocks.prisma.researchTask.createMany.mockResolvedValue({ count: 1 });
  mocks.prisma.apiQueryCache.findUnique.mockResolvedValue(null);
  mocks.prisma.apiQueryCache.upsert.mockResolvedValue({});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (!String(url).startsWith("https://adjust.test/")) throw new Error("测试禁止其他网络请求");
    return new Response("day,installs\n2026-11-01,3\n", { headers: { "content-type": "text/csv" } });
  }));
  const failOrEmpty = () => {
    if (mocks.mode === "hang") return new Promise<never>(() => {});
    if (mocks.mode === "throw") throw new Error("secret 模拟 SDK 异常");
    if (typeof mocks.mode === "number") throw { code: mocks.mode, response: { status: mocks.mode, data: { error: { status: "PERMISSION_DENIED" } } } };
    return null;
  };
  mocks.ads.mockImplementation(async ({ data }: { data?: { query?: string } }) => {
    await failOrEmpty();
    return { data: { results: data?.query?.includes("FROM customer LIMIT") ? [{ customer: { id: "1234567890", manager: false } }] : [] } };
  });
  mocks.ga4.mockImplementation(async () => { await failOrEmpty(); return [{ rows: [], rowCount: 0 }]; });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const cases = ["empty", 401, 403, 429, 503, "throw", "hang", "invalid"] as const;
for (const protocol of ["google_ads", "ga4"] as const) {
  describe(`${protocol} 混合故障贯穿真实 ask 工作流`, () => {
    it.each(cases)("MCP：Google %s，Adjust 成功，最终仍 completed", async (mode) => {
      mocks.mode = mode;
      mocks.protocol = protocol;
      if (protocol === "ga4") sources[1]!.apiConfig = ga4SourceConfig("123456789");
      const result = await runAskTask({ question: "分别查询 Adjust 和 Google" }, actor);
      expect(result.status).toBe("completed");
      expect(mocks.toolResults).toHaveLength(2);
      expect(mocks.toolResults.find((row) => row.sourceName === "Adjust")).toMatchObject({ outcome: "success", rows: [{ installs: 3 }] });
      expect(mocks.toolResults.find((row) => row.sourceName === "Google")).toMatchObject({ outcome: mode === "empty" ? "empty" : "unavailable" });
      expect(result.answer).toContain('"installs":3');
      expect(result.answer).toContain('"sourceName":"Google"');
      expect(result.answer).not.toContain("secret");
      expect(mocks.prisma.question.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "completed" }) }));
      expect(mocks.prisma.question.update.mock.calls.some(([args]) => args.data.status === "failed")).toBe(false);
    });
  });
}

describe("入口与部分证据保留", () => {
  it.each(["empty", 403, "hang"])("网页 SSE：Google %s 后仍产生 done 并落库 completed", async (mode) => {
    mocks.mode = mode;
    mocks.protocol = "google_ads";
    const response = await POST(new Request("http://localhost/api/v1/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "分别查询 Adjust 和 Google" }) }));
    expect(response.status).toBe(200);
    const events = await response.text();
    expect(events).toContain('"type":"done"');
    expect(events).not.toContain('"type":"error"');
    expect(mocks.synthesis).toContain('"installs":3');
    expect(mocks.prisma.question.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "completed" }) }));
  });

  it("worker 在工具完成后中断，综合节点仍获得已完成数据及缺失原因", async () => {
    mocks.mode = 403;
    mocks.protocol = "google_ads";
    mocks.workerFails = true;
    const result = await runAskTask({ question: "查询两个数据源" }, actor);
    expect(result.status).toBe("completed");
    expect(mocks.synthesis).toContain("数据分析执行失败");
    expect(mocks.synthesis).toContain('"installs":3');
    expect(mocks.synthesis).toContain('"outcome":"unavailable"');
  });

  it.each(["empty", 403])("相同 Google %s 请求不反复打上游，保留预算查询 Adjust", async (mode) => {
    mocks.mode = mode;
    mocks.protocol = "google_ads";
    const ctx = createRunContext({ questionId: "q", question: "查询", sink: () => {} });
    const query = createApiSourceTool(ctx, sources);
    const first = await query.invoke(googleArgs());
    const count = mocks.ads.mock.calls.length;
    for (let i = 0; i < 8; i++) expect(await query.invoke(googleArgs())).toBe(first);
    expect(mocks.ads).toHaveBeenCalledTimes(count);
    const adjust = JSON.parse(await query.invoke({ sourceId: sources[0]!.id, path: "csv_report" }));
    expect(adjust.rows[0].installs).toBe(3);
    expect(ctx.apiQueryResults).toHaveLength(2);
  });

  it("数据源不存在仍返回非致命结果，之后可以继续其他源", async () => {
    const ctx = createRunContext({ questionId: "q", question: "查询", sink: () => {} });
    const query = createApiSourceTool(ctx, sources);
    const missing = JSON.parse(await query.invoke({ sourceId: "missing" }));
    expect(missing).toMatchObject({ outcome: "unavailable", nonFatal: true });
    const adjust = JSON.parse(await query.invoke({ sourceId: sources[0]!.id, path: "csv_report" }));
    expect(adjust.outcome).toBe("success");
  });

  it("所有数据源不可用仍完成问答，将缺失原因交给综合而不是补零", async () => {
    mocks.mode = 403;
    vi.mocked(fetch).mockRejectedValue(new Error("Adjust 网络不可用"));
    const result = await runAskTask({ question: "查询两个数据源" }, actor);
    expect(result.status).toBe("completed");
    expect(mocks.toolResults).toHaveLength(2);
    expect(mocks.toolResults.every((row) => row.outcome === "unavailable" && row.nonFatal)).toBe(true);
    expect(mocks.synthesis).toContain("Adjust 网络不可用");
    expect(mocks.synthesis).toContain("Google Ads 拒绝访问");
    expect(mocks.synthesis).not.toContain('"installs":0');
  });

  it("Adjust 失败时仍保留 Google 的成功数据", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("Adjust 网络不可用"));
    mocks.ads.mockImplementation(async ({ data }: { data?: { query?: string } }) => ({ data: { results: data?.query?.includes("FROM customer LIMIT")
      ? [{ customer: { id: "1234567890", manager: false } }]
      : [{ campaign: { id: "42", name: "可用活动", status: "ENABLED" } }] } }));
    const result = await runAskTask({ question: "查询两个数据源" }, actor);
    expect(result.status).toBe("completed");
    expect(mocks.toolResults.find((row) => row.sourceName === "Google")).toMatchObject({ outcome: "success", rows: [{ id: "42" }] });
    expect(mocks.synthesis).toContain("可用活动");
    expect(mocks.synthesis).toContain("Adjust 网络不可用");
  });
});

describe("输出裁剪与可用性标记", () => {
  it.each([{ body: [] }, { body: null }, { body: { rows: [] } }])("REST 空 JSON 结果 $body 不冒充零值", async ({ body }) => {
    vi.mocked(fetch).mockResolvedValue(Response.json(body));
    const ctx = createRunContext({ questionId: "q", question: "查询", sink: () => {} });
    const result = JSON.parse(await createApiSourceTool(ctx, sources).invoke({ sourceId: sources[0]!.id }));
    expect(result).toMatchObject({ outcome: "empty", body });
    expect(result.hint).toContain("不等于指标为零");
  });

  it.each(["rows", "metadata"])("超长 %s 保持合法、有界 JSON，并保留部分结果标记", async (kind) => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ id: i, name: "x".repeat(240) }));
    vi.mocked(fetch).mockResolvedValue(Response.json(kind === "rows" ? { rows } : { metadata: "x".repeat(30_000) }));
    const ctx = createRunContext({ questionId: "q", question: "查询", sink: () => {} });
    const output = await createApiSourceTool(ctx, sources).invoke({ sourceId: sources[0]!.id });
    const result = JSON.parse(output);
    expect(output.length).toBeLessThanOrEqual(20_000);
    expect(result).toMatchObject({ outcome: "partial", snapshotTruncated: true });
    expect(ctx.apiQueryResults[0]!.length).toBeLessThanOrEqual(6_000);
    if (kind === "rows") {
      expect(result.body.rows.length).toBeGreaterThan(0);
      expect(result.body.rows).toEqual(rows.slice(0, result.snapshotReturnedRows));
    }
  });

  it("CSV 大结果按完整行保留，不因原始 JSON 字符截断丢掉整次结果", async () => {
    const csv = "id,name\n" + Array.from({ length: 150 }, (_, i) => `${i},${"x".repeat(180)}`).join("\n");
    vi.mocked(fetch).mockResolvedValue(new Response(csv, { headers: { "content-type": "text/csv" } }));
    const ctx = createRunContext({ questionId: "q", question: "查询", sink: () => {} });
    const result = JSON.parse(await createApiSourceTool(ctx, sources).invoke({ sourceId: sources[0]!.id }));
    expect(result).toMatchObject({ outcome: "partial", snapshotTruncated: true });
    expect(result.rows[0]).toEqual({ id: 0, name: "x".repeat(180) });
    expect(result.rows.length).toBe(result.snapshotReturnedRows);
  });

  it("只裁剪综合快照时不修改原工具结果，快照数量有上限", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: i, name: "x".repeat(200) }));
    vi.mocked(fetch).mockImplementation(async () => Response.json({ rows }));
    const ctx = createRunContext({ questionId: "q", question: "查询", sink: () => {} });
    const query = createApiSourceTool(ctx, sources);
    const result = JSON.parse(await query.invoke({ sourceId: sources[0]!.id }));
    expect(result).toMatchObject({ outcome: "success", body: { rows } });
    const snapshot = JSON.parse(ctx.apiQueryResults[0]!);
    expect(snapshot).toMatchObject({ outcome: "partial", snapshotTruncated: true });
    expect(snapshot.body.rows.length).toBeLessThan(rows.length);
    for (let i = 0; i < 8; i++) await query.invoke({ sourceId: `missing-${i}` });
    expect(ctx.apiQueryResults).toHaveLength(6);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("过期 Adjust 缓存可降级使用，但必须显式标为 partial/stale", async () => {
    mocks.prisma.apiQueryCache.findUnique.mockResolvedValue({ body: "day,installs\n2026-11-01,3\n", status: 200, contentType: "text/csv", elapsedMs: 1, expiresAt: new Date(0) });
    vi.mocked(fetch).mockRejectedValue(new Error("网络不可用"));
    const ctx = createRunContext({ questionId: "q", question: "查询", sink: () => {} });
    const result = JSON.parse(await createApiSourceTool(ctx, sources).invoke({ sourceId: sources[0]!.id }));
    expect(result).toMatchObject({ outcome: "partial", cacheState: "stale", rows: [{ installs: 3 }] });
  });

  it.each([null, { installs: 3 }])("GraphQL 错误与数据 %j 区分不可用和部分成功", async (data) => {
    sources[0]!.apiConfig!.protocol = "graphql";
    vi.mocked(fetch).mockResolvedValue(Response.json({ data, errors: [{ message: "部分字段不可访问" }] }));
    const ctx = createRunContext({ questionId: "q", question: "查询", sink: () => {} });
    const result = JSON.parse(await createApiSourceTool(ctx, sources).invoke({ sourceId: sources[0]!.id, graphqlQuery: "{ installs }" }));
    expect(result).toMatchObject({ data, outcome: data === null ? "unavailable" : "partial" });
  });
});
