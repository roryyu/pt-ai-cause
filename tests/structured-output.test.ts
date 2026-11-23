import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ chatCompletion: vi.fn() }));
vi.mock("@/lib/server/model-gateway", () => ({ chatCompletion: mocks.chatCompletion }));

import { extractStructuredRows, StructuredOutputError } from "@/lib/server/agents/structured-output";
import { buildRowSchema, responseSchemaSpec } from "@/lib/server/agents/response-schema";
import type { TablePayload } from "@/lib/server/agents/events";

/**
 * ask 结构化输出（doc/periodic.md P0）：
 * responseSchema 规格校验 + 从原始表格抽取行数组（LLM 调用打桩，只验证编排与校验逻辑）
 */

const spec = responseSchemaSpec.parse({
  description: "Adjust 投放日指标，campaign × 日粒度",
  fields: [
    { name: "statDate", type: "date", description: "统计日期" },
    { name: "campaignNetwork", type: "string", description: "campaign_network 原值" },
    { name: "cost", type: "number", description: "消耗" },
    { name: "installs", type: "integer", required: false, description: "安装数" },
  ],
});

const table = (rows: Record<string, unknown>[]): TablePayload => ({
  title: "Adjust 日指标",
  columns: ["stat_date", "campaign_network", "cost", "installs"],
  rows,
});

const validRows = {
  rows: [
    { statDate: "2026-11-20", campaignNetwork: "tiktok_campaign_a", cost: 123.45, installs: 10 },
    { statDate: "2026-11-21", campaignNetwork: "tiktok_campaign_a", cost: 200, installs: null },
  ],
};

beforeEach(() => {
  mocks.chatCompletion.mockReset();
});

describe("responseSchema 规格", () => {
  it("字段名重复被拒绝", () => {
    const result = responseSchemaSpec.safeParse({
      fields: [
        { name: "cost", type: "number" },
        { name: "cost", type: "number" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("空字段列表被拒绝", () => {
    expect(responseSchemaSpec.safeParse({ fields: [] }).success).toBe(false);
  });

  it("行校验：number/integer 容忍字符串数字，date 严格 ISO 日", () => {
    const rowSchema = buildRowSchema(spec);
    const ok = rowSchema.safeParse({ statDate: "2026-11-20", campaignNetwork: "a", cost: "123.45", installs: "10" });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.cost).toBe(123.45);
      expect(ok.data.installs).toBe(10);
    }
    expect(rowSchema.safeParse({ statDate: "2026/11/20", campaignNetwork: "a", cost: 1 }).success).toBe(false);
    expect(rowSchema.safeParse({ statDate: "2026-11-20", campaignNetwork: "a", cost: 1, installs: 1.5 }).success).toBe(false);
  });

  it("行校验：必填缺失拒绝，可空字段允许 null/缺失", () => {
    const rowSchema = buildRowSchema(spec);
    expect(rowSchema.safeParse({ statDate: "2026-11-20", campaignNetwork: "a" }).success).toBe(false);
    expect(rowSchema.safeParse({ statDate: "2026-11-20", campaignNetwork: "a", cost: 1 }).success).toBe(true);
    expect(rowSchema.safeParse({ statDate: "2026-11-20", campaignNetwork: "a", cost: 1, installs: null }).success).toBe(true);
  });
});

describe("extractStructuredRows", () => {
  const input = {
    spec,
    question: "查询 tiktok_campaign_a 最近两天的消耗与安装",
    tables: [table([{ stat_date: "2026-11-20", campaign_network: "tiktok_campaign_a", cost: 123.45, installs: 10 }])],
  };

  it("首次输出合法即返回行数据，提示词携带表格证据与字段规格", async () => {
    mocks.chatCompletion.mockResolvedValueOnce(JSON.stringify(validRows));
    const result = await extractStructuredRows(input);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]!.cost).toBe(123.45);
    expect(mocks.chatCompletion).toHaveBeenCalledTimes(1);
    const userContent = mocks.chatCompletion.mock.calls[0]![0][1].content as string;
    expect(userContent).toContain("stat_date");
    expect(userContent).toContain("campaignNetwork");
  });

  it("容忍 markdown 代码块包裹的 JSON", async () => {
    mocks.chatCompletion.mockResolvedValueOnce(`\`\`\`json\n${JSON.stringify(validRows)}\n\`\`\``);
    const result = await extractStructuredRows(input);
    expect(result.rows).toHaveLength(2);
  });

  it("首次校验失败带问题清单重试一次，第二次合法即成功", async () => {
    mocks.chatCompletion
      .mockResolvedValueOnce(JSON.stringify({ rows: [{ statDate: "2026-11-20" }] }))
      .mockResolvedValueOnce(JSON.stringify(validRows));
    const result = await extractStructuredRows(input);
    expect(result.rows).toHaveLength(2);
    expect(mocks.chatCompletion).toHaveBeenCalledTimes(2);
    const retryContent = mocks.chatCompletion.mock.calls[1]![0][1].content as string;
    expect(retryContent).toContain("未通过校验");
  });

  it("两次均不合法抛 StructuredOutputError", async () => {
    mocks.chatCompletion.mockResolvedValue("不是 JSON");
    await expect(extractStructuredRows(input)).rejects.toBeInstanceOf(StructuredOutputError);
    expect(mocks.chatCompletion).toHaveBeenCalledTimes(2);
  });

  it("无表格时直接拒绝，不调用模型", async () => {
    await expect(extractStructuredRows({ ...input, tables: [] })).rejects.toBeInstanceOf(StructuredOutputError);
    expect(mocks.chatCompletion).not.toHaveBeenCalled();
  });

  it("证据行数超护栏时拒绝抽取", async () => {
    const huge = table(Array.from({ length: 20001 }, (_, i) => ({ stat_date: "2026-11-20", campaign_network: `c${i}`, cost: 1 })));
    await expect(extractStructuredRows({ ...input, tables: [huge] })).rejects.toThrow(/上限/);
    expect(mocks.chatCompletion).not.toHaveBeenCalled();
  });
});