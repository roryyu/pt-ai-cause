import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// 隔离官方 SDK、数据库和业务会话，不加载真实凭证、不发网络请求。
const sdk = vi.hoisted(() => ({ runReport: vi.fn(), getMetadata: vi.fn(), construct: vi.fn(), initialize: vi.fn().mockResolvedValue({}), close: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@google-analytics/data", () => ({
  BetaAnalyticsDataClient: class {
    constructor(options: unknown) { sdk.construct(options); }
    initialize = sdk.initialize;
    close = sdk.close;
    runReport = sdk.runReport;
    getMetadata = sdk.getMetadata;
  },
}));
vi.mock("@/lib/env", () => ({ env: { DATABASE_URL: "postgresql://localhost/test?schema=cause" } }));
vi.mock("@/lib/db", () => ({
  prisma: {
    apiQueryCache: { findUnique: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    dataSource: { findUnique: vi.fn(), findMany: vi.fn() },
  },
}));
vi.mock("@/lib/server/auth/session", () => ({ requireBusinessSession: vi.fn().mockResolvedValue({ id: "user_test", role: "admin" }) }));

import { prisma } from "@/lib/db";
import { Ga4ReportSchema, ga4SourceConfig, parseGa4Request, ga4ReportTable } from "@/lib/server/connectors/google-analytics";
import { executeRestRequest, testApiSource, executeGraphQLQuery, type RestRequestInput } from "@/lib/server/connectors/api";
import { cachedRestRequest } from "@/lib/server/connectors/api-cache";
import { createApiSourceTool, externalSourcesSummary, serializeGa4ToolResult } from "@/lib/server/agents/tools";
import { createRunContext } from "@/lib/server/agents/events";
import type { ResolvedDataSource } from "@/lib/server/connectors/datasources";
import { GET, POST } from "@/app/api/v1/datasources/[id]/[action]/route";
import { requireBusinessSession } from "@/lib/server/auth/session";
import { ApiError } from "@/lib/server/api-runtime";

const config = ga4SourceConfig("123456789");
const report = {
  dateRanges: [{ startDate: "2026-11-01", endDate: "2026-11-07" }],
  dimensions: [{ name: "date" }], metrics: [{ name: "activeUsers" }], limit: 100,
};
const input: RestRequestInput = { method: "POST", path: "runReport", body: report };
const source: ResolvedDataSource = { id: "data_source_ga4", name: "GA4", type: "api", builtin: false, apiConfig: config };
const response = {
  dimensionHeaders: [{ name: "date" }], metricHeaders: [{ name: "activeUsers" }],
  rows: [
    { dimensionValues: [{ value: "20261101" }], metricValues: [{ value: "10" }] },
    { dimensionValues: [{ value: "20261102" }], metricValues: [{ value: "12" }] },
  ],
  rowCount: 2,
  metadata: { timeZone: "Asia/Shanghai", currencyCode: "USD", subjectToThresholding: true, dataLossFromOtherRow: true, samplingMetadatas: [{ samplesReadCount: "20", samplingSpaceSize: "100" }] },
  propertyQuota: { tokensPerDay: { consumed: 1, remaining: 199999 } },
};

type CacheRow = { body: string; status: number; contentType: string; elapsedMs: number; expiresAt: Date };
const cache = new Map<string, CacheRow>();

beforeEach(() => {
  vi.clearAllMocks();
  cache.clear();
  sdk.initialize.mockReset().mockResolvedValue({});
  sdk.runReport.mockReset().mockResolvedValue([response]);
  sdk.getMetadata.mockReset().mockResolvedValue([{ dimensions: [{ apiName: "date", uiName: "日期" }], metrics: [{ apiName: "activeUsers", uiName: "活跃用户", description: "去重用户数" }] }]);
  vi.mocked(prisma.apiQueryCache.findUnique).mockReset().mockImplementation(({ where }) => Promise.resolve(cache.get(where.cacheKey!) ?? null) as never);
  vi.mocked(prisma.apiQueryCache.upsert).mockReset().mockImplementation(({ where, create }) => {
    cache.set(where.cacheKey!, create as CacheRow);
    return Promise.resolve(create) as never;
  });
  vi.mocked(prisma.dataSource.findUnique).mockResolvedValue({ id: source.id, name: source.name, type: "api", config, createdAt: new Date() } as never);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("测试禁止未模拟的网络访问")));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("GA4 请求白名单与校验", () => {
  it("非法请求在加载 SDK 前被拦截", async () => {
    await expect(executeRestRequest(config, { method: "POST", path: "deleteProperty" })).rejects.toThrow("仅支持");
    expect(sdk.construct).not.toHaveBeenCalled();
    expect(sdk.runReport).not.toHaveBeenCalled();
  });

  it.each([
    { property: "properties/999" }, { credentials: {} }, { dateRanges: [] },
    { dateRanges: [{ startDate: "2026-02-30", endDate: "2026-03-01" }] },
    { dateRanges: [{ startDate: "2026-03-02", endDate: "2026-03-01" }] },
    { limit: 0 }, { limit: 1001 }, { offset: -1 }, { metrics: [] },
    { metrics: [{ name: "activeUsers" }, { name: "activeUsers" }] },
    { dimensions: Array.from({ length: 10 }, (_, i) => ({ name: `dim${i}` })) },
    { metrics: Array.from({ length: 11 }, (_, i) => ({ name: `metric${i}` })) },
  ])("拒绝越权、无效日期或超限参数：%j", (override) => {
    expect(() => Ga4ReportSchema.parse({ ...report, ...override })).toThrow(z.ZodError);
  });

  it("支持相对日期、事件过滤和排序，原样转交官方 SDK", async () => {
    const body = {
      ...report, dateRanges: [{ startDate: "7daysAgo", endDate: "yesterday" }],
      dimensionFilter: { filter: { fieldName: "eventName", stringFilter: { matchType: "EXACT", value: "purchase" } } },
      orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
    };
    await executeRestRequest(config, { ...input, body });
    expect(sdk.construct).toHaveBeenCalledWith({ scopes: ["https://www.googleapis.com/auth/analytics.readonly"] });
    expect(sdk.runReport).toHaveBeenCalledWith({ ...body, offset: 0, property: "properties/123456789", returnPropertyQuota: true }, { timeout: 15000, retry: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { method: "GET", path: "runReport" }, { method: "POST", path: "https://other.test" },
    { method: "GET", path: "metadata", body: {} },
    { method: "GET", path: "metadata", params: { property: "999" } },
    { ...input, params: { limit: "1" } },
  ] as RestRequestInput[])("拒绝绕过协议边界：%j", (request) => {
    expect(() => parseGa4Request(config, request)).toThrow();
  });

  it("按 UTF-8 字节限制请求体", () => {
    expect(() => parseGa4Request(config, { ...input, body: { extra: "中".repeat(7000) } })).toThrow("20KB");
  });
});

describe("GA4 SDK 报告与数据质量", () => {
  it("保留维度字符串、上游指标与元数据，不二次聚合用户数", async () => {
    const result = await executeRestRequest(config, input);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      columns: ["date", "activeUsers"], rows: [{ date: "20261101", activeUsers: 10 }, { date: "20261102", activeUsers: 12 }],
      rowCount: 2, returnedRows: 2, nextOffset: null, metadata: response.metadata, propertyQuota: response.propertyQuota,
    });
    expect(JSON.stringify(result.body)).toContain("不可跨日期");
    expect(JSON.stringify(result.body)).toContain("隐私阈值");
    expect(JSON.stringify(result.body)).toContain("抽样");
  });

  it("空报告是正常空结果，超出安全整数的数值不丢精度", async () => {
    sdk.runReport.mockResolvedValueOnce([{ rowCount: 0 }]);
    expect((await executeRestRequest(config, input)).body).toMatchObject({ rows: [], rowCount: 0, nextOffset: null });
    sdk.runReport.mockResolvedValueOnce([{ ...response, rows: [{ metricValues: [{ value: "9007199254740993" }] }], rowCount: 1 }]);
    expect((await executeRestRequest(config, input)).body).toMatchObject({ rows: [{ activeUsers: "9007199254740993" }] });
  });

  it("分页与字节截断保持完整行和准确 offset", () => {
    const action = parseGa4Request(config, { ...input, body: { ...report, limit: 1, offset: 4 } });
    if (action.kind !== "report") throw new Error("应为报告请求");
    expect(ga4ReportTable({ ...response, rowCount: 8 }, action, 200000)).toMatchObject({ returnedRows: 1, rowCount: 8, nextOffset: 5, truncated: true });
    const huge = { ...response, rows: [{ dimensionValues: [{ value: "中".repeat(2000) }] }], rowCount: 1 };
    expect(ga4ReportTable(huge, action, 1024)).toMatchObject({ rows: [], nextOffset: null, truncated: true });
  });

  it("metadata 按关键词搜索并保留字段类型", async () => {
    const result = await executeRestRequest(config, { method: "GET", path: "metadata", params: { search: "ACTIVE" } });
    expect(sdk.getMetadata).toHaveBeenCalledWith({ name: "properties/123456789/metadata" }, { timeout: 15000, retry: null });
    expect(result.body).toMatchObject({ fieldCount: 1, fields: [{ kind: "metric", apiName: "activeUsers" }] });
  });

  it("连接测试必须读到实际报告，权限失败不冒充成功", async () => {
    expect(await testApiSource(config)).toMatchObject({ ok: true, kind: "ga4" });
    expect(sdk.runReport).toHaveBeenLastCalledWith(expect.objectContaining({ metrics: [{ name: "activeUsers" }], limit: 1 }), expect.anything());
    sdk.runReport.mockRejectedValueOnce({ code: 7, message: "private_key: test-secret" });
    const denied = await testApiSource(config);
    expect(denied).toMatchObject({ ok: false, kind: "ga4", statusCode: 403 });
    expect(JSON.stringify(denied)).not.toContain("test-secret");
  });

  it.each([[7, 403], [16, 401], [8, 429], [14, 503], [3, 400], [5, 404], [undefined, 400]])("SDK 错误 %s 转结构化状态 %s 并脱敏", async (code, status) => {
    sdk.runReport.mockRejectedValueOnce({ code, message: "test-sensitive-path-and-key" });
    const result = await executeRestRequest(config, input);
    expect(result.status).toBe(status);
    expect(JSON.stringify(result)).not.toContain("test-sensitive");
  });

  it("GA4 拒绝 GraphQL", async () => {
    await expect(executeGraphQLQuery(config, { query: "{ __typename }" })).rejects.toThrow("GA4 不支持 GraphQL");
  });
});

describe("GA4 报告缓存", () => {
  const options = { sourceId: source.id, skipThrottle: true };
  it("相同报告命中缓存；不同指标、日期、属性、数据源和分页彼此隔离", async () => {
    await cachedRestRequest(config, input, options);
    expect(await cachedRestRequest(config, input, options)).toMatchObject({ fromCache: true, cacheState: "fresh" });
    expect(sdk.runReport).toHaveBeenCalledTimes(1);
    for (const body of [
      { ...report, metrics: [{ name: "sessions" }] },
      { ...report, dateRanges: [{ startDate: "2026-10-01", endDate: "2026-10-07" }] },
      { ...report, offset: 1 },
    ]) await cachedRestRequest(config, { ...input, body }, options);
    await cachedRestRequest(ga4SourceConfig("999"), input, options);
    await cachedRestRequest(config, input, { ...options, sourceId: "another-source" });
    expect(sdk.runReport).toHaveBeenCalledTimes(6);
    const keys = vi.mocked(prisma.apiQueryCache.findUnique).mock.calls.map(([args]) => args.where.cacheKey);
    expect(new Set(keys).size).toBe(6);
    const expires = vi.mocked(prisma.apiQueryCache.upsert).mock.calls[0]![0].create.expiresAt as Date;
    expect(expires.getTime() - Date.now()).toBeGreaterThan(290000);
    expect(expires.getTime() - Date.now()).toBeLessThanOrEqual(300000);
  });

  it("非法请求不能通过缓存绕过校验", async () => {
    await expect(cachedRestRequest(config, { ...input, body: { ...report, property: "properties/999" } }, options)).rejects.toThrow();
    expect(prisma.apiQueryCache.findUnique).not.toHaveBeenCalled();
    expect(sdk.runReport).not.toHaveBeenCalled();
  });

  it("过期缓存遇到权限撤销不作为成功结果返回，也不重试", async () => {
    await cachedRestRequest(config, input, options);
    for (const row of cache.values()) row.expiresAt = new Date(0);
    sdk.runReport.mockRejectedValue({ code: 7 });
    expect(await cachedRestRequest(config, input, options)).toMatchObject({ status: 403, fromCache: false, cacheState: "miss" });
    expect(sdk.runReport).toHaveBeenCalledTimes(2);
  });

  it("配额错误有限重试后明确标记 stale", async () => {
    vi.useFakeTimers();
    await cachedRestRequest(config, input, options);
    for (const row of cache.values()) row.expiresAt = new Date(0);
    sdk.runReport.mockRejectedValue({ code: 8 });
    const pending = cachedRestRequest(config, input, options);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ status: 200, fromCache: true, cacheState: "stale" });
    expect(sdk.runReport).toHaveBeenCalledTimes(4);
  });
});

