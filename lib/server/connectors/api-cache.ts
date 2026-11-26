import { createHash } from "node:crypto";
import { withDeadline, waitWithSignal, QueryTimeoutError, GOOGLE_QUERY_TIMEOUT_MS, API_QUERY_TIMEOUT_MS, CACHE_OPERATION_TIMEOUT_MS } from "./deadline";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { newId } from "@/lib/server/ids";
import { parseGa4Request } from "./google-analytics";
import { parseGoogleAdsRequest } from "./google-ads";
import {
  executeRestRequest, parseBody, resolveRequestUrl,
  type ApiCallResult, type ApiSourceConfig, type RestRequestInput,
} from "./api";

/**
 * API 查询缓存层（design.md 5.1.2 API 适配器「限流、缓存」能力）
 *
 * 落 PostgreSQL（design.md §6.3：Redis 未实施，PG 为当前替代实现）：
 * - cause.api_query_cache：cache_key = sha256(method + 完整 URL + params 按 key 排序)
 * - 命中未过期 → 直接返回（fromCache）；未命中 → 请求后写入
 * - 上游 429/5xx 先指数退避重试（优先遵循 Retry-After），仍失败且存在过期旧值 → 降级返回旧值（stale-while-error）
 * - 简单限流：同一数据源内存最小调用间隔（≥200ms），缓冲 Adjust 50 req/s 速率限制
 *
 * Adjust 查询缓存开关（env.ADJUST_QUERY_CACHE_ENABLED，默认关闭）：
 * 关闭时 Adjust 官方域名源不读不写查询缓存，每次直连上游（限流与退避重试保留）；
 * GA4 / Google Ads / 其他 REST 源不受该开关影响。
 *
 * TTL 策略适配 Adjust 数据 T+1 特性（resolveTtlSeconds，纯函数可单测）：
 * - date_period 结束日早于昨天 → 7 天（历史数据已稳定）
 * - 含今天/昨天（yesterday、-Nd:-1d、today 等）→ 30 分钟（数据仍可能修正）
 * - 未识别 → 默认 1 小时
 *
 * Google Ads 固定 24 小时：条件完全一致（同一数据源 + 解析后的完整操作模板参数）即命中缓存。
 */

/** 带缓存标注的 API 调用结果 */
export interface CachedApiCallResult extends ApiCallResult {
  /** 是否来自缓存（含 stale 降级） */
  fromCache: boolean;
  /** 缓存状态：fresh 命中 / stale 降级旧值 / miss 未命中实时请求 */
  cacheState: "fresh" | "stale" | "miss";
}

/** 缓存包装选项 */
export interface CachedRestRequestOptions {
  /** 数据源 ID（缓存归属与限流维度） */
  sourceId: string;
  /** 覆盖默认 TTL（秒）；缺省按 date_period 推断 */
  ttlSeconds?: number;
  /** 是否跳过限流等待（脚本/测试场景） */
  skipThrottle?: boolean;
  /** 放宽响应体截断限制（字节，缺省 200KB）：供算子落库扩维取数等大明细场景；
   * 未截断的大响应同样回写缓存（fresh 命中可复用，避免重复大请求） */
  maxBodyBytes?: number;
}

const DEFAULT_TTL_SECONDS = 3600;
const STABLE_TTL_SECONDS = 7 * 86400;
const RECENT_TTL_SECONDS = 1800;
/** Google Ads 查询缓存有效期：24 小时（所有操作模板统一） */
const GOOGLE_ADS_TTL_SECONDS = 24 * 3600;
/** 同一数据源最小调用间隔（ms）——单实例内存限流，够用且无外部依赖 */
const MIN_CALL_INTERVAL_MS = 200;
/** 429/5xx 指数退避重试次数（官方建议：指数退避 + 抖动，勿紧密循环重试） */
const MAX_RETRIES = 2;
/** 退避基准与上限（ms） */
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 10_000;
const BACKOFF_JITTER_MS = 250;

/**
 * 计算退避等待时长（含随机抖动，避免多客户端同步重试）：
 * 优先遵循上游 Retry-After（retryAfterMs），否则指数退避 base × 2^attempt，上限 10s（纯函数）
 */
export function computeBackoffMs(attempt: number, retryAfterMs?: number): number {
  const jitter = Math.floor(Math.random() * BACKOFF_JITTER_MS);
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return Math.min(retryAfterMs + jitter, BACKOFF_MAX_MS);
  }
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt + jitter, BACKOFF_MAX_MS);
}

