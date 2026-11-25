import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { executeReadOnlyQuery, introspectSchema } from "@/lib/server/connectors/postgres";
import { webSearch, fetchPage } from "@/lib/server/connectors/web";
import { executeGraphQLQuery } from "@/lib/server/connectors/api";
import { withDeadline, QueryTimeoutError, API_QUERY_TIMEOUT_MS } from "@/lib/server/connectors/deadline";
import { cachedRestRequest, isAdjustEndpoint, isAdjustReportPath, normalizeAdjustReportParams } from "@/lib/server/connectors/api-cache";
import { parseCsvTable, csvTableToObjects } from "@/lib/server/connectors/csv";
import { runMcpReactAgent } from "@/lib/server/connectors/mcp";
import { displayEndpoint, listDataSources, type ResolvedDataSource } from "@/lib/server/connectors/datasources";
import { runOperator } from "@/lib/server/operators/registry";
import {
  operatorMetricCatalogSummary, operatorDimensionCatalogSummary, runtimeSemanticModels,
} from "@/lib/server/operators/data-operators";
import { env } from "@/lib/env";
import { DEMO_SEMANTIC_MODELS, semanticContextSummary, type SemanticModelDef } from "@/lib/server/semantic/semantic-query";
import type { AgentRunContext, ChartSpec, TablePayload } from "./events";
import { nextStepId } from "./events";
import { GA4_QUERY_GUIDE, GOOGLE_ADS_QUERY_GUIDE, ADJUST_QUERY_GUIDE, API_FAILURE_CONTINUE_HINT, API_EMPTY_CONTINUE_HINT } from "./prompts";
import { serializeGoogleAdsResult } from "@/lib/server/connectors/google-ads";

/**
 * Agent 工具集（LangChain tools，供 LangGraph Agent 调用）
 *
 * 数据分析工具：run_operator / sql_query / inspect_schema / show_table / generate_chart
 * 研究工具：    web_search / fetch_page / record_finding
 * 外部数据源：  query_api_source / query_mcp_source（按已注册数据源动态启用）
 *
 * 每个工具执行时通过 ctx.sink 实时推送 tool_call / tool_result 事件，
 * 前端可完整展示 Agent 的每一步动作与产出。
 */

// ─── 数据分析工具 ─────────────────────────────────────────────────────────────

/** 数据分析算子 ID 枚举（与 registry 数据算子保持一致） */
const DATA_OPERATOR_IDS = ["aggregate", "timeseries", "anomaly", "filter", "transform", "join"] as const;

/** run_operator 工具描述：算子清单 + 指标/维度目录（由语义层动态生成，缺省内置模型） */
export function runOperatorToolDescription(models?: SemanticModelDef[]): string {
  return `执行预置数据分析算子（算子优先原则：标准分析动作必须先调算子，不要自己拼 SQL）。可用算子：
- aggregate 分组聚合：input {metric, groupBy, dimensionValue?, from?, to?}，groupBy 必须是该指标所属模型的维度，可选按维度值过滤，返回分组聚合结果（降序）
- timeseries 时序分析：input {metric, granularity?(day/week/month，默认 month), from?, to?}，输出逐期数值与环比 mom_pct / 同比 yoy_pct
- anomaly 异常检测：input {metric, threshold?(1-5，默认 2), from?, to?}，基于 28 日滚动窗口 Z-Score 检出异常日
- filter 条件下钻：input {model, filters?(维度Id到维度值的对象，如 {"ad_channel":"Meta"}), from?, to?}，按模型全维度分组输出全部指标，用于下钻验证
- transform 派生指标：input {from?, to?}，按月输出投放归因派生指标：CPI（花费/下载）、CPM、CTR、点击注册率、FD 率、RD 率、ROI（充值金额/花费）
- join 跨源关联：input {from?, to?}，投放日汇总 × 投放计划表，按渠道×承接端对比实际效果与计划累计口径
所有算子只按「语义指标 key + 维度 id」取数：数据源路由（本地 PG 库 / 外部 API 源的本地缓存+API 直查）由算子依据指标所属数据源自动决定，你无需也不能指定 sourceId、path 或上游 slug。查外部 API 源（如 Adjust）的最新或明细数据同样用 aggregate、filter——指定语义指标 key 与维度 id 即可，目标日期超出本地范围时算子会自动直连 API 取回。
可用指标（metric 参数取值·各数据源平等构成统一数据集合）。指标 id 若形如「表名.指标」（如 adjust_daily_metrics.impressions）表示该指标同时存在于多个数据源，须带表名限定精确指定来源；裸 id（如 spend）表示全局唯一。同名指标分属不同源时是彼此独立的数据（如 BI 同步的 channel_daily_metrics.impressions 与 Adjust 归因的 adjust_daily_metrics.impressions），无优先级——问题涉及该指标时须用各限定 key 每个来源分别取数，最后汇总对比，不得只取其一：
${operatorMetricCatalogSummary(models)}
各模型可用维度（aggregate 的 groupBy / filter 的 filters 键）：
${operatorDimensionCatalogSummary(models)}
日期格式 YYYY-MM-DD。`;
}

/** run_operator 工具描述（运行时全量语义模型：内置 + DB 自定义） */
export async function runtimeRunOperatorToolDescription(): Promise<string> {
  return runOperatorToolDescription(await runtimeSemanticModels());
}

