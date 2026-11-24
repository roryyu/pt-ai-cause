import { z } from "zod";
import type { ApiCallResult, ApiSourceConfig, RestRequestInput } from "./api";
import { withDeadline, QueryTimeoutError, GOOGLE_INITIALIZATION_TIMEOUT_MS, GOOGLE_OPERATION_TIMEOUT_MS } from "./deadline";

export const GOOGLE_ADS_ENDPOINT = "https://googleads.googleapis.com";
const API_ROOT = `${GOOGLE_ADS_ENDPOINT}/v26`;
export const GoogleAdsCustomerIdSchema = z.string().regex(/^\d{10}$/, "Google Ads Customer ID 必须是去掉连字符的 10 位数字");
const IdSchema = z.string().regex(/^[1-9]\d{0,18}$/, "ID 必须为数字");
const DateSchema = z.iso.date();
const InstallResourceSchema = z.string().regex(/^customers\/\d{10}\/conversionActions\/[1-9]\d{0,18}$/);
export const INSTALL_TYPES = [
  "GOOGLE_PLAY_DOWNLOAD", "FIREBASE_ANDROID_FIRST_OPEN", "FIREBASE_IOS_FIRST_OPEN",
  "THIRD_PARTY_APP_ANALYTICS_ANDROID_FIRST_OPEN", "THIRD_PARTY_APP_ANALYTICS_IOS_FIRST_OPEN",
  "ANDROID_INSTALLS_ALL_OTHER_APPS",
] as const;
const INSTALL_FILTER = `conversion_action.type IN (${INSTALL_TYPES.map((t) => `'${t}'`).join(", ")})`;
const scopeFields = {
  customerId: GoogleAdsCustomerIdSchema.optional(),
  loginCustomerId: z.union([GoogleAdsCustomerIdSchema, z.literal("")]).optional(),
};
const pageFields = { afterId: IdSchema.optional(), limit: z.number().int().min(1).max(100).default(50) };
const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accounts"), ...pageFields }).strict(),
  z.object({ action: z.literal("account"), ...scopeFields }).strict(),
  z.object({ action: z.literal("clients"), ...scopeFields, ...pageFields }).strict(),
  z.object({ action: z.literal("campaigns"), ...scopeFields, ...pageFields }).strict(),
  z.object({ action: z.literal("conversionActions"), ...scopeFields, ...pageFields }).strict(),
  z.object({
    action: z.literal("report"), ...scopeFields,
    campaignId: IdSchema, startDate: DateSchema, endDate: DateSchema,
    installAction: InstallResourceSchema.optional(),
  }).strict().refine((v) => v.endDate >= v.startDate &&
    Date.parse(v.endDate) - Date.parse(v.startDate) < 366 * 86400000,
  "日期起止顺序必须正确，单次最多 366 天"),
]);

export function googleAdsSourceConfig(customerId?: string, loginCustomerId?: string) {
  return {
    endpoint: GOOGLE_ADS_ENDPOINT, protocol: "google_ads" as const, authType: "adc" as const,
    ...(customerId ? { customerId: GoogleAdsCustomerIdSchema.parse(customerId) } : {}),
    ...(loginCustomerId ? { loginCustomerId: GoogleAdsCustomerIdSchema.parse(loginCustomerId) } : {}),
  };
}

/** 请求只接受操作模板，账户切换不允许带入主机、凭证或自由 GAQL。 */
export function parseGoogleAdsRequest(config: ApiSourceConfig, input: RestRequestInput) {
  if (config.endpoint !== GOOGLE_ADS_ENDPOINT || config.authType !== "adc" || config.authToken || config.headers || config.apiKeyHeader) {
    throw new Error("Google Ads 仅支持固定官方 endpoint 与服务端 ADC");
  }
  if (input.method !== "POST" || Object.keys(input.params ?? {}).length) throw new Error("Google Ads 使用 POST + JSON body，不接受 query 参数");
  if (Buffer.byteLength(JSON.stringify(input.body ?? {}), "utf8") > 20_000) throw new Error("Google Ads 请求体不得超过 20KB");
  const body = z.record(z.string(), z.unknown()).parse(input.body ?? {});
  const parsed = ActionSchema.parse({ ...body, action: input.path });
  if (parsed.action === "accounts") return parsed;
  return {
    ...parsed,
    customerId: GoogleAdsCustomerIdSchema.parse(parsed.customerId ?? config.customerId),
    loginCustomerId: GoogleAdsCustomerIdSchema.optional().parse((parsed.loginCustomerId ?? config.loginCustomerId) || undefined),
  };
}