const lastCallAt = new Map<string, number>();

/** Adjust 报告单请求超时：与 adjust-sync 的 REQUEST_TIMEOUT_MS 同口径（单日 5 维实测 ~12-24s，
 * 通用 15s 会把慢报告 abort 成 "This operation was aborted"）；总预算仍受 withDeadline 约束 */
const ADJUST_REQUEST_TIMEOUT_MS = 90_000;

/** 判断 endpoint 是否属于 Adjust 官方域名（adjust.com 及其子域，纯函数） */
export function isAdjustEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return host === "adjust.com" || host.endsWith(".adjust.com");
  } catch {
    return false;
  }
}

/** Adjust 报告终端（必传 date_period；/events、/filters-data 等辅助终端不需要） */
const ADJUST_REPORT_PATHS = new Set(["csv_report", "report", "pivot_report", "parquet_report"]);
export function isAdjustReportPath(path?: string): boolean {
  return ADJUST_REPORT_PATHS.has((path ?? "").replace(/^\/+/, ""));
}

const ABS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Adjust 支持的逻辑日期（doc/Adjust官网API与MCP对接指南 §1.4） */
const ADJUST_LOGICAL_PERIODS = new Set([
  "today", "yesterday", "this_week", "last_week", "this_month", "last_month",
  "this_quarter", "last_quarter", "this_year", "last_year",
]);

export type AdjustParamsResult =
  | { ok: true; params: Record<string, string>; fixes: string[] }
  | { ok: false; error: string };

/**
 * Adjust 报告终端参数纠正（纯函数）：query_api_source 自由填参时模型常混用
 * GA4/Google Ads 日期写法（缺 date_period、斜杠区间、last_30_days）。
 * 机械可纠正的直接纠正（fixes 留痕），不可纠正的本地拦截给提示，不发上游白耗 400。
 */
