import { z } from "zod";
import { ApiError, handleApiError, ok, readJson, requireActor } from "@/lib/server/api-runtime";
import { prisma } from "@/lib/db";
import { newId } from "@/lib/server/ids";
import { displayEndpoint, listDataSources } from "@/lib/server/connectors/datasources";
import { assertHttpUrl } from "@/lib/server/connectors/api";
import { Ga4PropertyIdSchema, ga4SourceConfig } from "@/lib/server/connectors/google-analytics";
import { GoogleAdsCustomerIdSchema, googleAdsSourceConfig } from "@/lib/server/connectors/google-ads";

export const runtime = "nodejs";

/** 创建数据源请求（按 type 分支校验） */
const CreateDataSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("bi"),
    name: z.string().min(1, "名称不能为空").max(100),
    /** PostgreSQL 连接串 */
    connectionUrl: z.string().min(1, "bi 类型数据源必须提供 connectionUrl"),
  }),
  z.object({
    type: z.literal("api"),
    name: z.string().min(1, "名称不能为空").max(100),
    /** REST base URL 或 GraphQL endpoint */
    endpoint: z.string().url("endpoint 必须是合法 URL").optional(),
    protocol: z.enum(["rest", "graphql", "ga4", "google_ads"]),
    customerId: GoogleAdsCustomerIdSchema.optional(),
    loginCustomerId: GoogleAdsCustomerIdSchema.optional(),
    propertyId: Ga4PropertyIdSchema.optional(),
    authType: z.enum(["none", "bearer", "api_key", "basic", "adc"]).default("none"),
    authToken: z.string().max(2000).optional(),
    apiKeyHeader: z.string().max(100).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    type: z.literal("mcp"),
    name: z.string().min(1, "名称不能为空").max(100),
    /** 内部 MCP 代理 streamable HTTP 地址 */
    proxyUrl: z.string().url("proxyUrl 必须是合法 URL"),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    type: z.literal("web"),
    name: z.string().min(1).max(100),
  }),
  z.object({
    type: z.literal("browser"),
    name: z.string().min(1).max(100),
  }),
]);

/**
 * GET /api/v1/datasources — 数据源列表（内置 + 自定义，连接串脱敏）
 */
export async function GET(request: Request) {
  try {
    await requireActor(request);
    const sources = await listDataSources();
    return ok({
      dataSources: sources.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        builtin: s.builtin,
        status: s.status,
        createdAt: s.createdAt ?? null,
        endpoint: displayEndpoint(s),
        // api 源附带协议等非敏感元信息，供前端按协议渲染控制台；
        // authConfigured 透出凭证是否已配置（脱敏布尔值，凭证本身仅存服务端不回显）
        meta: s.type === "api" && s.apiConfig
          ? {
              protocol: s.apiConfig.protocol,
              authType: s.apiConfig.authType,
              ...(s.apiConfig.protocol === "ga4" ? { propertyId: s.apiConfig.propertyId } : {}),
              ...(s.apiConfig.protocol === "google_ads" ? { customerId: s.apiConfig.customerId, loginCustomerId: s.apiConfig.loginCustomerId } : {}),
              authConfigured: s.apiConfig.protocol === "ga4" || s.apiConfig.protocol === "google_ads"
                ? null // ADC 可以来自工作负载身份；不能根据环境变量是否存在断言可用性。
                : s.apiConfig.authType === "none" || Boolean(s.apiConfig.authToken),
            }
          : null,
      })),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * POST /api/v1/datasources — 注册自定义数据源（bi / api / mcp）
 */
export async function POST(request: Request) {
  try {
    await requireActor(request);
    const input = CreateDataSourceSchema.parse(await readJson<unknown>(request));

    if (input.type === "web" || input.type === "browser") {
      throw new ApiError(
        400,
        "UNSUPPORTED",
        input.type === "web"
          ? "web 检索源为内置数据源，无需注册"
          : "浏览器抓取数据源暂不支持",
      );
    }

    // 组装分类型 config（值均为 JSON 可序列化类型，满足 Prisma Json 入参）
    let config: Record<string, string | Record<string, string>>;
    if (input.type === "bi") {
      config = { connectionUrl: input.connectionUrl };
    } else if (input.type === "api" && input.protocol === "google_ads") {
      config = googleAdsSourceConfig(input.customerId, input.loginCustomerId);
    } else if (input.type === "api" && input.protocol === "ga4") {
      config = ga4SourceConfig(Ga4PropertyIdSchema.parse(input.propertyId));
    } else if (input.type === "api") {
      if (!input.endpoint) throw new ApiError(400, "INVALID_REQUEST", "api 类型数据源必须提供 endpoint");
      if (input.authType === "adc") throw new ApiError(400, "INVALID_REQUEST", "ADC 仅适用于 Google 数据源");
      const urlCheck = assertHttpUrl(input.endpoint);
      if (!urlCheck.ok) throw new ApiError(400, "INVALID_REQUEST", `endpoint 非法：${urlCheck.reason}`);
      config = {
        endpoint: input.endpoint,
        protocol: input.protocol,
        authType: input.authType,
        ...(input.authToken ? { authToken: input.authToken } : {}),
        ...(input.apiKeyHeader ? { apiKeyHeader: input.apiKeyHeader } : {}),
        ...(input.headers ? { headers: input.headers } : {}),
      };
    } else {
      const urlCheck = assertHttpUrl(input.proxyUrl);
      if (!urlCheck.ok) throw new ApiError(400, "INVALID_REQUEST", `proxyUrl 非法：${urlCheck.reason}`);
      config = {
        proxyUrl: input.proxyUrl,
        ...(input.headers ? { headers: input.headers } : {}),
      };
    }

    const id = newId("data_source");
    await prisma.dataSource.create({
      data: {
        id,
        name: input.name,
        type: input.type,
        connectorId: input.type === "bi" ? "postgres" : input.type === "api" && input.protocol === "google_ads" ? "google-ads" : input.type === "api" && input.protocol === "ga4" ? "google-analytics" : input.type,
        config,
      },
    });

    return ok({ id, name: input.name, type: input.type }, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
