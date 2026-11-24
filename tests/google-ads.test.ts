import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ request: vi.fn(), construct: vi.fn(), getClient: vi.fn().mockResolvedValue({}) }));
vi.mock("google-auth-library", () => ({ GoogleAuth: class {
  constructor(options: unknown) { sdk.construct(options); }
  request = sdk.request;
  getClient = sdk.getClient;
} }));
vi.mock("@/lib/env", () => ({ env: { DATABASE_URL: "postgresql://localhost/test?schema=cause" } }));
vi.mock("@/lib/db", () => ({ prisma: {
  apiQueryCache: { findUnique: vi.fn(), update: vi.fn(), upsert: vi.fn() },
  dataSource: { findUnique: vi.fn(), findMany: vi.fn() },
} }));
vi.mock("@/lib/server/auth/session", () => ({ requireBusinessSession: vi.fn().mockResolvedValue({ id: "test", role: "admin" }) }));

import { prisma } from "@/lib/db";
import { executeRestRequest, executeGraphQLQuery, testApiSource, type RestRequestInput } from "@/lib/server/connectors/api";
import { googleAdsSourceConfig, parseGoogleAdsRequest, googleAdsError, serializeGoogleAdsResult } from "@/lib/server/connectors/google-ads";
import { cachedRestRequest } from "@/lib/server/connectors/api-cache";
import { createApiSourceTool, externalSourcesSummary } from "@/lib/server/agents/tools";
import { createRunContext } from "@/lib/server/agents/events";
import { POST } from "@/app/api/v1/datasources/[id]/[action]/route";
import { requireBusinessSession } from "@/lib/server/auth/session";
import { ApiError } from "@/lib/server/api-runtime";