describe("GA4 初始化与操作截止时间", () => {
  it("初始化失败被捕获，下一次请求可重新初始化，报告不在失败客户端上执行", async () => {
    vi.resetModules();
    const { executeGa4Request } = await import("@/lib/server/connectors/google-analytics");
    sdk.initialize.mockRejectedValueOnce(new Error("认证初始化失败：secret"));
    const failed = await executeGa4Request(config, input);
    expect(failed.status).toBe(400);
    expect(JSON.stringify(failed)).not.toContain("secret");
    expect(sdk.runReport).not.toHaveBeenCalled();
    expect((await executeGa4Request(config, input)).status).toBe(200);
    expect(sdk.initialize).toHaveBeenCalledTimes(2);
  });

  it("初始化卡住也会结束等待，迟到成功不会启动报告或覆盖新客户端", async () => {
    vi.resetModules();
    const { executeGa4Request } = await import("@/lib/server/connectors/google-analytics");
    vi.useFakeTimers();
    let finish!: (value: object) => void;
    sdk.initialize.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = executeGa4Request(config, input);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toMatchObject({ status: 504, retryable: false, body: { code: "QUERY_TIMEOUT" } });
    expect(sdk.runReport).not.toHaveBeenCalled();
    expect((await executeGa4Request(config, input)).status).toBe(200);
    finish({});
    await vi.advanceTimersByTimeAsync(0);
    expect(sdk.close).toHaveBeenCalled();
    expect(sdk.runReport).toHaveBeenCalledTimes(1);
    expect((await executeGa4Request(config, input)).status).toBe(200);
    expect(sdk.initialize).toHaveBeenCalledTimes(2);
  });

  it("报告卡住后终止等待，迟到拒绝被消费且不会重试或返回过期缓存", async () => {
    vi.useFakeTimers();
    let reject!: (reason: Error) => void;
    sdk.runReport.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const pending = cachedRestRequest(config, input, { sourceId: source.id, skipThrottle: true });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({ status: 504, retryable: false, fromCache: false });
    reject(new Error("迟到的 SDK 失败"));
    await vi.advanceTimersByTimeAsync(0);
    expect(sdk.runReport).toHaveBeenCalledTimes(1);
    expect(prisma.apiQueryCache.upsert).not.toHaveBeenCalled();
  });
});

