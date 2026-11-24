import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertHttpUrl,
  assertReadOnlyGraphQL,
  buildAuthHeaders,
  resolveRequestUrl,
} from "@/lib/server/connectors/api";

// 注册接口测试：隔离 DB 与环境变量依赖
vi.mock("@/lib/db", () => ({
  prisma: {
    dataSource: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));
vi.mock("@/lib/env", () => ({
  env: { DATABASE_URL: "postgresql://localhost:5432/test?schema=cause" },
}));
// 鉴权打桩：BFF 会话链路不在本测试范围，route 层只验证业务行为
vi.mock("@/lib/server/auth/session", () => ({
  requireBusinessSession: vi.fn().mockResolvedValue({
    id: "user_test",
    name: "测试用户",
    email: "test@example.com",
    role: "admin",
  }),
}));

import { GET as listGet, POST } from "@/app/api/v1/datasources/route";
import { PUT } from "@/app/api/v1/datasources/[id]/route";
import { prisma } from "@/lib/db";
import { ga4SourceConfig } from "@/lib/server/connectors/google-analytics";
import { googleAdsSourceConfig } from "@/lib/server/connectors/google-ads";

describe("GraphQL 只读防护 assertReadOnlyGraphQL", () => {
  it("允许匿名查询与 query 操作", () => {
    expect(assertReadOnlyGraphQL("{ countries { name } }").ok).toBe(true);
    expect(assertReadOnlyGraphQL("query GetUsers { users { id } }").ok).toBe(true);
  });

  it("拒绝 mutation 操作", () => {
    const result = assertReadOnlyGraphQL('mutation { createUser(name: "x") { id } }');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("mutation");
  });

  it("拒绝 subscription 操作", () => {
    const result = assertReadOnlyGraphQL("subscription { onEvent { id } }");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("subscription");
  });

  it("注释与字符串中出现 mutation 字样不误判", () => {
    expect(assertReadOnlyGraphQL("# mutation 说明\n{ users { id } }").ok).toBe(true);
    expect(assertReadOnlyGraphQL('{ search(kw: "mutation") { id } }').ok).toBe(true);
  });
});

describe("REST 请求 URL 拼接 resolveRequestUrl", () => {
  it("相对 path 拼接到 endpoint 并附加 query 参数", () => {
    const url = resolveRequestUrl("https://api.example.com/v1/", "users", { page: "2" });
    expect(url).toBe("https://api.example.com/v1/users?page=2");
  });

  it("跨主机 path 写法被中和为同主机子路径（不会跨主机重定向）", () => {
    // base path 拼接语义下前导斜杠被剥离，绝对 URL / 协议相对路径均退化为子路径
    expect(resolveRequestUrl("https://api.example.com", "https://evil.com/steal")).toBe(
      "https://api.example.com/https://evil.com/steal",
    );
    expect(resolveRequestUrl("https://api.example.com", "//evil.com/x")).toBe(
      "https://api.example.com/evil.com/x",
    );
  });
});

describe("endpoint 协议与认证头", () => {
  it("仅允许 http/https 协议", () => {
    expect(assertHttpUrl("https://api.example.com").ok).toBe(true);
    expect(assertHttpUrl("ftp://api.example.com").ok).toBe(false);
    expect(assertHttpUrl("not-a-url").ok).toBe(false);
  });

  it("按 authType 组装认证头", () => {
    expect(
      buildAuthHeaders({ endpoint: "https://x", protocol: "rest", authType: "bearer", authToken: "t1" }),
    ).toMatchObject({ authorization: "Bearer t1" });
    expect(
      buildAuthHeaders({ endpoint: "https://x", protocol: "rest", authType: "api_key", authToken: "k1" }),
    ).toMatchObject({ "X-API-Key": "k1" });
  });
});

describe("数据源注册接口分类型校验 POST /api/v1/datasources", () => {
  beforeEach(() => {
    vi.mocked(prisma.dataSource.create).mockClear();
  });

  function post(body: unknown): Promise<Response> {
    return POST(
      new Request("http://localhost/api/v1/datasources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  it("api 类型缺少 endpoint 返回 400", async () => {
    const res = await post({ type: "api", name: "开放平台", protocol: "rest" });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("INVALID_REQUEST");
  });

  it("mcp 类型缺少 proxyUrl 返回 400", async () => {
    const res = await post({ type: "mcp", name: "内部代理" });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("INVALID_REQUEST");
  });

  it("browser 类型返回 400 暂不支持", async () => {
    const res = await post({ type: "browser", name: "浏览器抓取" });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("UNSUPPORTED");
    expect(json.error.message).toContain("暂不支持");
    expect(prisma.dataSource.create).not.toHaveBeenCalled();
  });

  it("合法 api 数据源注册成功并落库", async () => {
    const res = await post({
      type: "api",
      name: "Countries GraphQL",
      endpoint: "https://countries.trevorblades.com/graphql",
      protocol: "graphql",
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(prisma.dataSource.create).toHaveBeenCalledOnce();
    const createArg = vi.mocked(prisma.dataSource.create).mock.calls[0]![0];
    expect(createArg.data.config).toMatchObject({
      endpoint: "https://countries.trevorblades.com/graphql",
      protocol: "graphql",
      authType: "none",
    });
  });

  it("Google Ads 没有客户 ID 也可注册，不保存前端夹带的认证", async () => {
    const res = await post({ type: "api", name: "Google Ads", protocol: "google_ads", authToken: "discard-me", endpoint: "https://evil.test", keyFilename: "/fake/key" });
    expect(res.status).toBe(201);
    expect(vi.mocked(prisma.dataSource.create).mock.calls[0]![0].data).toMatchObject({ connectorId: "google-ads", config: googleAdsSourceConfig() });
    expect(JSON.stringify(vi.mocked(prisma.dataSource.create).mock.calls)).not.toContain("discard-me");
  });

  it.each(["123", "123-456-7890", "1 OR 1=1"])("Google Ads 拒绝非法客户 ID %s", async (customerId) => {
    expect((await post({ type: "api", name: "Ads", protocol: "google_ads", customerId })).status).toBe(400);
    expect(prisma.dataSource.create).not.toHaveBeenCalled();
  });

  it("GA4 只需数字属性 ID，服务端固定官方 endpoint 与 ADC", async () => {
    const res = await post({ type: "api", name: "Google Analytics 4", protocol: "ga4", propertyId: "123456789" });
    expect(res.status).toBe(201);
    expect(vi.mocked(prisma.dataSource.create).mock.calls[0]![0].data).toMatchObject({
      type: "api", connectorId: "google-analytics", config: ga4SourceConfig("123456789"),
    });
  });

  it.each([undefined, "G-ABC123", "properties/123", "0", "", "1/../../2"])("GA4 拒绝非法 Property ID：%s", async (propertyId) => {
    const res = await post({ type: "api", name: "GA4", protocol: "ga4", propertyId });
    expect(res.status).toBe(400);
    expect(prisma.dataSource.create).not.toHaveBeenCalled();
  });

  it("GA4 不保存客户端夹带的 endpoint、Token 或凭证路径", async () => {
    const res = await post({
      type: "api", name: "GA4", protocol: "ga4", propertyId: "123",
      endpoint: "https://untrusted.example", authToken: "test-not-a-real-secret", headers: { Authorization: "test" },
      keyFilename: "/test/not-a-real-key.json",
    });
    expect(res.status).toBe(201);
    expect(vi.mocked(prisma.dataSource.create).mock.calls[0]![0].data.config).toEqual(ga4SourceConfig("123"));
    expect(await res.text()).not.toContain("test-not-a-real-secret");
  });

  it("普通 REST 不接受 ADC", async () => {
    const res = await post({ type: "api", name: "REST", protocol: "rest", endpoint: "https://example.test", authType: "adc" });
    expect(res.status).toBe(400);
    expect(prisma.dataSource.create).not.toHaveBeenCalled();
  });

  it("合法 mcp 数据源注册成功", async () => {
    const res = await post({
      type: "mcp",
      name: "内部 MCP 代理",
      proxyUrl: "https://mcp-proxy.internal/mcp",
      headers: { "X-Tenant-Id": "demo" },
    });
    expect(res.status).toBe(201);
    expect(prisma.dataSource.create).toHaveBeenCalledOnce();
  });
});

describe("更新数据源认证配置 PUT /api/v1/datasources/[id]", () => {
  /** 模拟已注册的 api 数据源记录（含现有 token） */
  const apiRecord = {
    id: "data_source_adjust",
    name: "Adjust 报告服务",
    type: "api" as const,
    connectorId: "api",
    config: {
      endpoint: "https://automate.adjust.com/reports-service",
      protocol: "rest",
      authType: "bearer",
      authToken: "old-token",
    },
    createdAt: new Date("2026-09-01T00:00:00Z"),
  };

  function put(id: string, body: unknown): Promise<Response> {
    return PUT(
      new Request(`http://localhost/api/v1/datasources/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );
  }

  beforeEach(() => {
    vi.mocked(prisma.dataSource.findUnique).mockReset();
    vi.mocked(prisma.dataSource.update).mockReset().mockResolvedValue(apiRecord as never);
  });

  it("更新 authToken 时保留其余配置（endpoint/protocol 不丢）", async () => {
    vi.mocked(prisma.dataSource.findUnique).mockResolvedValue(apiRecord as never);
    const res = await put("data_source_adjust", { authToken: "new-token" });
    expect(res.status).toBe(200);
    const updateArg = vi.mocked(prisma.dataSource.update).mock.calls[0]![0];
    expect(updateArg.data.config).toMatchObject({
      endpoint: "https://automate.adjust.com/reports-service",
      protocol: "rest",
      authType: "bearer",
      authToken: "new-token",
    });
  });

  it("不传 authToken 时保留原凭证（合并语义）", async () => {
    vi.mocked(prisma.dataSource.findUnique).mockResolvedValue(apiRecord as never);
    await put("data_source_adjust", { name: "Adjust 报告服务（改名）" });
    const updateArg = vi.mocked(prisma.dataSource.update).mock.calls[0]![0];
    expect(updateArg.data.config).toMatchObject({ authToken: "old-token" });
    expect(updateArg.data.name).toBe("Adjust 报告服务（改名）");
  });

  it("authType 切回 none 时同步清除已存凭证", async () => {
    vi.mocked(prisma.dataSource.findUnique).mockResolvedValue(apiRecord as never);
    await put("data_source_adjust", { authType: "none" });
    const config = vi.mocked(prisma.dataSource.update).mock.calls[0]![0].data.config as Record<string, unknown>;
    expect(config).toMatchObject({ authType: "none", endpoint: "https://automate.adjust.com/reports-service" });
    expect("authToken" in config).toBe(false);
  });

  it("内置数据源不可修改（403）", async () => {
    const res = await put("data_source_demo_pg", { authToken: "x" });
    expect(res.status).toBe(403);
    expect(prisma.dataSource.update).not.toHaveBeenCalled();
  });

  it("数据源不存在返回 404", async () => {
    vi.mocked(prisma.dataSource.findUnique).mockResolvedValue(null);
    const res = await put("data_source_missing", { authToken: "x" });
    expect(res.status).toBe(404);
  });

  it("Google Ads 可以保存客户并清空旧经理 ID", async () => {
    vi.mocked(prisma.dataSource.findUnique).mockResolvedValue({ ...apiRecord, config: googleAdsSourceConfig("1234567890", "9876543210") } as never);
    expect((await put(apiRecord.id, { customerId: "1234567891", loginCustomerId: "" })).status).toBe(200);
    expect(vi.mocked(prisma.dataSource.update).mock.calls[0]![0].data.config).toEqual(googleAdsSourceConfig("1234567891"));
  });

  it.each([{ endpoint: "https://evil.test" }, { authToken: "test" }, { protocol: "rest" }, { propertyId: "123" }])("Google Ads 拒绝改写受限配置 %j", async (body) => {
    vi.mocked(prisma.dataSource.findUnique).mockResolvedValue({ ...apiRecord, config: googleAdsSourceConfig() } as never);
    expect((await put(apiRecord.id, body)).status).toBe(400);
    expect(prisma.dataSource.update).not.toHaveBeenCalled();
  });

  it("GA4 可以更新名称和 Property ID，保留固定 SDK 配置", async () => {
    vi.mocked(prisma.dataSource.findUnique).mockResolvedValue({ ...apiRecord, config: ga4SourceConfig("123") } as never);
    const res = await put(apiRecord.id, { name: "GA4 新属性", propertyId: "456" });
    expect(res.status).toBe(200);
    expect(vi.mocked(prisma.dataSource.update).mock.calls[0]![0].data).toEqual({ name: "GA4 新属性", config: ga4SourceConfig("456") });
  });

  it.each([
    { endpoint: "https://other.example" }, { protocol: "rest" }, { authType: "bearer" },
    { authToken: "test-token" }, { headers: { Authorization: "test" } }, { propertyId: "G-123" },
  ])("GA4 拒绝替换 SDK 认证或非法属性：%j", async (body) => {
    vi.mocked(prisma.dataSource.findUnique).mockResolvedValue({ ...apiRecord, config: ga4SourceConfig("123") } as never);
    const res = await put(apiRecord.id, body);
    expect(res.status).toBe(400);
    expect(prisma.dataSource.update).not.toHaveBeenCalled();
  });

  it("不会将已有 Adjust 数据源原地改为 GA4", async () => {
    vi.mocked(prisma.dataSource.findUnique).mockResolvedValue(apiRecord as never);
    const res = await put(apiRecord.id, { protocol: "ga4", propertyId: "123" });
    expect(res.status).toBe(400);
    expect(prisma.dataSource.update).not.toHaveBeenCalled();
  });

  it("非法 endpoint 返回 400 且不落库", async () => {
    vi.mocked(prisma.dataSource.findUnique).mockResolvedValue(apiRecord as never);
    const res = await put("data_source_adjust", { endpoint: "not-a-url" });
    expect(res.status).toBe(400);
    expect(prisma.dataSource.update).not.toHaveBeenCalled();
  });
});

describe("数据源列表透出凭证配置状态 GET /api/v1/datasources", () => {
  beforeEach(() => {
    vi.mocked(prisma.dataSource.findMany).mockReset();
  });

  it("Google Ads 列表仅透出客户与经理 ID，未测试不宣称认证可用", async () => {
    vi.mocked(prisma.dataSource.findMany).mockResolvedValue([{ ...apiListRecord("ads", "Ads", "adc"), config: googleAdsSourceConfig("1234567890", "9876543210") }] as never);
    const json = await (await listGet(new Request("http://localhost/api/v1/datasources"))).json();
    const item = json.data.dataSources.find((s: { id: string }) => s.id === "ads");
    expect(item.meta).toEqual({ protocol: "google_ads", authType: "adc", authConfigured: null, customerId: "1234567890", loginCustomerId: "9876543210" });
    expect(item.config).toBeUndefined();
  });

  it("GA4 列表只透出属性 ID，ADC 未测试时不宣称可用或缺失", async () => {
    vi.mocked(prisma.dataSource.findMany).mockResolvedValue([
      { ...apiListRecord("data_source_ga4", "GA4", "adc"), config: ga4SourceConfig("123") },
    ] as never);
    const json = await (await listGet(new Request("http://localhost/api/v1/datasources"))).json();
    const source = json.data.dataSources.find((s: { id: string }) => s.id === "data_source_ga4");
    expect(source.meta).toEqual({ protocol: "ga4", authType: "adc", authConfigured: null, propertyId: "123" });
    expect(source.endpoint).toContain("properties/123");
    expect(source.config).toBeUndefined();
  });

  it("meta.authConfigured 反映凭证是否已配置（脱敏布尔值，不回显凭证）", async () => {
    vi.mocked(prisma.dataSource.findMany).mockResolvedValue([
      apiListRecord("data_source_a", "Adjust 报告服务", "bearer", "token-x"),
      apiListRecord("data_source_b", "开放平台", "bearer"),
      apiListRecord("data_source_c", "公共接口", "none"),
    ] as never);
    const res = await listGet(new Request("http://localhost/api/v1/datasources"));
    const json = await res.json();
    expect(json.ok).toBe(true);
    const byId = new Map(
      (json.data.dataSources as Array<{ id: string; meta: { authConfigured: boolean } | null }>).map(
        (s) => [s.id, s] as const,
      ),
    );
    expect(byId.get("data_source_a")!.meta!.authConfigured).toBe(true);
    expect(byId.get("data_source_b")!.meta!.authConfigured).toBe(false);
    // none 认证无需凭证，视为已配置
    expect(byId.get("data_source_c")!.meta!.authConfigured).toBe(true);
    // 凭证本身不回显
    expect(JSON.stringify(json)).not.toContain("token-x");
  });
});

/** 构造列表接口返回的 api 数据源记录 */
function apiListRecord(id: string, name: string, authType: string, authToken?: string) {
  return {
    id,
    name,
    type: "api" as const,
    connectorId: "api",
    config: {
      endpoint: "https://automate.adjust.com/reports-service",
      protocol: "rest",
      authType,
      ...(authToken ? { authToken } : {}),
    },
    createdAt: new Date("2026-09-01T00:00:00Z"),
  };
}
