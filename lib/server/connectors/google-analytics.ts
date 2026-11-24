import { z } from "zod";
import type { protos } from "@google-analytics/data";
import type { ApiCallResult, ApiSourceConfig, RestRequestInput } from "./api";
import { withDeadline, QueryTimeoutError, GOOGLE_INITIALIZATION_TIMEOUT_MS, GOOGLE_OPERATION_TIMEOUT_MS } from "./deadline";

export const GA4_ENDPOINT = "https://analyticsdata.googleapis.com";
export const Ga4PropertyIdSchema = z.string().trim().regex(/^[1-9]\d{0,19}$/, "请输入 GA4 数字 Property ID，不是 G- 开头的 Measurement ID");

/** GA4 仅使用服务端 ADC；不接受客户端指定凭证文件或 SDK endpoint。 */
export function ga4SourceConfig(propertyId: string) {
  return {
    endpoint: GA4_ENDPOINT,
    protocol: "ga4" as const,
    authType: "adc" as const,
    propertyId: Ga4PropertyIdSchema.parse(propertyId),
  };
}

const fieldName = z.string().min(1).max(128).regex(/^[a-zA-Z][a-zA-Z0-9_:]*$/);
const field = z.object({ name: fieldName }).strict();
const date = z.string().refine((value) => {
  if (/^(today|yesterday|\d{1,4}daysAgo)$/.test(value)) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "日期须为有效 YYYY-MM-DD、today、yesterday 或 NdaysAgo");
const stringFilter = z.object({
  matchType: z.enum(["EXACT", "BEGINS_WITH", "ENDS_WITH", "CONTAINS", "FULL_REGEXP", "PARTIAL_REGEXP"]),
  value: z.string().max(1000),
  caseSensitive: z.boolean().optional(),
}).strict();
const filter = z.object({
  fieldName,
  stringFilter: stringFilter.optional(),
  inListFilter: z.object({ values: z.array(z.string().max(500)).min(1).max(100), caseSensitive: z.boolean().optional() }).strict().optional(),
}).strict().refine((f) => Number(!!f.stringFilter) + Number(!!f.inListFilter) === 1, "过滤条件须指定 stringFilter 或 inListFilter 之一");
const leafExpression = z.object({ filter }).strict();
const dimensionFilter = z.union([
  leafExpression,
  z.object({ andGroup: z.object({ expressions: z.array(leafExpression).min(1).max(10) }).strict() }).strict(),
  z.object({ orGroup: z.object({ expressions: z.array(leafExpression).min(1).max(10) }).strict() }).strict(),
  z.object({ notExpression: leafExpression }).strict(),
]);
const orderBy = z.union([
  z.object({ metric: z.object({ metricName: fieldName }).strict(), desc: z.boolean().optional() }).strict(),
  z.object({ dimension: z.object({ dimensionName: fieldName }).strict(), desc: z.boolean().optional() }).strict(),
]);

/** 受限的官方 runReport 请求形态；禁止覆盖 property 或传入写操作参数。 */
export const Ga4ReportSchema = z.object({
  dateRanges: z.array(z.object({ startDate: date, endDate: date }).strict()).length(1),
  dimensions: z.array(field).max(9).default([]),
  metrics: z.array(field).min(1).max(10),
  dimensionFilter: dimensionFilter.optional(),
  orderBys: z.array(orderBy).max(10).optional(),
  limit: z.number().int().min(1).max(1000).default(200),
  offset: z.number().int().min(0).max(1_000_000).default(0),
  keepEmptyRows: z.boolean().optional(),
  currencyCode: z.string().regex(/^[A-Z]{3}$/).optional(),
}).strict().superRefine((request, ctx) => {
  const names = [...request.dimensions, ...request.metrics].map((f) => f.name);
  if (new Set(names).size !== names.length) ctx.addIssue({ code: "custom", message: "指标与维度不能重名或重复" });
  const range = request.dateRanges[0];
  if (range && /^\d{4}-/.test(range.startDate) && /^\d{4}-/.test(range.endDate) && range.startDate > range.endDate) {
    ctx.addIssue({ code: "custom", message: "开始日期不能晚于结束日期" });
  }
});

type Ga4Action =
  | { kind: "report"; property: string; report: z.infer<typeof Ga4ReportSchema> }
  | { kind: "metadata"; property: string; search: string };

/** 缓存命中前同样校验，避免非法请求被缓存绕过。 */
export function parseGa4Request(config: ApiSourceConfig, input: RestRequestInput): Ga4Action {
  const property = `properties/${Ga4PropertyIdSchema.parse(config.propertyId)}`;
  const path = (input.path ?? "").replace(/^\//, "");
  if (input.method === "GET" && path === "metadata") {
    const params = z.object({ search: z.string().max(100).optional() }).strict().parse(input.params ?? {});
    if (input.body !== undefined) throw new Error("GA4 metadata 不接受请求体");
    return { kind: "metadata", property, search: params.search?.toLowerCase() ?? "" };
  }
  if (input.method !== "POST" || path !== "runReport") {
    throw new Error("GA4 仅支持 POST runReport 或 GET metadata，不能调用任意路径或写操作");
  }
  if (Object.keys(input.params ?? {}).length) throw new Error("GA4 runReport 参数必须放在 JSON 请求体中");
  if (Buffer.byteLength(JSON.stringify(input.body ?? {}), "utf8") > 20_000) throw new Error("GA4 请求体不能超过 20KB");
  return { kind: "report", property, report: Ga4ReportSchema.parse(input.body) };
}

/** 延迟加载官方 SDK：构建与普通 Adjust 查询均不初始化 Google 认证。 */
let clientPromise: Promise<InstanceType<typeof import("@google-analytics/data").BetaAnalyticsDataClient>> | undefined;
async function getClient() {
  if (!clientPromise) {
    const pending = withDeadline(async (signal) => {
      const { BetaAnalyticsDataClient } = await import("@google-analytics/data");
      signal.throwIfAborted();
      const client = new BetaAnalyticsDataClient({ scopes: ["https://www.googleapis.com/auth/analytics.readonly"] });
      // 必须先等待初始化，避免 SDK 报告方法内部产生脱离调用链的拒绝。
      await client.initialize();
      if (signal.aborted) {
        void client.close().catch(() => {});
        signal.throwIfAborted();
      }
      return client;
    }, GOOGLE_INITIALIZATION_TIMEOUT_MS);
    clientPromise = pending;
    void pending.catch(() => { if (clientPromise === pending) clientPromise = undefined; });
  }
  return clientPromise;
}

/** SDK 错误仅输出类别，不暴露凭证、私钥、文件路径或认证响应。 */
function sdkFailure(error: unknown): { status: number; message: string } {
  if (error instanceof QueryTimeoutError) return { status: 504, message: error.message };
  const code = Number((error as { code?: unknown } | null)?.code);
  if (code === 7 || code === 403) return { status: 403, message: "GA4 权限不足：请启用 Google Analytics Data API，并为 ADC 对应账号授予目标属性的查看者（Viewer）或更高权限" };
  if (code === 16 || code === 401) return { status: 401, message: "Google 认证失败：请检查服务端 ADC / GOOGLE_APPLICATION_CREDENTIALS 配置" };
  if (code === 8 || code === 429) return { status: 429, message: "GA4 配额耗尽或触发限流，请稍后重试" };
  if (code === 3 || code === 400) return { status: 400, message: "GA4 拒绝查询参数：请通过 metadata 核对指标、维度及其兼容性" };
  if (code === 5 || code === 404) return { status: 404, message: "GA4 属性不存在或当前账号不可见，请核对 Property ID 与权限" };
  if (code === 4 || code === 14 || code >= 500) return { status: 503, message: "GA4 请求超时或服务暂不可用，请稍后重试" };
  return { status: 400, message: "GA4 SDK 调用失败：请检查服务端 ADC 凭证、网络连接及属性权限" };
}

type ReportResponse = protos.google.analytics.data.v1beta.IRunReportResponse;

/** 保留上游计算结果与数据质量元信息；绝不将去重人数或比率再次相加。 */
export function ga4ReportTable(response: ReportResponse, action: Extract<Ga4Action, { kind: "report" }>, maxBytes: number) {
  const dimensions = (response.dimensionHeaders ?? []).map((h) => h.name ?? "");
  const metrics = (response.metricHeaders ?? []).map((h) => h.name ?? "");
  const sourceRows = response.rows ?? [];
  const rows: Record<string, unknown>[] = [];
  let bytes = 0;
  for (const row of sourceRows.slice(0, action.report.limit)) {
    const entries: Array<[string, unknown]> = dimensions.map((name, i) => [name, row.dimensionValues?.[i]?.value ?? ""]);
    for (const [i, name] of metrics.entries()) {
      const raw = row.metricValues?.[i]?.value ?? "";
      const number = Number(raw);
      entries.push([name, raw !== "" && Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER ? number : raw]);
    }
    const value = Object.fromEntries(entries);
    bytes += Buffer.byteLength(JSON.stringify(value), "utf8");
    if (bytes > Math.max(1024, maxBytes - 16_384)) break;
    rows.push(value);
  }
  const rowCount = response.rowCount ?? sourceRows.length;
  const nextOffset = action.report.offset + rows.length;
  const hasMore = nextOffset < rowCount;
  return {
    property: action.property,
    dateRanges: action.report.dateRanges,
    columns: [...dimensions, ...metrics],
    rows,
    rowCount,
    returnedRows: rows.length,
    offset: action.report.offset,
    nextOffset: hasMore && rows.length > 0 ? nextOffset : null,
    truncated: hasMore || rows.length < sourceRows.length,
    metadata: response.metadata ?? null,
    propertyQuota: response.propertyQuota ?? null,
    notes: [
      "数据由 Google Analytics 4 官方 SDK 按请求粒度计算；日期遵循 metadata.timeZone，金额遵循 metadata.currencyCode。",
      "活跃用户数/总用户数不可跨日期或分组直接相加，比率不可直接求和或简单平均；总量请去掉分组维度重新查询。",
      "GA4 与 Adjust 的会话、用户及归因口径独立；对比前须核对时区、事件定义和归因窗口。近期数据可能尚未处理完整。",
      ...(hasMore ? ["当前只返回部分行，不能作为完整总量；可用 nextOffset 继续查询或缩小范围。"] : []),
      ...(response.metadata?.subjectToThresholding ? ["该报告受隐私阈值影响，部分数据可能未展示。"] : []),
      ...(response.metadata?.dataLossFromOtherRow ? ["高基数维度产生 (other) 行，明细可能合并。"] : []),
      ...(response.metadata?.samplingMetadatas?.length ? ["该报告包含抽样数据，请结合 samplingMetadatas 解释结果。"] : []),
    ],
  };
}

export async function executeGa4Request(config: ApiSourceConfig, input: RestRequestInput, maxBytes = 200 * 1024, parentSignal?: AbortSignal): Promise<ApiCallResult> {
  const action = parseGa4Request(config, input);
  const start = Date.now();
  try {
    return await withDeadline(async (signal): Promise<ApiCallResult> => {
      const client = await getClient();
      signal.throwIfAborted();
      // SDK 不再自行重试，交给 Cause 的统一限流/退避层，避免重试次数相乘。
      const options = { timeout: 15_000, retry: null };
      if (action.kind === "metadata") {
        const [metadata] = await client.getMetadata({ name: `${action.property}/metadata` }, options);
        const fields = [
          ...(metadata.dimensions ?? []).map((f) => ({ kind: "dimension", apiName: f.apiName, uiName: f.uiName, description: f.description, customDefinition: f.customDefinition })),
          ...(metadata.metrics ?? []).map((f) => ({ kind: "metric", apiName: f.apiName, uiName: f.uiName, description: f.description, customDefinition: f.customDefinition })),
        ].filter((f) => !action.search || `${f.apiName} ${f.uiName} ${f.description}`.toLowerCase().includes(action.search));
        const body = { property: action.property, fields: fields.slice(0, 80), fieldCount: fields.length, truncated: fields.length > 80, note: "可用 params.search 缩小范围；字段存在不代表任意组合均兼容。" };
        return { status: 200, contentType: "application/json", body, elapsedMs: Date.now() - start, truncated: false };
      }
      const [response] = await client.runReport({ ...action.report, property: action.property, returnPropertyQuota: true }, options);
      const body = ga4ReportTable(response, action, maxBytes);
      return { status: 200, contentType: "application/json", body, elapsedMs: Date.now() - start, truncated: body.truncated };
    }, GOOGLE_OPERATION_TIMEOUT_MS, parentSignal);
  } catch (error) {
    const failure = sdkFailure(error);
    return { status: failure.status, contentType: "application/json", body: { error: failure.message, ...(error instanceof QueryTimeoutError ? { code: error.code } : {}) }, elapsedMs: Date.now() - start, truncated: false,
      ...(error instanceof QueryTimeoutError ? { retryable: false } : {}) };
  }
}