const cid = "1234567890";
const manager = "9876543210";
const config = googleAdsSourceConfig(cid);
const source = { id: "ads-test", name: "Google Ads", type: "api" as const, builtin: false, apiConfig: config };
const installAction = `customers/${cid}/conversionActions/7`;
const report = { campaignId: "42", startDate: "2026-11-01", endDate: "2026-11-02", installAction };
const account = { id: cid, descriptiveName: "示例", manager: false, currencyCode: "USD", timeZone: "Asia/Shanghai" };
const daily = [
  { campaign: { id: "42", name: "示例活动", status: "PAUSED" }, segments: { date: "2026-11-01" }, metrics: { impressions: "100", clicks: "5", ctr: 0.05, costMicros: "12000000" } },
  { campaign: { id: "42", name: "示例活动", status: "PAUSED" }, segments: { date: "2026-11-02" }, metrics: { impressions: "200", clicks: "20", ctr: 0.1, costMicros: "20000000" } },
];
type CacheRow = { body: string; status: number; contentType: string; elapsedMs: number; expiresAt: Date };
const cache = new Map<string, CacheRow>();
const request = (path: string, body: unknown = {}): RestRequestInput => ({ method: "POST", path, body });
function mockRequest({ url, data }: { url: string; data?: { query: string } }) {
  const q = data?.query ?? "";
  if (url.endsWith("customers:listAccessibleCustomers")) return { data: { resourceNames: [`customers/${cid}`, `customers/${manager}`] } };
  if (q.includes("FROM customer LIMIT")) return { data: { results: [{ customer: account }] } };
  if (q.includes("FROM conversion_action")) return { data: { results: [{ conversionAction: { id: "7", resourceName: installAction, name: "安装", type: "GOOGLE_PLAY_DOWNLOAD", status: "ENABLED" } }] } };
  if (q.includes("metrics.all_conversions")) return { data: { results: [{ segments: { date: "2026-11-01" }, metrics: { allConversions: 3 } }] } };
  if (q.includes("metrics.impressions")) return { data: { results: daily } };
  if (q.includes("FROM campaign")) return { data: { results: daily.map((r) => ({ campaign: r.campaign })) } };
  if (q.includes("FROM customer_client")) return { data: { results: [{ customerClient: { id: cid, manager: false, descriptiveName: "子账户" } }] } };
  throw new Error("测试未覆盖的请求");
}
beforeEach(() => {
  vi.clearAllMocks(); cache.clear();
  sdk.getClient.mockReset().mockResolvedValue({});
  sdk.request.mockReset().mockImplementation(async (options) => mockRequest(options));
  vi.mocked(prisma.apiQueryCache.findUnique).mockReset().mockImplementation(({ where }) => Promise.resolve(cache.get(where.cacheKey!) ?? null) as never);
  vi.mocked(prisma.apiQueryCache.upsert).mockReset().mockImplementation(({ where, create }) => {
    cache.set(where.cacheKey!, create as CacheRow); return Promise.resolve(create) as never;
  });
  vi.mocked(prisma.dataSource.findUnique).mockResolvedValue({ id: source.id, name: source.name, type: "api", config, createdAt: new Date() } as never);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("禁止未模拟的网络请求")));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Google Ads 受限只读模板", () => {
  it.each([
    request("mutate"), request("https://evil.example"), request("campaigns", { query: "SELECT *" }),
    request("campaigns", { customerId: "123 OR 1=1" }), request("campaigns", { credentials: {} }),
    request("campaigns", { limit: 101 }), request("campaigns", { offset: 1 }),
    request("report", { ...report, campaignId: "1; DROP" }),
    request("report", { ...report, startDate: "2026-02-30" }),
    request("report", { ...report, endDate: "2026-10-31" }),
    request("report", { ...report, endDate: "2028-01-01" }),
    request("report", { ...report, installAction: "purchase" }),
    { method: "GET", path: "accounts" },
    { ...request("accounts"), params: { token: "test" } },
  ] as RestRequestInput[])("非法请求不会触发 SDK：%j", async (input) => {
    await expect(executeRestRequest(config, input)).rejects.toThrow();
    expect(sdk.request).not.toHaveBeenCalled();
  });
  it("配置不能覆盖官方主机或认证", () => {
    for (const override of [{ endpoint: "https://evil.test" }, { authToken: "test" }, { headers: { authorization: "test" } }]) {
      expect(() => parseGoogleAdsRequest({ ...config, ...override }, request("accounts"))).toThrow();
    }
  });
  it("没有客户 ID 仍能发现账户，使用 adwords scope 且不发送经理头", async () => {
    const result = await executeRestRequest(googleAdsSourceConfig(undefined, manager), request("accounts", { limit: 1 }));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ rows: [{ id: cid }], nextAfterId: cid });
    expect(sdk.construct).toHaveBeenCalledWith(expect.objectContaining({ scopes: ["https://www.googleapis.com/auth/adwords"] }));
    expect(sdk.request).toHaveBeenCalledWith(expect.objectContaining({ method: "GET", headers: {}, retry: false, timeout: 15000 }));
  });
  it("账户 ID 可以覆盖，经理 ID 可以显式清空", () => {
    expect(parseGoogleAdsRequest(googleAdsSourceConfig(cid, manager), request("campaigns", { customerId: manager, loginCustomerId: "" })))
      .toMatchObject({ customerId: manager, loginCustomerId: undefined });
  });
  it("GraphQL 不能绕过只读模板", async () => {
    await expect(executeGraphQLQuery(config, { query: "{ campaign }" })).rejects.toThrow("不支持");
    expect(sdk.request).not.toHaveBeenCalled();
  });
});