/** 执行数据分析算子（算子优先于自由 SQL，结果自动注册为表格） */
export function createRunOperatorTool(ctx: AgentRunContext, description?: string) {
  return tool(
    async (input: { operatorId: (typeof DATA_OPERATOR_IDS)[number]; input: Record<string, unknown> }) => {
      const stepId = nextStepId(ctx);
      const startedAt = Date.now();
      ctx.sink({ type: "tool_call", stepId, tool: "run_operator", input });
      try {
        const result = await runOperator(input.operatorId, input.input);
        if (!result.ok) {
          ctx.sink({
            type: "tool_result", stepId, tool: "run_operator",
            summary: `算子失败: ${result.error}`, elapsedMs: Date.now() - startedAt,
          });
          return JSON.stringify({
            error: result.error,
            hint: "请核对算子参数：metric 必须在指标目录内，groupBy 必须是该指标所属模型的维度，日期格式 YYYY-MM-DD",
          });
        }
        if (result.sql) ctx.dataFindings.sql.push(result.sql);
        // 结果非空且 ≤ 60 行才注册为表格（空结果不下发，避免前端渲染「暂无数据」空卡）
        if (result.rows.length > 0 && result.rows.length <= 60) {
          const table: TablePayload = {
            title: `算子结果 · ${input.operatorId}`,
            columns: result.columns,
            rows: result.rows,
            note: `${result.rowCount} 行 · ${result.elapsedMs}ms`,
          };
          ctx.dataFindings.tables.push(table);
          ctx.sink({ type: "table", table });
        }
        ctx.sink({
          type: "tool_result", stepId, tool: "run_operator",
          summary: `算子 ${input.operatorId} 返回 ${result.rowCount} 行`,
          elapsedMs: Date.now() - startedAt,
        });
        const preview = result.rows.slice(0, 100);
        return JSON.stringify({
          columns: result.columns,
          rowCount: result.rowCount,
          rows: preview,
          notes: result.notes,
          note: result.rowCount > 100 ? "结果超 100 行已截断" : "",
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ctx.sink({ type: "tool_result", stepId, tool: "run_operator", summary: `失败: ${msg}` });
        return JSON.stringify({ error: msg });
      }
    },
    {
      name: "run_operator",
      description: description ?? runOperatorToolDescription(),
      schema: z.object({
        operatorId: z.enum(DATA_OPERATOR_IDS).describe("算子 ID：aggregate/timeseries/anomaly/filter/transform/join"),
        input: z.record(
          z.string(),
          z.union([z.string(), z.number(), z.boolean(), z.record(z.string(), z.string())]),
        ).describe("算子参数（按工具描述中各算子的 input 结构传参）"),
      }),
    },
  );
}

/** 只读 SQL 查询（data schema） */
export function createSqlQueryTool(ctx: AgentRunContext) {
  return tool(
    async (input: { sql: string }) => {
      const stepId = nextStepId(ctx);
      const startedAt = Date.now();
      ctx.sink({ type: "tool_call", stepId, tool: "sql_query", input });
      try {
        // 护栏：数据落地开关关闭的 Adjust 本地表无有效数据，禁止 sql_query 本地查询（会返回空结果误导），
        // 拒绝并指路 run_operator 直连 API，避免模型查本地空表后误判「无数据/不存在」而放弃取数
        const forbidden = await localQueryForbiddenTables();
        const hit = [...forbidden].find((t) => new RegExp(`\\b${t}\\b`, "i").test(input.sql));
        if (hit) {
          const msg = `表 ${hit} 的数据落地开关已关闭（ADJUST_QUERY_CACHE_ENABLED=false），本地无有效数据，不能用 sql_query 本地查询。请改用 run_operator 直连 Adjust API：用该表语义指标 key（如 adjust_daily_metrics.clicks）调 aggregate/filter/timeseries/anomaly；需按计划/渠道等维度筛选或模糊匹配名称时，用 aggregate 的 groupBy 传该维度 id（如 campaign_network）取回各维度值明细，再在返回行内匹配目标名称，不要用 sql_query 查本地表。`;
          ctx.sink({ type: "tool_result", stepId, tool: "sql_query", summary: `拒绝本地查询 ${hit}（应经算子直连 API）` });
          return JSON.stringify({ error: msg });
        }
        const result = await executeReadOnlyQuery(env.DATABASE_URL, input.sql, {
          maxRows: 300,
          timeoutMs: 20_000,
          schema: "data",
        });
        ctx.dataFindings.sql.push(input.sql);
        // 结果非空且 ≤ 60 行才注册为表格（空结果不下发，避免前端渲染「暂无数据」空卡）
        if (result.rows.length > 0 && result.rows.length <= 60) {
          const table: TablePayload = {
            title: "查询结果",
            columns: result.columns,
            rows: result.rows,
            note: `${result.rowCount} 行 · ${result.elapsedMs}ms${result.truncated ? " · 已截断" : ""}`,
          };
          ctx.dataFindings.tables.push(table);
          ctx.sink({ type: "table", table });
        }
        const summary = `返回 ${result.rowCount} 行 (${result.columns.join(", ")})`;
        ctx.sink({
          type: "tool_result", stepId, tool: "sql_query",
          summary, elapsedMs: Date.now() - startedAt,
        });
        // 给模型返回：列名 + 数据（截断至 100 行）+ 提示
        const preview = result.rows.slice(0, 100);
        return JSON.stringify({
          columns: result.columns,
          rowCount: result.rowCount,
          rows: preview,
          note: result.rowCount > 100 ? "结果超 100 行已截断，请缩小范围或聚合" : "",
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ctx.sink({ type: "tool_result", stepId, tool: "sql_query", summary: `失败: ${msg}` });
        return JSON.stringify({ error: msg, hint: "请检查 SQL 语法与表/列名（可用 inspect_schema 查看结构）" });
      }
    },
    {
      name: "sql_query",
      description: `对 PostgreSQL 数据库执行只读 SELECT 查询（search_path=data，仅限本地 BI/演示表；标注「本表不做本地查询」的 API 源表如 Adjust adjust_daily_metrics 请用 run_operator 直连 API，不要在此查询）。常用表：daily_metrics(stat_date,region,channel,gmv,orders,active_users,new_users,conversion_rate,avg_order_value)、orders(order_no,user_id,region,channel,category,product_id,amount,quantity,status,created_at)、products(name,category,price,cost)、regions(name,tier)、channel_daily_metrics(stat_date,ad_channel,platform,region,spend,impressions,clicks,downloads,registrations,fd_users,fd_amount,rd_users,rd_amount；投放渠道效果分析：ad_channel取值Meta/X/TikTok，platform取值app/web，fd=首次充钱，rd=召回再充钱)、channel_campaigns(campaign_no,ad_channel,platform,objective,campaign_name,status,start_date,daily_budget,total_spend,downloads,registrations,fd_users,rd_users)。完整表/列结构用 inspect_schema 确认。日期类 stat_date 列为 DATE 类型。仅允许单条 SELECT/WITH 语句。`,
      schema: z.object({
        sql: z.string().describe("只读 SQL 查询语句（SELECT 或 WITH 开头）"),
      }),
    },
  );
}

/** 查看库表结构 */
export function createInspectSchemaTool(ctx: AgentRunContext) {
  return tool(
    async (input: { table?: string }) => {
      const stepId = nextStepId(ctx);
      ctx.sink({ type: "tool_call", stepId, tool: "inspect_schema", input });
      try {
        if (input.table) {
          const tables = await introspectSchema(env.DATABASE_URL, "data");
          const target = tables.find((t) => t.table === input.table);
          if (!target) {
            ctx.sink({ type: "tool_result", stepId, tool: "inspect_schema", summary: `表 ${input.table} 不存在` });
            return JSON.stringify({ error: `表 data.${input.table} 不存在`, available: tables.map((t) => t.table) });
          }
          ctx.sink({
            type: "tool_result", stepId, tool: "inspect_schema",
            summary: `${target.table}（${target.columns.length} 列）`,
          });
          return JSON.stringify(target);
        }
        const tables = await introspectSchema(env.DATABASE_URL, "data");
        ctx.sink({
          type: "tool_result", stepId, tool: "inspect_schema",
          summary: `data schema 共 ${tables.length} 张表`,
        });
        return JSON.stringify(tables.map((t) => ({
          table: t.table, columns: t.columns.map((c) => `${c.name}:${c.dataType}`),
        })));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ctx.sink({ type: "tool_result", stepId, tool: "inspect_schema", summary: `失败: ${msg}` });
        return JSON.stringify({ error: msg });
      }
    },
    {
      name: "inspect_schema",
      description: "查看 data schema 的表结构：不传 table 返回所有表概览；传 table 返回该表列名与类型。",
      schema: z.object({
        table: z.string().optional().describe("表名（可选），如 daily_metrics"),
      }),
    },
  );
}

/** 展示数据表格（Agent 主动向用户展示中间结果） */
export function createShowTableTool(ctx: AgentRunContext) {
  return tool(
    async (input: { title: string; columns: string[]; rows: Record<string, unknown>[] }) => {
      const stepId = nextStepId(ctx);
      ctx.sink({ type: "tool_call", stepId, tool: "show_table", input: { title: input.title, columns: input.columns, rowCount: input.rows.length } });
      const table: TablePayload = {
        title: input.title,
        columns: input.columns,
        rows: input.rows.slice(0, 100),
      };
      ctx.dataFindings.tables.push(table);
      ctx.sink({ type: "table", table });
      ctx.sink({ type: "tool_result", stepId, tool: "show_table", summary: `已展示 ${table.rows.length} 行` });
      return JSON.stringify({ ok: true, displayed: table.rows.length });
    },
    {
      name: "show_table",
      description: "将结构化数据以表格形式展示给用户。columns 为列名数组，rows 为对象数组（字段名与 columns 对应），最多 100 行。",
      schema: z.object({
        title: z.string().describe("表格标题"),
        columns: z.array(z.string()).describe("列名"),
        rows: z.array(z.record(z.string(), z.unknown())).describe("数据行"),
      }),
    },
  );
}

/** 生成图表（Agent 输出 ChartSpec，前端 Recharts 渲染） */
export function createGenerateChartTool(ctx: AgentRunContext) {
  return tool(
    async (input: {
      chartType: "bar" | "line" | "area" | "pie" | "radar";
      title: string;
      xKey: string;
      yKeys: string[];
      data: Record<string, unknown>[];
      xLabel?: string;
      yLabel?: string;
      unit?: string;
    }) => {
      const stepId = nextStepId(ctx);
      ctx.sink({ type: "tool_call", stepId, tool: "generate_chart", input: { chartType: input.chartType, title: input.title, xKey: input.xKey, yKeys: input.yKeys, dataRows: input.data.length } });
      const chart: ChartSpec = {
        type: input.chartType,
        title: input.title,
        xKey: input.xKey,
        yKeys: input.yKeys,
        data: input.data.slice(0, 200),
        xLabel: input.xLabel,
        yLabel: input.yLabel,
        unit: input.unit,
      };
      ctx.dataFindings.charts.push(chart);
      ctx.sink({ type: "chart", chart });
      ctx.sink({ type: "tool_result", stepId, tool: "generate_chart", summary: `已生成${chartTypeLabel(input.chartType)}「${input.title}」（${chart.data.length} 个数据点）` });
      return JSON.stringify({ ok: true, rendered: chart.data.length });
    },
    {
      name: "generate_chart",
      description: `生成图表并展示给用户。选型建议：分类对比→bar；时间趋势→line/area；占比构成→pie（yKeys 传一个）；多维评估→radar。data 每行需含 xKey 字段和全部 yKeys 字段，数值必须为 number 类型，最多 200 行。示例：{"chartType":"bar","title":"各大区GMV","xKey":"region","yKeys":["gmv"],"data":[{"region":"华东","gmv":100}],"unit":"元"}`,
      schema: z.object({
        chartType: z.enum(["bar", "line", "area", "pie", "radar"]).describe("图表类型"),
        title: z.string().describe("图表标题"),
        xKey: z.string().describe("X 轴字段名（data 中的 key）"),
        yKeys: z.array(z.string()).min(1).describe("Y 轴数值字段名列表"),
        data: z.array(z.record(z.string(), z.unknown())).min(1).describe("数据行数组"),
        xLabel: z.string().optional().describe("X 轴显示名"),
        yLabel: z.string().optional().describe("Y 轴显示名"),
        unit: z.string().optional().describe("数值单位（元/单/%等）"),
      }),
    },
  );
}

function chartTypeLabel(type: string): string {
  const map: Record<string, string> = { bar: "柱状图", line: "折线图", area: "面积图", pie: "饼图", radar: "雷达图" };
  return map[type] ?? type;
}

// ─── 研究工具 ─────────────────────────────────────────────────────────────────

/** 互联网搜索（预算控制：单次任务最多 8 次检索，防止无限搜索循环） */
export function createWebSearchTool(ctx: AgentRunContext) {
  return tool(
    async (input: { query: string }) => {
      const stepId = nextStepId(ctx);
      const startedAt = Date.now();
      ctx.sink({ type: "tool_call", stepId, tool: "web_search", input });
      // 搜索预算：超出后强制模型转入记录/总结阶段
      if (ctx.researchFindings.searchedQueries.length >= 8) {
        ctx.sink({
          type: "tool_result", stepId, tool: "web_search",
          summary: "搜索预算已用完（8 次），请停止检索",
        });
        return JSON.stringify({
          error: "搜索预算已用完（最多 8 次检索）",
          hint: "请立即改用 record_finding 记录已有发现（基于已检索到的摘要），然后输出最终回答。不要再调用 web_search。",
        });
      }
      try {
        const results = await webSearch(input.query, 6);
        ctx.researchFindings.searchedQueries.push(input.query);
        // 注册引用 + 保存摘要（供兜底转正）
        for (const r of results) {
          const existing = ctx.researchFindings.citations.find((c) => c.url === r.url);
          if (!existing) {
            const no = ctx.researchFindings.citations.length + 1;
            ctx.researchFindings.citations.push({ no, title: r.title, url: r.url });
            if (r.snippet.trim().length > 30) {
              ctx.researchFindings.searchSnippets.push({ no, title: r.title, snippet: r.snippet.trim() });
            }
          }
        }
        ctx.sink({ type: "citations", citations: ctx.researchFindings.citations });
        ctx.sink({
          type: "tool_result", stepId, tool: "web_search",
          summary: results.length > 0 ? `检索到 ${results.length} 条结果` : "无结果",
          elapsedMs: Date.now() - startedAt,
        });
        const remaining = 8 - ctx.researchFindings.searchedQueries.length;
        return JSON.stringify({
          results: results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
          note:
            remaining <= 0
              ? "⚠️ 搜索预算已用完，请立即用 record_finding 记录发现并输出最终回答"
              : remaining <= 2
                ? `剩余搜索次数不多（${remaining} 次），请尽快转入 fetch_page 深读或 record_finding 记录`
                : "",
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ctx.sink({ type: "tool_result", stepId, tool: "web_search", summary: `失败: ${msg}` });
        return JSON.stringify({ error: msg });
      }
    },
    {
      name: "web_search",
      description: "搜索互联网公开信息，返回标题/链接/摘要。适合行业趋势、竞品动态、政策法规、市场数据等外部信息检索。用中文搜索中文内容，英文搜索英文内容。注意：整个任务最多搜索 8 次，请精炼关键词避免浪费预算。",
      schema: z.object({
        query: z.string().min(2).max(200).describe("搜索关键词（精炼，避免整句）"),
      }),
    },
  );
}

/** 抓取网页正文（预算控制：单次任务最多 6 页） */
export function createFetchPageTool(ctx: AgentRunContext) {
  return tool(
    async (input: { url: string }) => {
      const stepId = nextStepId(ctx);
      const startedAt = Date.now();
      ctx.sink({ type: "tool_call", stepId, tool: "fetch_page", input });
      if (ctx.researchFindings.fetchedUrls.length >= 6) {
        ctx.sink({
          type: "tool_result", stepId, tool: "fetch_page",
          summary: "抓取预算已用完（6 页），请转入 record_finding",
        });
        return JSON.stringify({
          error: "抓取预算已用完（最多 6 页）",
          hint: "请基于已抓取的内容用 record_finding 记录发现，然后输出最终回答。",
        });
      }
      try {
        const page = await fetchPage(input.url, 6000);
        ctx.researchFindings.fetchedUrls.push(input.url);
        ctx.sink({
          type: "tool_result", stepId, tool: "fetch_page",
          summary: `${page.title.slice(0, 40)}（${page.wordCount} 字）`,
          elapsedMs: Date.now() - startedAt,
        });
        return JSON.stringify({ title: page.title, url: page.url, text: page.text });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ctx.sink({ type: "tool_result", stepId, tool: "fetch_page", summary: `失败: ${msg}` });
        return JSON.stringify({ error: msg, hint: "该站点可能阻止抓取，换一个来源试试" });
      }
    },
    {
      name: "fetch_page",
      description: "抓取指定 URL 的网页正文（已去除导航等噪声）。用于深入阅读搜索结果中的关键页面，提取详细事实与数据。整个任务最多抓取 6 页，优先选择最相关的页面。",
      schema: z.object({
        url: z.string().url().describe("要抓取的网页 URL（必须 http/https）"),
      }),
    },
  );
}

/** 记录研究发现 */
export function createRecordFindingTool(ctx: AgentRunContext) {
  return tool(
    async (input: { finding: string }) => {
      const stepId = nextStepId(ctx);
      ctx.sink({ type: "tool_call", stepId, tool: "record_finding", input: { finding: input.finding.slice(0, 80) } });
      ctx.researchFindings.notes.push(input.finding);
      ctx.sink({
        type: "tool_result", stepId, tool: "record_finding",
        summary: `已记录发现 #${ctx.researchFindings.notes.length}`,
      });
      return JSON.stringify({ ok: true, totalNotes: ctx.researchFindings.notes.length });
    },
    {
      name: "record_finding",
      description: "记录一条重要研究发现（含数据/结论/来源编号），将进入最终报告的证据池。每完成一个子问题的研究就记录一次。",
      schema: z.object({
        finding: z.string().min(5).max(1000).describe("研究发现，建议包含数据与来源编号如 [1]"),
      }),
    },
  );
}

// ─── 外部数据源工具（已注册的 api / mcp 数据源） ────────────────────────────

/** 数据源清单描述（供工具 description / 提示词枚举） */
export function externalSourcesSummary(sources: ResolvedDataSource[]): string {
  const summary = sources
    .map((s) => {
      if (s.type === "api" && s.apiConfig?.protocol === "google_ads") {
        return `- ${s.name}（sourceId=${s.id}，API·Google Ads，${displayEndpoint(s)}，loginCustomerId=${s.apiConfig.loginCustomerId ?? "直接访问"}）`;
      }
      if (s.type === "api" && s.apiConfig?.protocol === "ga4") {
        return `- ${s.name}（sourceId=${s.id}，API·GA4 官方 SDK，${displayEndpoint(s)}）`;
      }
      if (s.type === "api") {
        return `- ${s.name}（sourceId=${s.id}，API·${s.apiConfig?.protocol === "graphql" ? "GraphQL" : "REST"}，${displayEndpoint(s)}）`;
      }
      return `- ${s.name}（sourceId=${s.id}，MCP 代理，${displayEndpoint(s)}）`;
    })
    .join("\n");
  return [summary,
    sources.some((s) => s.apiConfig?.protocol === "ga4") ? GA4_QUERY_GUIDE : "",
    sources.some((s) => s.apiConfig?.protocol === "google_ads") ? GOOGLE_ADS_QUERY_GUIDE : "",
    sources.some((s) => s.type === "api" && isAdjustEndpoint(s.apiConfig?.endpoint ?? "")) ? ADJUST_QUERY_GUIDE : "",
  ].filter(Boolean).join("\n");
}

/** GA4 按完整行裁剪，保留合法 JSON、上游总行数与续页位置。 */
export function serializeGa4ToolResult(result: { status: number; body: unknown; fromCache: boolean; cacheState: string; truncated: boolean }, source: ResolvedDataSource): string {
  const body = { ...(result.body as Record<string, unknown>) };
  const listKey = Array.isArray(body.rows) ? "rows" : Array.isArray(body.fields) ? "fields" : null;
  const items = listKey ? [...body[listKey] as unknown[]] : [];
  if (listKey) body[listKey] = items;
  const payload: Record<string, unknown> = { ...body, sourceId: source.id, sourceName: source.name, status: result.status, fromCache: result.fromCache, cacheState: result.cacheState };
  let text = JSON.stringify(payload);
  while (text.length > 19_000 && items.length > 0) {
    items.pop();
    payload.truncated = true;
    if (listKey === "rows") {
      payload.returnedRows = items.length;
      payload.nextOffset = items.length ? Number(body.offset ?? 0) + items.length : null;
    }
    text = JSON.stringify(payload);
  }
  return text.length <= 20_000 ? text : JSON.stringify({ sourceId: source.id, error: "GA4 结果元信息过大，请缩小查询范围", truncated: true });
}

/** 统一标识缺失/空数据，且独立保留有界证据，不依赖 worker 再次转述。 */
function preserveApiResult(ctx: AgentRunContext, output: string, sourceId: string, sourceName?: string): string {
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(output);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("无效工具结果");
    payload = parsed as Record<string, unknown>;
  } catch {
    payload = { error: "API 输出超过安全大小或格式无效，请缩小查询范围", truncated: true };
  }
  const body = payload.body && typeof payload.body === "object" ? payload.body as Record<string, unknown> : payload;
  const graphqlErrors = Array.isArray(payload.errors) && payload.errors.length > 0;
  const failed = !!payload.error || !!body.error || Number(payload.status) >= 400 || (graphqlErrors && payload.data == null);
  const rows = Array.isArray(body.rows) ? body.rows : Array.isArray(body.fields) ? body.fields : Array.isArray(payload.body) ? payload.body : null;
  const partial = !!payload.truncated || !!body.truncated || payload.cacheState === "stale" || graphqlErrors;
  const empty = !partial && (rows?.length === 0 || body.rowCount === 0 || payload.status === 204 || payload.body === null || payload.data === null);
  Object.assign(payload, {
    sourceId, sourceName,
    outcome: failed ? "unavailable" : partial ? "partial" : empty ? "empty" : "success",
    ...(failed ? { nonFatal: true, hint: API_FAILURE_CONTINUE_HINT } : empty ? { hint: API_EMPTY_CONTINUE_HINT } : {}),
  });
  // API 直查结果同步注册为证据表格：结构化抽取以 dataFindings.tables 为唯一数值来源，
  // 不注册则直查补齐的计划在 structured 行中整体缺失（实测 XC_iOS：Markdown 答案有数、抽取 0 行）。
  // 只注册非失败的对象行；重复调用（命中缓存）同题同行不重复注册。
  const recordRows = (rows ?? []).filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r));
  if (!failed && recordRows.length > 0 && recordRows.length <= 200) {
    const table: TablePayload = {
      title: `API 直查 · ${sourceName ?? sourceId}`,
      columns: [...new Set(recordRows.flatMap((r) => Object.keys(r)))],
      rows: recordRows,
      note: `${recordRows.length} 行${partial ? " · 结果被截断，仅含部分行" : ""}`,
    };
    const duplicated = ctx.dataFindings.tables.some((t) => t.title === table.title && JSON.stringify(t.rows) === JSON.stringify(table.rows));
    if (!duplicated) {
      ctx.dataFindings.tables.push(table);
      ctx.sink({ type: "table", table });
    }
  }
  const result = JSON.stringify(payload);
  // 快照仅供综合兜底；保留完整行，不能把裁剪后的样本当作全量结果。
  const snapshot = JSON.parse(result) as Record<string, unknown>;
  const snapshotBody = snapshot.body && typeof snapshot.body === "object" ? snapshot.body as Record<string, unknown> : snapshot;
  const items = Array.isArray(snapshotBody.rows) ? snapshotBody.rows : Array.isArray(snapshotBody.fields) ? snapshotBody.fields : Array.isArray(snapshot.body) ? snapshot.body : [];
  while (JSON.stringify(snapshot).length > 6_000 && items.length) {
    items.pop();
    snapshot.snapshotTruncated = true;
    snapshot.snapshotReturnedRows = items.length;
    if (snapshot.outcome === "success") snapshot.outcome = "partial";
    snapshot.snapshotNote = "仅保留部分完整行作为证据，不可据此计算完整总量";
  }
  let evidence = JSON.stringify(snapshot);
  if (evidence.length > 6_000) {
    evidence = JSON.stringify({
      sourceId: sourceId.slice(0, 256), sourceName: sourceName?.slice(0, 300),
      outcome: payload.outcome === "success" ? "partial" : payload.outcome,
      status: payload.status, nonFatal: payload.nonFatal,
      snapshotTruncated: true, note: "结果过大，仅保留查询状态；请缩小查询范围，不能据此推断指标值",
    });
  }
  if (ctx.apiQueryResults.length < 6) ctx.apiQueryResults.push(evidence);
  return result.length <= 20_000 ? result : evidence;
}

/** 调用已注册 API 数据源（REST/GraphQL，预算：单次任务最多 6 次） */
export function createApiSourceTool(ctx: AgentRunContext, sources: ResolvedDataSource[]) {
  const apiSources = sources.filter((s) => s.type === "api" && s.apiConfig);
  const terminalResults = new Map<string, string>();
  let calls = 0;
  return tool(
    async (input: {
      sourceId: string;
      path?: string;
      method?: "GET" | "POST";
      params?: Record<string, string>;
      body?: string;
      graphqlQuery?: string;
      variables?: Record<string, unknown>;
    }) => {
      const stepId = nextStepId(ctx);
      const startedAt = Date.now();
      const source = apiSources.find((s) => s.id === input.sourceId);
      const requestKey = JSON.stringify(input);
      ctx.sink({ type: "tool_call", stepId, tool: "query_api_source", input: { sourceId: input.sourceId, path: input.path, method: input.method, body: input.body?.slice(0, 300), graphqlQuery: input.graphqlQuery?.slice(0, 120) } });
      const previous = terminalResults.get(requestKey);
      if (previous) {
        ctx.sink({ type: "tool_result", stepId, tool: "query_api_source", summary: "该条件已确认失败或无数据，继续其他查询" });
        return previous;
      }
      const execute = async () => {
        if (calls >= 6) {
          ctx.sink({ type: "tool_result", stepId, tool: "query_api_source", summary: "API 调用预算已用完（6 次）" });
          return JSON.stringify({ error: "API 调用预算已用完（最多 6 次）", hint: "请基于已有数据继续分析或输出回答" });
        }
        calls += 1;
        if (!source?.apiConfig) {
          ctx.sink({ type: "tool_result", stepId, tool: "query_api_source", summary: `数据源 ${input.sourceId} 不存在` });
          return JSON.stringify({ error: `API 数据源 ${input.sourceId} 不存在`, available: apiSources.map((s) => s.id) });
        }
        try {
          if (source.apiConfig.protocol === "graphql") {
            if (!input.graphqlQuery) {
              return JSON.stringify({ error: "该数据源为 GraphQL 协议，必须提供 graphqlQuery 参数" });
            }
            const result = await withDeadline(() => executeGraphQLQuery(source.apiConfig!, {
              query: input.graphqlQuery!, variables: input.variables,
            }), API_QUERY_TIMEOUT_MS);
            ctx.sink({
              type: "tool_result", stepId, tool: "query_api_source",
              summary: `GraphQL 查询完成${result.errors?.length ? `（含 ${result.errors.length} 个错误）` : ""}`,
              elapsedMs: Date.now() - startedAt,
            });
            return JSON.stringify({ data: result.data, errors: result.errors, truncated: result.truncated });
          }
          let parsedBody: unknown;
          if (input.body) {
            try {
              parsedBody = JSON.parse(input.body);
            } catch {
              parsedBody = input.body;
            }
          }
          // Adjust RS API 只接受 GET + query 参数：POST/body 必 405，本地拦截并给纠正提示
          //（不浪费上游配额与调用预算；Agent 看到具体错因才能自我纠正）
          if (isAdjustEndpoint(source.apiConfig.endpoint) && (input.method === "POST" || input.body)) {
            const msg = "Adjust 报告服务仅支持 GET + params（dimensions/metrics/date_period，过滤用 campaign_network__contains 等后缀操作符）；POST 或 body 会被 405 拒绝。请改用 GET 并把条件放入 params";
            ctx.sink({ type: "tool_result", stepId, tool: "query_api_source", summary: `失败: ${msg}` });
            return JSON.stringify({ error: msg });
          }
          // Adjust 报告终端参数纠正：模型常混用 GA4/Google 日期写法（缺 date_period、斜杠区间、last_30_days），
          // 机械可纠正的直接纠正（paramFixes 留痕），不可纠正的本地拦截，不发上游白耗 400
          let restParams = input.params;
          let paramFixes: string[] = [];
          if (isAdjustEndpoint(source.apiConfig.endpoint) && isAdjustReportPath(input.path)) {
            const normalized = normalizeAdjustReportParams(input.params ?? {});
            if (!normalized.ok) {
              ctx.sink({ type: "tool_result", stepId, tool: "query_api_source", summary: `失败: ${normalized.error}` });
              return JSON.stringify({ error: normalized.error });
            }
            restParams = normalized.params;
            paramFixes = normalized.fixes;
          }
          const result = await cachedRestRequest(
            source.apiConfig,
            {
              method: input.method ?? "GET",
              path: input.path,
              params: restParams,
              body: parsedBody,
            },
            { sourceId: source.id },
          );
          ctx.sink({
            type: "tool_result", stepId, tool: "query_api_source",
            summary: result.fromCache
              ? `命中缓存（${result.cacheState}）`
              : `HTTP ${result.status}（${result.elapsedMs}ms）`,
            elapsedMs: Date.now() - startedAt,
          });
          if (source.apiConfig.protocol === "google_ads") return serializeGoogleAdsResult(result, source);
          if (source.apiConfig.protocol === "ga4") return serializeGa4ToolResult(result, source);
          // CSV 响应结构化为表格行（避免原文占满 20K 截断窗口）
          if (result.contentType.includes("csv") && typeof result.body === "string") {
            if (result.status === 204 || result.body.trim().length === 0) {
              return JSON.stringify({ status: result.status, rowCount: 0, note: "区间无数据", fromCache: result.fromCache, cacheState: result.cacheState });
            }
            const table = parseCsvTable(result.body);
            const rows = csvTableToObjects(table).slice(0, 200);
            return JSON.stringify({
              status: result.status,
              columns: table.header,
              rowCount: rows.length,
              rows,
              truncated: result.truncated || table.rows.length > 200,
              note: table.rows.length > 200 ? `共 ${table.rows.length} 行，已截断至前 200 行` : "",
              fromCache: result.fromCache,
              cacheState: result.cacheState,
              ...(paramFixes.length ? { paramFixes } : {}),
            });
          }
          return JSON.stringify({ status: result.status, body: result.body, truncated: result.truncated, fromCache: result.fromCache, cacheState: result.cacheState, ...(paramFixes.length ? { paramFixes } : {}) });
        } catch (error) {
          const google = source.apiConfig.protocol === "ga4" || source.apiConfig.protocol === "google_ads";
          // Google 源保留具体错误（模板校验等参数级信息，不含凭证；上游错误已经 googleAdsError 脱敏、不会走到这里），
          // 否则 Agent 看不到哪个参数错，无法自我纠正，一次校验失败即成死局
          const detail = error instanceof Error ? error.message : String(error);
          const msg = error instanceof QueryTimeoutError ? error.message : google ? `Google 查询失败：${detail.slice(0, 300)}。请核对操作参数；其他数据源可继续查询` : detail;
          ctx.sink({ type: "tool_result", stepId, tool: "query_api_source", summary: `失败: ${msg}` });
          return JSON.stringify({ error: msg, ...(error instanceof QueryTimeoutError ? { status: 504, code: error.code } : {}) });
        }
      };
      const result = preserveApiResult(ctx, await execute(), input.sourceId, source?.name);
      const outcome = JSON.parse(result).outcome;
      if (outcome === "empty" || outcome === "unavailable") terminalResults.set(requestKey, result);
      return result;
    },
    {
      name: "query_api_source",
      description: `调用已注册的外部 API 数据源获取数据（只读，经查询缓存与限流，命中缓存不消耗上游配额）。REST 源传 path/method/params/body，CSV 响应自动结构化为表格；GraphQL 源传 graphqlQuery/variables（禁止 mutation）。整个任务最多调用 6 次。注意：已建模的报告类指标/维度取数应优先用 run_operator（aggregate/filter 会依据指标所属数据源自动直连对应 API 源），本工具用于 Google Ads campaign/投放报告、GA4 官方 SDK 报告及语义层未建模的自由 API 探索。全源覆盖：本地算子/SQL 取数完成后，问题涉及 GA4/Google Ads 可提供的指标时仍须调用本工具补齐对应来源，最后分源汇总（用户明确限定单一来源时除外）。可用数据源：\n${externalSourcesSummary(apiSources)}`,
      schema: z.object({
        sourceId: z.string().describe("数据源 ID（见工具描述中的可用数据源）"),
        path: z.string().optional().describe("REST：endpoint 之后的相对路径，如 csv_report（勿重复基础路径）；GA4 仅支持 runReport 或 metadata；Google Ads：accounts/account/clients/campaigns/conversionActions/report"),
        method: z.enum(["GET", "POST"]).optional().describe("默认 GET；GA4 runReport 必须 POST，metadata 必须 GET；Google Ads 所有操作必须 POST"),
        params: z.record(z.string(), z.string()).optional().describe("REST query 参数；GA4 metadata 仅接受 search"),
        body: z.string().optional().describe("POST JSON 字符串请求体；GA4 限 20KB，用 dateRanges/dimensions/metrics，不传 property 或凭证；Google Ads 传客户ID、日期、campaignId、installAction 等模板参数，禁止自由 GAQL"),
        graphqlQuery: z.string().optional().describe("GraphQL：查询语句（仅 query）"),
        variables: z.record(z.string(), z.unknown()).optional().describe("GraphQL：变量"),
      }),
    },
  );
}

/** 调用已注册 MCP 数据源（子 ReAct Agent，预算：单次任务最多 3 次） */
export function createMcpSourceTool(ctx: AgentRunContext, sources: ResolvedDataSource[]) {
  const mcpSources = sources.filter((s) => s.type === "mcp" && s.mcpConfig);
  let calls = 0;
  return tool(
    async (input: { sourceId: string; task: string }) => {
      const stepId = nextStepId(ctx);
      const startedAt = Date.now();
      ctx.sink({ type: "tool_call", stepId, tool: "query_mcp_source", input: { sourceId: input.sourceId, task: input.task.slice(0, 120) } });
      if (calls >= 3) {
        ctx.sink({ type: "tool_result", stepId, tool: "query_mcp_source", summary: "MCP 调用预算已用完（3 次）" });
        return JSON.stringify({ error: "MCP 调用预算已用完（最多 3 次）", hint: "请基于已有数据继续分析或输出回答" });
      }
      const source = mcpSources.find((s) => s.id === input.sourceId);
      if (!source?.mcpConfig) {
        ctx.sink({ type: "tool_result", stepId, tool: "query_mcp_source", summary: `数据源 ${input.sourceId} 不存在` });
        return JSON.stringify({ error: `MCP 数据源 ${input.sourceId} 不存在`, available: mcpSources.map((s) => s.id) });
      }
      calls += 1;
      try {
        const result = await runMcpReactAgent(source.mcpConfig, input.task, (step) => {
          // 子 Agent 的每步工具调用同步外送，前端可观察完整链路
          const subStepId = nextStepId(ctx);
          ctx.sink({ type: "tool_call", stepId: subStepId, tool: `mcp:${step.tool}`, input: step.input });
          ctx.sink({
            type: "tool_result", stepId: subStepId, tool: `mcp:${step.tool}`,
            summary: step.output.slice(0, 120), elapsedMs: step.elapsedMs,
          });
        });
        ctx.sink({
          type: "tool_result", stepId, tool: "query_mcp_source",
          summary: `MCP Agent 完成（${result.steps.length} 步工具调用）`,
          elapsedMs: Date.now() - startedAt,
        });
        return JSON.stringify({ answer: result.answer, toolSteps: result.steps.length }).slice(0, 20_000);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ctx.sink({ type: "tool_result", stepId, tool: "query_mcp_source", summary: `失败: ${msg}` });
        return JSON.stringify({ error: msg, hint: "MCP 代理可能不可用，请换其他数据源或说明情况" });
      }
    },
    {
      name: "query_mcp_source",
      description: `向已注册的 MCP 数据源下达自然语言数据获取任务，由子 Agent 自主调用 MCP 工具完成并返回结果。任务描述要具体（含时间范围/字段/过滤条件）。整个任务最多调用 3 次。可用数据源：\n${externalSourcesSummary(mcpSources)}`,
      schema: z.object({
        sourceId: z.string().describe("数据源 ID（见工具描述中的可用数据源）"),
        task: z.string().min(2).describe("自然语言任务，如：查询 2026 年 8 月华东大区的工单量"),
      }),
    },
  );
}

// ─── 语义上下文（供提示词构建） ────────────────────────────────────────────────

export function semanticContextForPrompt(): string {
  return semanticContextSummary();
}

export function demoTablesHint(): string {
  return DEMO_SEMANTIC_MODELS.map(
    (m) => `- data.${m.table}（${m.name}）：${m.dimensions.map((d) => d.id).join(", ")} | 指标：${m.metrics.map((x) => x.id).join(", ")}`,
  ).join("\n");
}

/**
 * 单表数据新鲜度：时间列的 MIN/MAX + 行数。
 * 无时间列（如 products 用 id）或查询失败（表不存在等）返回 null，降级为不标注，不阻断数据字典生成。
 */
async function queryTableFreshness(
  schema: string, table: string, timeColumn: string,
): Promise<{ count: number; min: string; max: string } | null> {
  if (timeColumn === "id") return null; // 非时间列，无新鲜度语义
  const safe = (s: string) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s);
  if (!safe(schema) || !safe(table) || !safe(timeColumn)) return null;
  try {
    const sql = `SELECT COUNT(*)::int AS n, MIN("${timeColumn}")::text AS lo, MAX("${timeColumn}")::text AS hi FROM "${schema}"."${table}"`;
    const r = await executeReadOnlyQuery(env.DATABASE_URL, sql, { maxRows: 1, timeoutMs: 5_000, schema });
    const row = r.rows[0] as { n?: number; lo?: string; hi?: string } | undefined;
    if (!row) return null;
    return { count: Number(row.n ?? 0), min: String(row.lo ?? ""), max: String(row.hi ?? "") };
  } catch {
    return null;
  }
}

/**
 * 数据落地开关关闭的 Adjust 官方源本地表名集合（小写）——这些表本地无有效数据，
 * sql_query 不应本地查询（会返回空结果误导模型），须由 run_operator 直连 API。开关开启时返回空集。
 */
async function localQueryForbiddenTables(): Promise<Set<string>> {
  if (env.ADJUST_QUERY_CACHE_ENABLED) return new Set();
  const [models, sources] = await Promise.all([
    runtimeSemanticModels(),
    listDataSources().catch(() => [] as Array<ResolvedDataSource & { status: string }>),
  ]);
  const adjustDirectIds = new Set(
    sources.filter((s) => s.type === "api" && isAdjustEndpoint(s.apiConfig?.endpoint ?? "")).map((s) => s.id),
  );
  const forbidden = new Set<string>();
  for (const m of models) {
    if (m.dataSourceId && adjustDirectIds.has(m.dataSourceId)) forbidden.add(m.table.toLowerCase());
  }
  return forbidden;
}

/**
 * 数据字典（运行时全量语义模型：内置 + DB 自定义，如 Adjust 投放日指标）
 *
 * 关键：为每张表注入「本地数据新鲜度」（时间范围 + 行数）与「来源血缘」，让 LLM 能判断
 * 用户所问日期是否已被本地快照覆盖——本地范围外（如问今天/昨天但表只同步到更早）时，
 * aggregate/filter 会依据指标所属数据源自动直连其 API 源取最新，而非用陈旧或空的本地数据作答。
 */
export async function runtimeTablesHint(): Promise<string> {
  // models 与 sources 相互独立：并行拉取，避免串行等待（server-sequential-independent-await）
  const [models, sources] = await Promise.all([
    runtimeSemanticModels(),
    listDataSources().catch(() => [] as Array<ResolvedDataSource & { status: string }>),
  ]);
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const lines = await Promise.all(
    models.map(async (m) => {
      const dims = m.dimensions.map((d) => d.id).join(", ");
      const mets = m.metrics.map((x) => x.id).join(", ");
      let line = `- ${m.schema}.${m.table}（${m.name}）：${dims} | 指标：${mets}`;
      const fresh = await queryTableFreshness(m.schema, m.table, m.timeColumn);
      if (fresh) {
        line += fresh.count === 0
          ? ` | ⚠️ 本地暂无数据（0 行，尚未同步）`
          : ` | 本地数据范围：${fresh.min.slice(0, 10)} ~ ${fresh.max.slice(0, 10)}（${fresh.count} 行）`;
      }
      // 血缘：关联外部 API 源的本地表，范围外由算子（aggregate/filter）自动直连该源补取最新
      const src = m.dataSourceId ? sourceById.get(m.dataSourceId) : undefined;
      if (src?.type === "api") {
        // Adjust 数据落地开关关闭：本地表不参与查询（存量仅历史参考），取数一律经算子直连 API
        const adjustDirect = isAdjustEndpoint(src.apiConfig?.endpoint ?? "") && !env.ADJUST_QUERY_CACHE_ENABLED;
        line += adjustDirect
          ? ` | 数据落地开关已关闭（ADJUST_QUERY_CACHE_ENABLED=false）：本表不做本地查询（存量仅历史参考，勿用 sql_query），取数一律用 aggregate/filter/timeseries/anomaly 算子直连「${src.name}」API；按计划/渠道等维度筛选或模糊匹配名称时，用 aggregate 的 groupBy 传该维度 id（如 campaign_network）取回各维度值明细，再在结果行内匹配目标名称`
          : ` | 数据由「${src.name}」API 同步入库；查本地范围外的最新/明细数据仍用 aggregate、filter 指定该表的语义指标 key 与维度 id，算子会自动直连该 API 源（经本地缓存+API 直查）取回，无需关心 sourceId/path/上游 slug`;
      }
      return line;
    }),
  );
  // 本地 SQL 通路断开：字典置顶横幅，本地表仅供结构参考，取数一律经 API 数据源
  const banner = env.ASK_LOCAL_SQL_ENABLED
    ? ""
    : "⚠️ 本地 SQL 查询已停用（ASK_LOCAL_SQL_ENABLED=false）：下列本地表仅供结构参考、不可查询（sql_query 不可用，算子本地 SQL 路径已断开）；取数一律经 API 数据源——Adjust 等已建模 API 源用 run_operator（aggregate/filter/timeseries/anomaly 自动直连 API），GA4/Google Ads 用 query_api_source。\n";
  return banner + lines.join("\n");
}