describe("GA4 查询路由与 Agent", () => {
  const routeParams = (action: string) => ({ params: Promise.resolve({ id: source.id, action }) });
  it("控制台 POST 查询和 GET 字段目录走同一 SDK", async () => {
    const res = await POST(new Request("http://localhost/api/v1/datasources/test/request", { method: "POST", body: JSON.stringify(input) }), routeParams("request"));
    expect((await res.json()).data.body.rows).toHaveLength(2);
    const metadata = await GET(new Request("http://localhost/api/v1/datasources/test/schema?search=active"), routeParams("schema"));
    expect((await metadata.json()).data.fields).toHaveLength(1);
  });

  it("未登录的请求不能触发 SDK", async () => {
    vi.mocked(requireBusinessSession).mockRejectedValueOnce(new ApiError(401, "UNAUTHORIZED", "需要登录"));
    const res = await POST(new Request("http://localhost/test", { method: "POST", body: JSON.stringify(input) }), routeParams("request"));
    expect(res.status).toBe(401);
    expect(sdk.runReport).not.toHaveBeenCalled();
  });

  it("Agent 按同一工具先查 Adjust 再查 GA4，结果保留来源与缓存标记", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("day,installs\n2026-11-01,3\n", { headers: { "content-type": "text/csv" } }));
    const adjust: ResolvedDataSource = { ...source, id: "data_source_adjust", name: "Adjust", apiConfig: { endpoint: "https://adjust.test/reports-service", protocol: "rest", authType: "none" } };
    const ctx = createRunContext({ questionId: "q1", question: "先查 Adjust，再查 Google", sink: vi.fn() });
    const query = createApiSourceTool(ctx, [adjust, source]);
    const a = JSON.parse(await query.invoke({ sourceId: adjust.id, path: "csv_report" }));
    expect(a.rows).toEqual([{ day: "2026-11-01", installs: 3 }]);
    expect(sdk.runReport).not.toHaveBeenCalled();
    const g = JSON.parse(await query.invoke({ sourceId: source.id, method: "POST", path: "runReport", body: JSON.stringify(report) }));
    expect(g).toMatchObject({ sourceId: source.id, sourceName: "GA4", property: "properties/123456789", cacheState: "miss" });
    expect(g.rows).toHaveLength(2);
    expect(externalSourcesSummary([source])).toContain("GA4");
    expect(query.description).toContain("runReport");
  });

  it("Agent 大结果按完整行截断，JSON 可解析且续页位置正确", () => {
    const body = { rows: Array.from({ length: 100 }, (_, i) => ({ pagePath: `/${i}/${"中".repeat(500)}` })), rowCount: 200, offset: 10, nextOffset: 110, returnedRows: 100, truncated: true };
    const text = serializeGa4ToolResult({ status: 200, body, fromCache: true, cacheState: "stale", truncated: true }, source);
    const result = JSON.parse(text);
    expect(text.length).toBeLessThanOrEqual(20000);
    expect(result.returnedRows).toBe(result.rows.length);
    expect(result.nextOffset).toBe(10 + result.rows.length);
    expect(result.rowCount).toBe(200);
    expect(result.cacheState).toBe("stale");
    expect(body.rows).toHaveLength(100);
  });
});
