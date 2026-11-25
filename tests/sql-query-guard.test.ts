import { beforeEach, describe, expect, it, vi } from "vitest";

// sql_query 护栏测试：数据落地开关关闭的 Adjust 本地表禁止本地查询，须指路 run_operator 直连 API。
// 隔离 DB/环境，并 stub tools.ts 引入的重型连接器（仅 createSqlQueryTool 被测，其余只需可导入）。
const envMock = vi.hoisted(() => ({
  DATABASE_URL: "postgresql://localhost:5432/test?schema=cause",
  MODEL_GATEWAY_BASE_URL: "https://gateway.test/v1",
  MODEL_GATEWAY_API_KEY: "test-key",
  MODEL_GATEWAY_DEFAULT_MODEL: "test-model",
  MODEL_GATEWAY_TIMEOUT_MS: 30000,
  ADJUST_QUERY_CACHE_ENABLED: false,
  ASK_LOCAL_SQL_ENABLED: true,
}));
vi.mock("@/lib/env", () => ({ env: envMock }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/server/connectors/postgres", () => ({
  executeReadOnlyQuery: vi.fn(async () => ({ columns: ["n"], rows: [{ n: 1 }], rowCount: 1, elapsedMs: 1, truncated: false })),
  introspectSchema: vi.fn(async () => []),
}));
vi.mock("@/lib/server/semantic/model-store", () => ({
  listAllSemanticModels: vi.fn(async () => [ADJUST_MODEL]),
}));
vi.mock("@/lib/server/connectors/datasources", () => ({
  listDataSources: vi.fn(async () => [ADJUST_SOURCE]),
  displayEndpoint: vi.fn(() => "rs.adjust.com"),
}));
vi.mock("@/lib/server/connectors/api-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/connectors/api-cache")>();
  return { ...actual, cachedRestRequest: vi.fn() };
});
vi.mock("@/lib/server/integrations/api-ingest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/integrations/api-ingest")>();
  return { ...actual, persistApiRowsToDataTable: vi.fn(async () => 0) };
});
// 重型连接器 stub（不被本测试触达，仅保证 tools.ts 可导入）
vi.mock("@/lib/server/connectors/web", () => ({ webSearch: vi.fn(), fetchPage: vi.fn() }));
vi.mock("@/lib/server/connectors/api", () => ({ executeGraphQLQuery: vi.fn() }));
vi.mock("@/lib/server/connectors/mcp", () => ({ runMcpReactAgent: vi.fn() }));
vi.mock("@/lib/server/connectors/csv", () => ({ parseCsvTable: vi.fn(), csvTableToObjects: vi.fn() }));
vi.mock("@/lib/server/connectors/google-ads", () => ({ serializeGoogleAdsResult: vi.fn() }));
vi.mock("@/lib/server/connectors/deadline", () => ({
  withDeadline: vi.fn((p: unknown) => p),
  QueryTimeoutError: class extends Error {},
  API_QUERY_TIMEOUT_MS: 30000,
}));

import { createSqlQueryTool } from "@/lib/server/agents/tools";
import { createRunContext } from "@/lib/server/agents/events";
import { executeReadOnlyQuery } from "@/lib/server/connectors/postgres";
import type { SemanticModelDef } from "@/lib/server/semantic/semantic-query";

const queryMock = vi.mocked(executeReadOnlyQuery);

const ADJUST_MODEL: SemanticModelDef = {
  id: "semantic_model_adjust_daily",
  name: "Adjust 投放日指标",
  schema: "data",
  table: "adjust_daily_metrics",
  timeColumn: "stat_date",
  description: "",
  dataSourceId: "data_source_adjust",
  metrics: [
    { id: "clicks", name: "点击量", column: "clicks", agg: "sum", description: "" },
    { id: "installs", name: "安装量", column: "installs", agg: "sum", description: "" },
  ],
  dimensions: [
    { id: "campaign_network", name: "投放计划", column: "campaign_network", description: "" },
    { id: "stat_date", name: "日期", column: "stat_date", apiSlug: "day", description: "" },
  ],
};

const ADJUST_SOURCE = {
  id: "data_source_adjust",
  name: "Adjust 报告服务",
  type: "api",
  apiConfig: { endpoint: "https://rs.adjust.com/reports-service", protocol: "rest", authType: "bearer", authToken: "token" },
  builtin: false,
  status: "active",
} as never;

function makeCtx() {
  return createRunContext({ questionId: "q", question: "q", sink: () => {} });
}

beforeEach(() => {
  envMock.ADJUST_QUERY_CACHE_ENABLED = false;
  queryMock.mockClear();
});

describe("sql_query 护栏（Adjust 数据落地开关关闭）", () => {
  it("拦截对 adjust_daily_metrics 的本地查询，指路 run_operator，且不执行 SQL", async () => {
    const ctx = makeCtx();
    const out = await createSqlQueryTool(ctx).invoke({
      sql: "SELECT campaign_network, SUM(clicks) FROM data.adjust_daily_metrics WHERE campaign_network ILIKE '%xc%' GROUP BY 1",
    });
    const parsed = JSON.parse(out as string);
    expect(parsed.error).toContain("run_operator");
    expect(parsed.error).toContain("campaign_network");
    expect(queryMock).not.toHaveBeenCalled();
    expect(ctx.dataFindings.sql).toHaveLength(0);
  });

  it("开关开启时不拦截，正常执行本地 SQL", async () => {
    envMock.ADJUST_QUERY_CACHE_ENABLED = true;
    const ctx = makeCtx();
    const out = await createSqlQueryTool(ctx).invoke({
      sql: "SELECT SUM(clicks) FROM data.adjust_daily_metrics",
    });
    const parsed = JSON.parse(out as string);
    expect(parsed.error).toBeUndefined();
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("开关关闭但查询本地 BI 表（非 Adjust）不受影响", async () => {
    const ctx = makeCtx();
    const out = await createSqlQueryTool(ctx).invoke({
      sql: "SELECT SUM(clicks) FROM data.channel_daily_metrics",
    });
    const parsed = JSON.parse(out as string);
    expect(parsed.error).toBeUndefined();
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});