/**
 * MCP 调用日志单元测试（不连 DB）：mcp/call-log.ts 的 withCallLog
 * 1. 成功：先落 running 行（工具名 + 输入），结束回写 completed + 输出 + questionId + 耗时
 * 2. 失败：回写 failed + 错误信息，异常原样上抛（MCP 层照常转 isError）
 * 3. 日志写入/回写失败不阻断业务调用
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    mcpCallLog: { create: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => ({ prisma: mocks.prisma, Prisma: {} }));

import { withCallLog } from "../mcp/call-log";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.mcpCallLog.create.mockResolvedValue({});
  mocks.prisma.mcpCallLog.update.mockResolvedValue({});
});

describe("withCallLog 成功路径", () => {
  it("先落 running 行（工具名 + 输入），结束回写 completed 与输出", async () => {
    const result = { questionId: "question_1", status: "completed", answer: "答案" };
    const returned = await withCallLog("ask", { question: "GMV 趋势如何？" }, async () => result);

    expect(returned).toBe(result);
    const create = mocks.prisma.mcpCallLog.create.mock.calls[0]?.[0] as {
      data: { id: string; tool: string; input: Record<string, unknown> };
    };
    expect(create.data.id).toMatch(/^mcp_log_/);
    expect(create.data.tool).toBe("ask");
    expect(create.data.input).toEqual({ question: "GMV 趋势如何？" });

    const update = mocks.prisma.mcpCallLog.update.mock.calls[0]?.[0] as {
      where: { id: string };
      data: { status: string; output: Record<string, unknown>; questionId: string; elapsedMs: number; completedAt: Date };
    };
    expect(update.where.id).toBe(create.data.id);
    expect(update.data.status).toBe("completed");
    expect(update.data.output).toEqual(result);
    expect(update.data.questionId).toBe("question_1");
    expect(update.data.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(update.data.completedAt).toBeInstanceOf(Date);
  });

  it("deep_research 工具名原样记录", async () => {
    await withCallLog("deep_research", { question: "市场格局", depth: "deep" }, async () => ({ questionId: "question_2" }));
    const create = mocks.prisma.mcpCallLog.create.mock.calls[0]?.[0] as { data: { tool: string } };
    expect(create.data.tool).toBe("deep_research");
  });
});

describe("withCallLog 失败路径", () => {
  it("回写 failed 与错误信息，异常原样上抛", async () => {
    const failure = new Error("任务问答执行失败: 模型网关不可达");
    await expect(withCallLog("ask", { question: "会失败" }, async () => { throw failure; })).rejects.toBe(failure);

    const update = mocks.prisma.mcpCallLog.update.mock.calls[0]?.[0] as {
      data: { status: string; error: string; elapsedMs: number };
    };
    expect(update.data.status).toBe("failed");
    expect(update.data.error).toBe("任务问答执行失败: 模型网关不可达");
    expect(update.data.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});

describe("withCallLog 日志故障不阻断业务", () => {
  it("create 失败时业务照常执行并返回", async () => {
    mocks.prisma.mcpCallLog.create.mockRejectedValue(new Error("DB 不可达"));
    const result = { questionId: "question_3" };
    expect(await withCallLog("ask", { question: "q" }, async () => result)).toBe(result);
  });

  it("update 失败时成功结果照常返回、失败异常照常上抛", async () => {
    mocks.prisma.mcpCallLog.update.mockRejectedValue(new Error("DB 不可达"));
    const result = { questionId: "question_4" };
    expect(await withCallLog("ask", { question: "q" }, async () => result)).toBe(result);
    const failure = new Error("业务失败");
    await expect(withCallLog("ask", { question: "q" }, async () => { throw failure; })).rejects.toBe(failure);
  });
});