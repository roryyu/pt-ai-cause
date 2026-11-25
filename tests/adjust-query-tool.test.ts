/**
 * Adjust 源 query_api_source 方法纪律回归测试
 *
 * 背景：Adjust RS API 只接受 GET + query 参数（dimensions/metrics/date_period），
 * worker 曾误套 GA4/Google Ads 的 POST JSON body 模板（start_date/groupings/filters），
 * report 与 csv_report 均被上游 405 拒绝；改 GET 后又混用 Google 式日期写法
 *（缺 date_period、斜杠区间、last_30_days）导致 400。修复：
 * 1. externalSourcesSummary 对 Adjust 域名源注入 ADJUST_QUERY_GUIDE；
 * 2. 工具层本地拦截 POST/body，返回纠正提示，不消耗上游配额与调用预算；
 * 3. 报告终端 date_period 确定性纠正（normalizeAdjustReportParams）：机械可纠正的
 *    直接纠正并留痕 paramFixes，不可纠正的本地拦截。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: {
  DATABASE_URL: "postgresql://localhost/test?schema=cause",
  ASK_LOCAL_SQL_ENABLED: false,
  ADJUST_QUERY_CACHE_ENABLED: false,
} }));
vi.mock("@/lib/db", () => ({ prisma: {
  apiQueryCache: { findUnique: vi.fn(), update: vi.fn(), upsert: vi.fn() },
  dataSource: { findUnique: vi.fn(), findMany: vi.fn() },
} }));

import { createApiSourceTool, externalSourcesSummary } from "@/lib/server/agents/tools";
import { createRunContext } from "@/lib/server/agents/events";
import { normalizeAdjustReportParams } from "@/lib/server/connectors/api-cache";
import type { ApiSourceConfig } from "@/lib/server/connectors/api";

const adjustConfig: ApiSourceConfig = {
  endpoint: "https://automate.adjust.com/reports-service",
  protocol: "rest",
  authType: "bearer",
  authToken: "test-token",
};
const adjustSource = { id: "adjust-test", name: "Adjust 报告服务", type: "api" as const, builtin: false, apiConfig: adjustConfig };
const otherRestSource = { id: "other-test", name: "其他 REST", type: "api" as const, builtin: false, apiConfig: { ...adjustConfig, endpoint: "https://api.example.com/v1" } };

function makeTool(source = adjustSource) {
  const ctx = createRunContext({ questionId: "adjust-task", question: "查 Competitor 计划点击", sink: () => undefined });
  return createApiSourceTool(ctx, [source]);
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("禁止未模拟的网络请求")));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("Adjust 源查询方法纪律", () => {
  it("Adjust 域名源注入 GET-only 查询指南，非 Adjust REST 源不注入", () => {
    const summary = externalSourcesSummary([adjustSource]);
    expect(summary).toContain("只支持 method=\"GET\"");
    expect(summary).toContain("campaign_network__contains");
    expect(summary).toContain("date_period");
    expect(externalSourcesSummary([otherRestSource])).not.toContain("Adjust 报告服务（RS API）");
  });

  it.each([
    { method: "POST" as const, path: "report", body: "{\"start_date\":\"2026-10-26\",\"groupings\":[\"campaign_network\"]}" },
    { method: "POST" as const, path: "csv_report", body: "{\"metrics\":[\"clicks\"]}" },
    { path: "csv_report", body: "{\"metrics\":[\"clicks\"]}" },
  ])("POST/body 本地拦截并给纠正提示，不触发上游：%j", async (input) => {
    const output = await makeTool().invoke({ sourceId: adjustSource.id, ...input });
    const parsed = JSON.parse(String(output));
    expect(parsed.error).toContain("GET");
    expect(parsed.error).toContain("405");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("GET + params 正常放行（过滤走后缀操作符）", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("campaign_network,clicks\nCompetitor_A,10\n", { status: 200, headers: { "content-type": "text/csv" } }));
    const output = await makeTool().invoke({
      sourceId: adjustSource.id,
      method: "GET",
      path: "csv_report",
      params: { dimensions: "campaign_network", metrics: "clicks", date_period: "2026-10-26:2026-11-25", campaign_network__contains: "Competitor" },
    });
    const parsed = JSON.parse(String(output));
    expect(parsed.status).toBe(200);
    expect(parsed.rows).toEqual([{ campaign_network: "Competitor_A", clicks: 10 }]);
    const url = String(vi.mocked(fetch).mock.calls[0]![0]);
    expect(url).toContain("campaign_network__contains=Competitor");
    expect(url).toContain("date_period=2026-10-26%3A2026-11-25");
  });

  it.each([
    ["斜杠区间", "2026-10-26/2026-11-25", "2026-10-26:2026-11-25"],
    ["GA4 式 last_30_days", "last_30_days", "-30d:-1d"],
    ["单绝对日期", "2026-11-24", "2026-11-24:2026-11-24"],
  ])("%s 自动纠正后放行", async (_label, raw, expected) => {
    vi.mocked(fetch).mockResolvedValue(new Response("clicks\n10\n", { status: 200, headers: { "content-type": "text/csv" } }));
    const output = await makeTool().invoke({
      sourceId: adjustSource.id, method: "GET", path: "csv_report",
      params: { dimensions: "day", metrics: "clicks", date_period: raw },
    });
    const parsed = JSON.parse(String(output));
    expect(parsed.status).toBe(200);
    expect(parsed.paramFixes?.length).toBeGreaterThan(0);
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toContain(`date_period=${encodeURIComponent(expected)}`);
  });

  it("start_date/end_date 别名合并为 date_period，别名键不再上游透传", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("clicks\n10\n", { status: 200, headers: { "content-type": "text/csv" } }));
    const output = await makeTool().invoke({
      sourceId: adjustSource.id, method: "GET", path: "csv_report",
      params: { dimensions: "day", metrics: "clicks", start_date: "2026-10-26", end_date: "2026-11-25" },
    });
    expect(JSON.parse(String(output)).status).toBe(200);
    const url = String(vi.mocked(fetch).mock.calls[0]![0]);
    expect(url).toContain("date_period=2026-10-26%3A2026-11-25");
    expect(url).not.toContain("start_date");
    expect(url).not.toContain("end_date");
  });

  it.each([
    [{ dimensions: "day", metrics: "clicks" }, "缺少 date_period"],
    [{ dimensions: "day", metrics: "clicks", date_period: "2026-10-26~2026-11-25" }, "格式不支持"],
    [{ dimensions: "day", metrics: "clicks", date_period: "30daysAgo" }, "格式不支持"],
  ])("不可纠正参数本地拦截，不触发上游：%j", async (params, keyword) => {
    const output = await makeTool().invoke({ sourceId: adjustSource.id, method: "GET", path: "csv_report", params });
    expect(JSON.parse(String(output)).error).toContain(keyword);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("辅助终端 /events 不受 date_period 校验影响", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
    const output = await makeTool().invoke({ sourceId: adjustSource.id, method: "GET", path: "events" });
    expect(JSON.parse(String(output)).status).toBe(200);
  });
});

describe("normalizeAdjustReportParams 纯函数", () => {
  it("合法格式原样保留，无纠正留痕", () => {
    for (const date_period of ["yesterday", "last_month", "2026-10-26:2026-11-25", "-30d:-1d"]) {
      const result = normalizeAdjustReportParams({ dimensions: "day", metrics: "clicks", date_period });
      expect(result).toMatchObject({ ok: true, fixes: [] });
      if (result.ok) expect(result.params.date_period).toBe(date_period);
    }
  });
  it("不修改入参对象（纯函数）", () => {
    const input = { date_period: "2026-10-26/2026-11-25" };
    normalizeAdjustReportParams(input);
    expect(input.date_period).toBe("2026-10-26/2026-11-25");
  });
});