describe("账户、campaign 与安装报告", () => {
  it("campaign 列表不依赖指标或日期，分页使用 ID", async () => {
    const result = await executeRestRequest(googleAdsSourceConfig(cid, manager), request("campaigns", { afterId: "40", limit: 1 }));
    expect(result.body).toMatchObject({ nextAfterId: "42", rows: [{ id: "42", name: "示例活动", status: "PAUSED" }] });
    const call = sdk.request.mock.calls.at(-1)![0];
    expect(call.data.query).toContain("campaign.id > 40");
    expect(call.data.query).not.toContain("metrics.");
    expect(call.headers).toEqual({ "login-customer-id": manager });
  });
  it("经理账户能列子账户但不能查投放报告", async () => {
    sdk.request.mockImplementation(async (opts) => opts.data?.query.includes("FROM customer LIMIT") ? { data: { results: [{ customer: { ...account, manager: true } }] } } : mockRequest(opts));
    expect((await executeRestRequest(config, request("clients"))).body).toMatchObject({ rows: [{ id: cid, manager: false }] });
    expect((await executeRestRequest(config, request("report", report))).status).toBe(400);
  });
  it("安装目录只查询安装类型，跨账户跟踪读取实际转化账户", async () => {
    sdk.request.mockImplementation(async (opts) => opts.data?.query.includes("FROM customer LIMIT") ? { data: { results: [{ customer: { ...account, conversionTrackingSetting: { googleAdsConversionCustomer: `customers/${manager}` } } }] } } : mockRequest(opts));
    await executeRestRequest(googleAdsSourceConfig(cid, manager), request("conversionActions"));
    const call = sdk.request.mock.calls.at(-1)![0];
    expect(call.url).toContain(`customers/${manager}/googleAds:search`);
    expect(call.data.query).toContain("GOOGLE_PLAY_DOWNLOAD");
    expect(call.data.query).not.toContain("IN_APP_PURCHASE");
  });
  it("基础花费与安装分开查询，CTR/CPI 和零安装正确", async () => {
    const result = await executeRestRequest(config, request("report", report));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ account: { currencyCode: "USD", timeZone: "Asia/Shanghai" }, rows: [
      { impressions: 100, clicks: 5, ctr: 0.05, cost: 12, installs: 3, cpi: 4 },
      { cost: 20, installs: 0, cpi: null },
    ] });
    const queries = sdk.request.mock.calls.map(([o]) => o.data?.query);
    expect(queries.find((q) => q?.includes("metrics.impressions"))).not.toContain("segments.conversion_action");
    const installQuery = queries.find((q) => q?.includes("metrics.all_conversions"));
    expect(installQuery).toContain(installAction);
    expect(installQuery?.split(" FROM ")[0]).toContain("segments.conversion_action");
    expect(queries.find((q) => q?.includes("metrics.all_conversions"))).not.toContain("cost_micros");
  });
  it("未选安装动作时返回 null，不当成零安装", async () => {
    const result = await executeRestRequest(config, request("report", { ...report, installAction: undefined }));
    expect(result.body).toMatchObject({ rows: [{ installs: null, cpi: null }, { installs: null, cpi: null }] });
    expect(sdk.request).toHaveBeenCalledTimes(2);
  });
  it("拒绝其他账户的安装动作", async () => {
    const result = await executeRestRequest(config, request("report", { ...report, installAction: `customers/${manager}/conversionActions/7` }));
    expect(result.status).toBe(400);
    expect(sdk.request).toHaveBeenCalledTimes(1);
  });
  it("安装动作未通过类型查询时停止，不回退总转化", async () => {
    sdk.request.mockImplementation(async (opts) => opts.data?.query.includes("FROM conversion_action") ? { data: { results: [] } } : mockRequest(opts));
    expect((await executeRestRequest(config, request("report", report))).status).toBe(400);
    expect(sdk.request).toHaveBeenCalledTimes(2);
  });
  it("空账户列表不标记为测试通过", async () => {
    sdk.request.mockResolvedValue({ data: {} });
    const result = await testApiSource(googleAdsSourceConfig());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("没有可见");
  });
  it("数值超过安全精度时不返回假数据", async () => {
    sdk.request.mockImplementation(async (opts) => opts.data?.query.includes("metrics.impressions") ? { data: { results: [{ ...daily[0], metrics: { impressions: "99999999999999999" } }] } } : mockRequest(opts));
    expect((await executeRestRequest(config, request("report", report))).status).toBe(502);
  });
});