export function normalizeAdjustReportParams(input: Record<string, string>): AdjustParamsResult {
  const params = { ...input };
  const fixes: string[] = [];
  let period = params.date_period?.trim();
  // GA4/Google Ads 式 start/end 字段 → date_period（两侧均为合法绝对日期才合并，别名键移除）
  if (!period) {
    const from = params.start_date ?? params.startDate ?? params.from;
    const to = params.end_date ?? params.endDate ?? params.to;
    if (from && to && ABS_DATE_RE.test(from) && ABS_DATE_RE.test(to)) {
      period = `${from}:${to}`;
      for (const k of ["start_date", "startDate", "from", "end_date", "endDate", "to"]) delete params[k];
      fixes.push(`start/end 字段已合并为 date_period=${period}`);
    }
  }
  if (!period) {
    return { ok: false, error: "缺少 date_period（Adjust 必填时间参数）。支持：逻辑日期（yesterday/this_month 等）、绝对区间 YYYY-MM-DD:YYYY-MM-DD（冒号分隔）、相对区间 -30d:-1d" };
  }
  // 斜杠分隔的绝对日期 → 冒号
  const slash = period.match(/^(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/);
  if (slash) {
    period = `${slash[1]}:${slash[2]}`;
    fixes.push("日期分隔符 '/' 已纠正为 ':'");
  }
  // GA4 式 last_N_days → Adjust 相对区间（数据 T+1，截至昨日）
  const lastN = period.match(/^last_(\d+)_days?$/i);
  if (lastN) {
    const n = Number(lastN[1]);
    period = `-${n}d:-1d`;
    fixes.push(`last_${n}_days 已纠正为 -${n}d:-1d`);
  }
  // 单个绝对日期 → 同日区间
  if (ABS_DATE_RE.test(period)) {
    fixes.push(`单日期已扩为同日区间 ${period}:${period}`);
    period = `${period}:${period}`;
  }
  const valid = ADJUST_LOGICAL_PERIODS.has(period)
    || /^\d{4}-\d{2}-\d{2}:\d{4}-\d{2}-\d{2}$/.test(period)
    || /^-\d+[dwmy]:-\d+[dwmy]$/.test(period);
  if (!valid) {
    return { ok: false, error: `date_period 格式不支持："${period}"。支持：逻辑日期（yesterday/this_month 等）、YYYY-MM-DD:YYYY-MM-DD（冒号分隔）、-30d:-1d；不支持 last_30_days/30daysAgo 等 GA4 式写法` };
  }
  params.date_period = period;
  return { ok: true, params, fixes };
}

/** 计算缓存键：method + endpoint + path + params（按 key 排序，保证稳定性） */
export function computeApiCacheKey(
  method: string,
  endpoint: string,
  path?: string,
  params?: Record<string, string>,
): string {
  const sortedParams = Object.entries(params ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const raw = `${method.toUpperCase()}|${endpoint}|${path ?? ""}|${sortedParams}`;
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * TTL 推断（纯函数）：按 date_period 判断数据是否已稳定
 * @param today 今日（YYYY-MM-DD，UTC），缺省取当前时间
 */
export function resolveTtlSeconds(params?: Record<string, string>, today?: string): number {
  const period = params?.["date_period"];
  if (!period) return DEFAULT_TTL_SECONDS;
  const todayStr = today ?? new Date().toISOString().slice(0, 10);

  // 别名区间：today 实时性强 → 短缓存；yesterday/last_* 含近日 → 短缓存
  if (/^today$/i.test(period)) return RECENT_TTL_SECONDS;
  if (/^(yesterday|last_|this_|-)/i.test(period)) {
    // 相对区间 -Nd:-Md：结束日 offset ≥ 2 天视为稳定
    const relMatch = period.match(/^-(\d+)d:-(\d+)d$/);
    if (relMatch) {
      return Number(relMatch[2]) >= 2 ? STABLE_TTL_SECONDS : RECENT_TTL_SECONDS;
    }
    return RECENT_TTL_SECONDS;
  }
  // 显式日期区间 YYYY-MM-DD:YYYY-MM-DD 或单日：结束日早于昨天 → 长缓存
  const dates = period.split(":").filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (dates.length > 0) {
    const end = dates[dates.length - 1]!;
    const yesterday = new Date(`${todayStr}T00:00:00Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    return end < yesterday.toISOString().slice(0, 10) ? STABLE_TTL_SECONDS : RECENT_TTL_SECONDS;
  }
  return DEFAULT_TTL_SECONDS;
}

/** 限流等待：同一 sourceId 两次调用间隔 ≥ MIN_CALL_INTERVAL_MS */
async function throttle(sourceId: string, signal: AbortSignal): Promise<void> {
  const last = lastCallAt.get(sourceId) ?? 0;
  const wait = MIN_CALL_INTERVAL_MS - (Date.now() - last);
  lastCallAt.set(sourceId, Date.now() + Math.max(0, wait));
  if (wait > 0) await waitWithSignal(wait, signal);
}

/**
 * 带缓存与限流的 REST 请求（query_api_source 工具与算子统一取数分流层的统一入口）
 * 缓存读写失败时降级为直连（console.warn，不阻断调用）
 */
export async function cachedRestRequest(
  config: ApiSourceConfig,
  input: RestRequestInput,
  options: CachedRestRequestOptions,
): Promise<CachedApiCallResult> {
  const startedAt = Date.now();
  const timeout = config.protocol === "ga4" || config.protocol === "google_ads" ? GOOGLE_QUERY_TIMEOUT_MS : API_QUERY_TIMEOUT_MS;
  try {
    return await withDeadline((signal) => cachedRequestWithinDeadline(config, input, options, signal), timeout);
  } catch (error) {
    if (!(error instanceof QueryTimeoutError)) throw error;
    return { status: 504, body: { error: error.message, code: error.code }, contentType: "application/json",
      elapsedMs: Date.now() - startedAt, truncated: false, retryable: false, fromCache: false, cacheState: "miss" };
  }
}

async function cachedRequestWithinDeadline(
  config: ApiSourceConfig, input: RestRequestInput, options: CachedRestRequestOptions, signal: AbortSignal,
): Promise<CachedApiCallResult> {
  // GA4 的 POST 请求必须按完整报告参数、属性和数据源隔离，不能仅按 URL 缓存。
  const ga4Action = config.protocol === "ga4" ? parseGa4Request(config, input) : null;
  const adsAction = config.protocol === "google_ads" ? parseGoogleAdsRequest(config, input) : null;
  const cacheKey = adsAction
    ? createHash("sha256").update(JSON.stringify({ version: "google-ads-v26-1", sourceId: options.sourceId, action: adsAction })).digest("hex")
    : ga4Action
    ? createHash("sha256").update(JSON.stringify({ version: "ga4-v1", sourceId: options.sourceId, action: ga4Action })).digest("hex")
    : computeApiCacheKey(input.method, config.endpoint, input.path, input.params);
  const url = resolveRequestUrl(config.endpoint, input.path, input.params);
  // Adjust 查询缓存开关（默认关闭）：关闭时不读不写缓存，始终直连上游
  const cacheEnabled = !isAdjustEndpoint(config.endpoint) || env.ADJUST_QUERY_CACHE_ENABLED;

  // 1. 查缓存（fresh 直接返回）
  let cached: { body: string; contentType: string; status: number; elapsedMs: number; expiresAt: Date } | null = null;
  if (cacheEnabled) try {
    const record = await withDeadline(() => prisma.apiQueryCache.findUnique({ where: { cacheKey } }), CACHE_OPERATION_TIMEOUT_MS, signal);
    signal.throwIfAborted();
    if (record) {
      cached = record;
      if (record.expiresAt.getTime() > Date.now()) {
        // 计数失败或卡住不能丢弃已命中的有效结果。
        await withDeadline(() => prisma.apiQueryCache.update({
          where: { cacheKey }, data: { hitCount: { increment: 1 } },
        }), CACHE_OPERATION_TIMEOUT_MS, signal).catch(() => {});
        signal.throwIfAborted();
        return {
          status: record.status,
          contentType: record.contentType,
          body: parseBody(record.body, record.contentType),
          elapsedMs: 0,
          truncated: false,
          fromCache: true,
          cacheState: "fresh",
        };
      }
    }
  } catch (error) {
    signal.throwIfAborted();
    console.warn("[api-cache] 缓存读取失败，降级直连:", error instanceof Error ? error.message : error);
  }

  // 2. 未命中 → 限流 + 实时请求（429/5xx 指数退避重试，优先遵循 Retry-After）
  signal.throwIfAborted();
  if (!options.skipThrottle) await throttle(options.sourceId, signal);
  let result: ApiCallResult;
  // Adjust 官方域名源放宽单请求超时（其他 REST 源维持缺省 15s）
  const requestOpts = {
    maxBodyBytes: options.maxBodyBytes,
    signal,
    timeoutMs: isAdjustEndpoint(config.endpoint) ? ADJUST_REQUEST_TIMEOUT_MS : undefined,
  };
  try {
    result = await executeRestRequest(config, input, requestOpts);
    for (let attempt = 0; attempt < MAX_RETRIES && result.retryable !== false && (result.status === 429 || result.status >= 500); attempt++) {
      await waitWithSignal(computeBackoffMs(attempt, result.retryAfterMs), signal);
      signal.throwIfAborted();
      result = await executeRestRequest(config, input, requestOpts);
    }
  } catch (error) {
    signal.throwIfAborted();
    // 网络异常且有旧缓存 → stale 降级
    if (cached && !adsAction) {
      return {
        status: cached.status,
        contentType: cached.contentType,
        body: parseBody(cached.body, cached.contentType),
        elapsedMs: 0,
        truncated: false,
        fromCache: true,
        cacheState: "stale",
      };
    }
    throw error;
  }

  signal.throwIfAborted();
  // 3. 上游 429/5xx 且有旧缓存 → stale 降级
  if (result.retryable !== false && (result.status === 429 || result.status >= 500) && cached && !adsAction) {
    return { ...result, fromCache: true, cacheState: "stale", body: parseBody(cached.body, cached.contentType), status: cached.status };
  }

  // 4. 成功响应（2xx）写入缓存；body 以原始文本存储
  if (cacheEnabled && result.status >= 200 && result.status < 300 && !result.truncated) {
    const ttl = options.ttlSeconds ?? (adsAction ? GOOGLE_ADS_TTL_SECONDS : ga4Action ? 300 : resolveTtlSeconds(input.params));
    const rawBody = typeof result.body === "string" ? result.body : JSON.stringify(result.body);
    try {
      await withDeadline(() => prisma.apiQueryCache.upsert({
        where: { cacheKey },
        create: {
          id: newId("api_cache"),
          sourceId: options.sourceId,
          cacheKey,
          method: input.method,
          url,
          status: result.status,
          contentType: result.contentType,
          body: rawBody,
          elapsedMs: result.elapsedMs,
          expiresAt: new Date(Date.now() + ttl * 1000),
        },
        update: {
          status: result.status,
          contentType: result.contentType,
          body: rawBody,
          elapsedMs: result.elapsedMs,
          hitCount: 0,
          expiresAt: new Date(Date.now() + ttl * 1000),
        },
      }), CACHE_OPERATION_TIMEOUT_MS, signal);
    } catch (error) {
      signal.throwIfAborted();
      console.warn("[api-cache] 缓存写入失败（不影响本次结果）:", error instanceof Error ? error.message : error);
    }
  }
  return { ...result, fromCache: false, cacheState: "miss" };
}