let authPromise: Promise<InstanceType<typeof import("google-auth-library").GoogleAuth>> | undefined;
function getAuth() {
  if (!authPromise) {
    const pending = withDeadline(async (signal) => {
      const { GoogleAuth } = await import("google-auth-library");
      signal.throwIfAborted();
      const auth = new GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/adwords"],
        clientOptions: { transporterOptions: { retry: false, timeout: 15_000 } },
      });
      await auth.getClient();
      signal.throwIfAborted();
      return auth;
    }, GOOGLE_INITIALIZATION_TIMEOUT_MS);
    authPromise = pending;
    void pending.catch(() => { if (authPromise === pending) authPromise = undefined; });
  }
  return authPromise;
}

type Row = {
  customer?: { id?: string; descriptiveName?: string; manager?: boolean; currencyCode?: string; timeZone?: string; conversionTrackingSetting?: { googleAdsConversionCustomer?: string } };
  customerClient?: { id?: string; descriptiveName?: string; manager?: boolean; status?: string; level?: string; currencyCode?: string; timeZone?: string };
  campaign?: { id?: string; name?: string; status?: string };
  conversionAction?: { id?: string; resourceName?: string; name?: string; type?: string; status?: string };
  segments?: { date?: string };
  metrics?: { impressions?: string; clicks?: string; ctr?: number; costMicros?: string; allConversions?: number };
};
const ACCESS_HELP = [
  { label: "在凭证所属 Cloud 项目启用 Google Ads API", url: "https://console.cloud.google.com/apis/library/googleads.googleapis.com" },
  { label: "检查 Google Ads API 访问等级；真实投放账户需要生产访问资格", url: "https://console.cloud.google.com/google/ads-apis/overview" },
  { label: "Google Ads → 管理 → 访问权限和安全 → 用户，添加 JSON 中的 client_email（只读）；经经理账户访问时填写经理 ID", url: "https://ads.google.com/" },
];

/** 不透传 Gaxios 错误对象（其中可能含 Authorization、私钥与请求配置）。 */
export function googleAdsError(error: unknown) {
  if (error instanceof QueryTimeoutError) return { status: 504, retryable: false, body: { error: error.message, code: error.code, codes: [error.code], help: [] } };
  const e = error as { response?: { status?: number; data?: { error?: { status?: string; details?: Array<{ reason?: string; errors?: Array<{ errorCode?: Record<string, string> }> }> } } }; code?: string };
  const remote = e?.response?.data?.error;
  const codes = [remote?.status, ...(remote?.details ?? []).flatMap((d) => [d.reason, ...(d.errors ?? []).flatMap((v) => Object.values(v.errorCode ?? {}))])]
    .filter((v): v is string => typeof v === "string" && /^[A-Z][A-Z0-9_]{1,100}$/.test(v));
  const authFailure = error instanceof Error && /credential|invalid_grant|ENOENT|private.key/i.test(error.message);
  const status = e?.response?.status ?? (authFailure ? 401 : 502);
  const disabled = codes.includes("SERVICE_DISABLED") || codes.includes("API_DISABLED");
  const text = disabled ? "Google Ads API 尚未启用" : status === 401 ? "ADC 认证失败，请检查服务端凭证及其有效性" : status === 403 ? "Google Ads 拒绝访问，请核对 API 访问等级、广告账户授权及经理账户关系" : "Google Ads 请求失败，请根据错误代码核对查询与账户配置";
  return { status, body: { error: text, codes, help: status === 401 || status === 403 ? ACCESS_HELP : [] } };
}

function safeNumber(value: string | number | undefined, integer = false) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER || (integer && !Number.isSafeInteger(n))) throw new Error("上游数值超出安全精度");
  return n;
}
const text = (value: string | undefined) => (value ?? "").slice(0, 300);