describe("初始化与总超时", () => {
  it("ADC 失败后可重新初始化，不留下失败单例", async () => {
    vi.resetModules();
    const { executeGoogleAdsRequest } = await import("@/lib/server/connectors/google-ads");
    sdk.getClient.mockRejectedValueOnce(new Error("invalid_grant secret"));
    expect(await executeGoogleAdsRequest(config, request("accounts"))).toMatchObject({ status: 401 });
    expect(sdk.request).not.toHaveBeenCalled();
    expect((await executeGoogleAdsRequest(config, request("accounts"))).status).toBe(200);
    expect(sdk.getClient).toHaveBeenCalledTimes(2);
  });

  it("ADC 一直等待时返回超时，迟到成功不发送业务请求", async () => {
    vi.resetModules();
    const { executeGoogleAdsRequest } = await import("@/lib/server/connectors/google-ads");
    vi.useFakeTimers();
    let finish!: (value: object) => void;
    sdk.getClient.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = executeGoogleAdsRequest(config, request("accounts"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toMatchObject({ status: 504, retryable: false });
    finish({});
    await vi.advanceTimersByTimeAsync(0);
    expect(sdk.request).not.toHaveBeenCalled();
    expect((await executeGoogleAdsRequest(config, request("accounts"))).status).toBe(200);
  });

  it("请求总超时会发出取消信号，迟到结果不写缓存或继续下游查询", async () => {
    vi.useFakeTimers();
    let finish!: (value: object) => void;
    sdk.request.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = cachedRestRequest(config, request("report", report), { sourceId: source.id, skipThrottle: true });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({ status: 504, retryable: false, fromCache: false });
    expect(sdk.request.mock.calls[0]![0].signal.aborted).toBe(true);
    finish({ data: { results: [{ customer: account }] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(sdk.request).toHaveBeenCalledTimes(1);
    expect(prisma.apiQueryCache.upsert).not.toHaveBeenCalled();
  });

  it.each(["read", "write", "hit"])("缓存 %s 卡住不会阻断可用数据", async (stage) => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    if (stage === "hit") {
      await cachedRestRequest(config, request("accounts"), { sourceId: source.id, skipThrottle: true });
      vi.mocked(prisma.apiQueryCache.update).mockImplementationOnce(() => new Promise(() => {}) as never);
    } else if (stage === "read") {
      vi.mocked(prisma.apiQueryCache.findUnique).mockImplementationOnce(() => new Promise(() => {}) as never);
    } else {
      vi.mocked(prisma.apiQueryCache.upsert).mockImplementationOnce(() => new Promise(() => {}) as never);
    }
    const pending = cachedRestRequest(config, request("accounts"), { sourceId: source.id, skipThrottle: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject({ status: 200, fromCache: stage === "hit" });
    expect(sdk.request).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});

describe("缓存、诊断与工作流集成", () => {
  it("缓存按客户、经理、日期、campaign、动作、分页隔离", async () => {
    const options = { sourceId: source.id, skipThrottle: true };
    const input = request("report", report);
    await cachedRestRequest(config, input, options);
    const before = sdk.request.mock.calls.length;
    expect((await cachedRestRequest(config, input, options)).fromCache).toBe(true);
    expect(sdk.request).toHaveBeenCalledTimes(before);
    await cachedRestRequest(config, input, { ...options, sourceId: "other-source" });
    await cachedRestRequest(googleAdsSourceConfig(cid, manager), input, options);
    await cachedRestRequest(googleAdsSourceConfig(manager), request("campaigns"), options);
    await cachedRestRequest(config, request("report", { ...report, startDate: "2026-11-02" }), options);
    await cachedRestRequest(config, request("report", { ...report, campaignId: "43" }), options);
    await cachedRestRequest(config, request("report", { ...report, installAction: undefined }), options);
    await cachedRestRequest(config, request("campaigns", { afterId: "41" }), options);
    expect(cache.size).toBe(8);
  });
  it("campaign 缓存30秒，报告缓存300秒", async () => {
    await cachedRestRequest(config, request("campaigns"), { sourceId: source.id, skipThrottle: true });
    const expiry = [...cache.values()][0]!.expiresAt.getTime() - Date.now();
    expect(expiry).toBeGreaterThan(29000); expect(expiry).toBeLessThanOrEqual(30000);
    await cachedRestRequest(config, request("report", report), { sourceId: source.id, skipThrottle: true });
    expect([...cache.values()][1]!.expiresAt.getTime() - Date.now()).toBeGreaterThan(299000);
  });
  it("权限拒绝不回退过期缓存，不泄露认证", async () => {
    const input = request("campaigns");
    await cachedRestRequest(config, input, { sourceId: source.id, skipThrottle: true });
    for (const value of cache.values()) value.expiresAt = new Date(0);
    sdk.request.mockRejectedValue({ message: "Bearer secret-token", config: { private_key: "secret-key" }, response: { status: 403, data: { error: { status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } } } });
    const result = await cachedRestRequest(config, input, { sourceId: source.id, skipThrottle: true });
    expect(result).toMatchObject({ status: 403, fromCache: false, body: { codes: ["PERMISSION_DENIED", "SERVICE_DISABLED"] } });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).toContain("apis/library/googleads.googleapis.com");
  });
  it("查询语法错误不误报成权限缺失", () => {
    const failure = googleAdsError({ response: { status: 400, data: { error: { status: "INVALID_ARGUMENT", details: [{ errors: [{ errorCode: { queryError: "EXPECTED_REFERENCED_FIELD_IN_SELECT_CLAUSE" } }] }] } } } });
    expect(failure.body.help).toEqual([]);
    expect(failure.body.codes).toContain("EXPECTED_REFERENCED_FIELD_IN_SELECT_CLAUSE");
  });
  it("权限错误保留 Google Ads 枚举错误码", () => {
    expect(googleAdsError({ response: { status: 403, data: { error: { details: [{ errors: [{ errorCode: { authorizationError: "USER_PERMISSION_DENIED" } }] }] } } } }).body.codes).toContain("USER_PERMISSION_DENIED");
  });
  it("长报告按完整行裁剪并给出下一起始日", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ date: `date-${i}`, campaignName: "x".repeat(300) }));
    const result = JSON.parse(serializeGoogleAdsResult({ status: 200, contentType: "application/json", body: { rows, operation: "report" }, elapsedMs: 1, truncated: false }, source));
    expect(result.truncated).toBe(true);
    expect(result.nextStartDate).toBe(rows[result.rows.length]!.date);
    expect(result.returnedRows).toBe(result.rows.length);
  });
  it("action 路由使用同一受限连接器", async () => {
    const response = await POST(new Request("http://localhost/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request("campaigns")) }), { params: Promise.resolve({ id: source.id, action: "request" }) });
    expect(response.status).toBe(200);
    expect((await response.json()).data.status).toBe(200);
    expect(sdk.request).toHaveBeenCalled();
  });
  it("未认证不得查询", async () => {
    vi.mocked(requireBusinessSession).mockRejectedValueOnce(new ApiError(401, "UNAUTHORIZED", "未登录"));
    const response = await POST(new Request("http://localhost/test", { method: "POST" }), { params: Promise.resolve({ id: source.id, action: "test" }) });
    expect(response.status).toBe(401);
    expect(sdk.request).not.toHaveBeenCalled();
  });
  it("网页与 MCP 共用 Agent 工具识别 Google Ads，无需属性 ID", async () => {
    const context = createRunContext({ questionId: "ads-task", question: "列出 campaign", sink: () => undefined });
    const tool = createApiSourceTool(context, [source]);
    const output = await tool.invoke({ sourceId: source.id, method: "POST", path: "campaigns", body: "{}" });
    expect(JSON.parse(String(output))).toMatchObject({ status: 200, sourceId: source.id, operation: "campaigns" });
    expect(externalSourcesSummary([source])).toContain("不需要 Property ID");
  });
});