export async function executeGoogleAdsRequest(config: ApiSourceConfig, input: RestRequestInput, parentSignal?: AbortSignal): Promise<ApiCallResult> {
  const action = parseGoogleAdsRequest(config, input);
  const start = Date.now();
  const base = { contentType: "application/json", truncated: false };
  let currentAuth: ReturnType<typeof getAuth> | undefined;
  try {
    return await withDeadline(async (signal): Promise<ApiCallResult> => {
      currentAuth = getAuth();
      const auth = await currentAuth;
      signal.throwIfAborted();
      async function call<T>(path: string, query?: string, loginCustomerId?: string): Promise<T> {
        signal.throwIfAborted();
        const result = await auth.request<T>({
          url: `${API_ROOT}/${path}`, method: query ? "POST" : "GET",
          ...(query ? { data: { query } } : {}),
          headers: loginCustomerId ? { "login-customer-id": loginCustomerId } : {},
          timeout: 15_000, signal, retry: false,
          maxContentLength: 4 * 1024 * 1024,
        });
        return result.data;
      }
      async function search(customerId: string, query: string, loginCustomerId?: string) {
        const data = await call<{ results?: Row[]; nextPageToken?: string }>(`customers/${customerId}/googleAds:search`, query, loginCustomerId);
        if (data.nextPageToken) throw new Error("上游响应超过单次安全查询上限");
        return data.results ?? [];
      }
      let body: Record<string, unknown>;
      if (action.action === "accounts") {
        const data = await call<{ resourceNames?: string[] }>("customers:listAccessibleCustomers");
        const ids = (data.resourceNames ?? []).map((s) => GoogleAdsCustomerIdSchema.parse(s.replace(/^customers\//, "")))
          .sort().filter((id) => !action.afterId || BigInt(id) > BigInt(action.afterId));
        const rows = ids.slice(0, action.limit).map((id) => ({ id }));
        body = { rows, nextAfterId: ids.length > rows.length ? rows.at(-1)?.id : null,
          note: "仅列出身份直接可访问的账户；用 account 判断是否经理，再用 clients 查询子账户。",
          ...(ids.length === 0 && !action.afterId ? { warning: "没有可见 Google Ads 账户，请给服务账号添加广告账户只读权限", help: ACCESS_HELP } : {}) };
      } else {
        const cid = action.customerId!;
        const login = action.loginCustomerId;
        const accountRows = await search(cid, "SELECT customer.id, customer.descriptive_name, customer.manager, customer.currency_code, customer.time_zone, customer.conversion_tracking_setting.google_ads_conversion_customer FROM customer LIMIT 1", login);
        const account = accountRows[0]?.customer;
        if (!account?.id) throw new Error("未返回账户信息");
        const trackingCustomer = account.conversionTrackingSetting?.googleAdsConversionCustomer?.replace(/^customers\//, "") || cid;
        GoogleAdsCustomerIdSchema.parse(trackingCustomer);
        const meta = { customerId: cid, loginCustomerId: login ?? null, name: text(account.descriptiveName), manager: account.manager ?? false, currencyCode: account.currencyCode, timeZone: account.timeZone, conversionCustomerId: trackingCustomer };
        if (action.action === "account") {
          body = { account: meta, rows: [meta] };
        } else if (action.action === "report") {
          if (account.manager) return { ...base, status: 400, elapsedMs: Date.now() - start, body: { error: "经理账户不能查询投放报表，请先用 clients 选择子账户" } };
          let installAction: Row["conversionAction"] | null = null;
          if (action.installAction) {
            if (!action.installAction.startsWith(`customers/${trackingCustomer}/`)) return { ...base, status: 400, elapsedMs: Date.now() - start, body: { error: "安装动作不属于该账户的转化跟踪账户" } };
            const actions = await search(trackingCustomer, `SELECT conversion_action.id, conversion_action.resource_name, conversion_action.name, conversion_action.type, conversion_action.status FROM conversion_action WHERE conversion_action.resource_name = '${action.installAction}' AND ${INSTALL_FILTER} LIMIT 1`, login);
            installAction = actions[0]?.conversionAction ?? null;
            if (!installAction) return { ...base, status: 400, elapsedMs: Date.now() - start, body: { error: "所选动作不存在或不是安装/首次打开转化，不能以总转化代替安装量" } };
          }
          const filter = `campaign.id = ${action.campaignId} AND segments.date BETWEEN '${action.startDate}' AND '${action.endDate}'`;
          const daily = await search(cid, `SELECT campaign.id, campaign.name, campaign.status, segments.date, metrics.impressions, metrics.clicks, metrics.ctr, metrics.cost_micros FROM campaign WHERE ${filter} ORDER BY segments.date LIMIT 367`, login);
          const conversions = action.installAction ? await search(cid, `SELECT segments.date, segments.conversion_action, metrics.all_conversions FROM campaign WHERE ${filter} AND segments.conversion_action = '${action.installAction}' ORDER BY segments.date LIMIT 367`, login) : [];
          const dailyMap = new Map(daily.map((r) => [r.segments?.date, r]));
          const installsMap = new Map(conversions.map((r) => [r.segments?.date, safeNumber(r.metrics?.allConversions)]));
          const days = [...new Set([...dailyMap.keys(), ...installsMap.keys()])].filter((d): d is string => !!d).sort();
          const rows = days.map((date) => {
            const r = dailyMap.get(date);
            const impressions = safeNumber(r?.metrics?.impressions, true);
            const clicks = safeNumber(r?.metrics?.clicks, true);
            const cost = safeNumber(r?.metrics?.costMicros, true) / 1_000_000;
            const installs = action.installAction ? installsMap.get(date) ?? 0 : null;
            return { date, campaignId: action.campaignId, campaignName: text(r?.campaign?.name), status: r?.campaign?.status ?? null,
              impressions, clicks, ctr: impressions ? clicks / impressions : 0, cost, installs, cpi: installs && installs > 0 ? cost / installs : null };
          });
          body = { account: meta, rows, startDate: action.startDate, endDate: action.endDate, installAction,
            note: "ctr 为比例（乘 100 显示百分比）；金额为账户币种。安装量为所选单一安装/首次打开动作的 all_conversions，按广告互动日期归因，可能包含浏览归因及小数信用；不等同商店下载或 Adjust 安装。未选动作时 installs/cpi 为 null。无指标日由 Google 省略。" };
        } else {
          const limit = action.limit;
          let rows: Record<string, unknown>[];
          const after = (field: string) => action.afterId ? ` AND ${field} > ${action.afterId}` : "";
          if (action.action === "clients") {
            if (!account.manager) return { ...base, status: 400, elapsedMs: Date.now() - start, body: { error: "该账户不是经理账户" } };
            rows = (await search(cid, `SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.status, customer_client.level FROM customer_client WHERE customer_client.level > 0${after("customer_client.id")} ORDER BY customer_client.id LIMIT ${limit + 1}`, login)).map((r) => ({
              id: r.customerClient?.id, name: text(r.customerClient?.descriptiveName), manager: r.customerClient?.manager ?? false, status: r.customerClient?.status,
            }));
          } else if (action.action === "campaigns") {
            if (account.manager) return { ...base, status: 400, elapsedMs: Date.now() - start, body: { error: "请先从经理账户选择实际投放子账户" } };
            rows = (await search(cid, `SELECT campaign.id, campaign.name, campaign.status FROM campaign WHERE campaign.status != 'REMOVED'${after("campaign.id")} ORDER BY campaign.id LIMIT ${limit + 1}`, login)).map((r) => ({ id: r.campaign?.id, name: text(r.campaign?.name), status: r.campaign?.status }));
          } else {
            rows = (await search(trackingCustomer, `SELECT conversion_action.id, conversion_action.resource_name, conversion_action.name, conversion_action.type, conversion_action.status FROM conversion_action WHERE ${INSTALL_FILTER}${after("conversion_action.id")} ORDER BY conversion_action.id LIMIT ${limit + 1}`, login)).map((r) => ({
              id: r.conversionAction?.id, resourceName: r.conversionAction?.resourceName, name: text(r.conversionAction?.name), type: r.conversionAction?.type, status: r.conversionAction?.status,
            }));
          }
          const more = rows.length > limit;
          rows = rows.slice(0, limit);
          body = { account: meta, rows, nextAfterId: more ? rows.at(-1)?.id : null };
        }
      }
      const rows = body.rows as Record<string, unknown>[];
      return { ...base, status: 200, elapsedMs: Date.now() - start, body: { ...body, operation: action.action, columns: Object.keys(rows[0] ?? {}), returnedRows: rows.length } };
    }, GOOGLE_OPERATION_TIMEOUT_MS, parentSignal);
  } catch (error) {
    if (error instanceof QueryTimeoutError && authPromise === currentAuth) authPromise = undefined;
    const failure = googleAdsError(error);
    return { ...base, ...failure, elapsedMs: Date.now() - start };
  }
}

/** 工具输出按完整行裁剪，并返回可续查的 ID 或起始日期。 */
export function serializeGoogleAdsResult(result: ApiCallResult & { fromCache?: boolean; cacheState?: string }, source: { id: string; name: string }) {
  const body = { ...(result.body as Record<string, unknown>) };
  const rows = Array.isArray(body.rows) ? [...body.rows] as Record<string, unknown>[] : [];
  if (Array.isArray(body.rows)) body.rows = rows;
  const payload = { ...body, sourceId: source.id, sourceName: source.name, status: result.status, fromCache: result.fromCache, cacheState: result.cacheState } as Record<string, unknown>;
  while (JSON.stringify(payload).length > 19_000 && rows.length) {
    const removed = rows.pop();
    payload.truncated = true;
    payload.returnedRows = rows.length;
    if (body.operation === "report") payload.nextStartDate = removed?.date;
    else payload.nextAfterId = rows.at(-1)?.id ?? null;
  }
  const output = JSON.stringify(payload);
  return output.length <= 20_000 ? output : JSON.stringify({ error: "Google Ads 结果元信息过大，请缩小查询范围", truncated: true });
}
