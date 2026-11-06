/**
 * MCP 服务单元测试（不连 DB / 模型 / 网络）：
 * 1. 环境变量校验与 Bearer 鉴权（mcp/config.ts、mcp/auth.ts）
 * 2. 任务问答 / 深度研究的落库口径与返回 payload（mcp/tasks.ts，mock 工作流与 Prisma）
 * 3. MCP 协议装配：tools/list、tools/call、入参校验、isError 错误外壳（mcp/app.ts，InMemoryTransport 直连）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const mocks = vi.hoisted(() => ({
  prisma: {
    user: { findUnique: vi.fn(), create: vi.fn() },
    question: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    researchTask: { create: vi.fn(), update: vi.fn() },
  },
  runAgentWorkflow: vi.fn(),
  runDeepResearch: vi.fn(),
  chatCompletion: vi.fn(),
  loadGraph: vi.fn(),
  queryGraph: vi.fn(),
}));

// 隔离 DB 与环境变量依赖（与 insights.test.ts 同模式）
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma, Prisma: {} }));
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/server/agents/supervisor", () => ({ runAgentWorkflow: mocks.runAgentWorkflow }));
vi.mock("@/lib/server/agents/deep-research", () => ({ runDeepResearch: mocks.runDeepResearch }));
vi.mock("@/lib/server/model-gateway", () => ({ chatCompletion: mocks.chatCompletion }));
vi.mock("@/lib/server/research-graph/store", () => ({ loadGraph: mocks.loadGraph }));
vi.mock("@/lib/server/research-graph/query", () => ({ queryGraph: mocks.queryGraph }));

import { parseMcpEnv } from "../mcp/config";
import { isAuthorized, serviceActor, type McpActor } from "../mcp/auth";
import { runAskTask, runResearchTask } from "../mcp/tasks";
import { createCauseMcpServer } from "../mcp/app";
import type { AskTaskResult, ResearchTaskResult } from "../mcp/protocol";

const KEY = "k".repeat(64);
const ACTOR: McpActor = { id: "user_mcp_service", name: "MCP 服务", email: "mcp-service@cause.local", role: "admin" };

const WORKFLOW_RESULT = {
  route: "data_analysis" as const,
  finalAnswer: "华东区 GMV 最高，为 1200 万。",
  dataFindings: { charts: [{ type: "bar", title: "GMV" }], tables: [{ title: "明细", rows: [] }], sql: ["SELECT 1"] },
  researchFindings: { notes: [], citations: [{ no: 1, title: "数据源", url: "https://example.com" }], searchedQueries: [] },
  critique: null,
  elapsedMs: 1234,
};

const RESEARCH_RESULT = {
  objective: "摸清 AI 眼镜市场格局",
  subQuestions: [{
    id: "s1", question: "市场规模多大？", rationale: "先定量", findings: ["2026 年约 300 万台"],
    evidence: [], citationNos: [1], searchedQueries: ["AI眼镜 出货量"], elapsedMs: 100,
  }],
  report: "# 研究报告\n2026 年出货量约 300 万台 [1]。",
  citations: [{ no: 1, title: "行业报告", url: "https://example.com/report" }],
  elapsedMs: 5000,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.user.findUnique.mockResolvedValue({ id: ACTOR.id });
  mocks.prisma.question.findUnique.mockResolvedValue(null);
  mocks.prisma.question.create.mockResolvedValue({});
  mocks.prisma.question.update.mockResolvedValue({});
  mocks.prisma.researchTask.create.mockResolvedValue({});
  mocks.prisma.researchTask.update.mockResolvedValue({});
  mocks.chatCompletion.mockResolvedValue("本轮会话压缩摘要");
  mocks.loadGraph.mockResolvedValue({ nodes: [], edges: [] });
  mocks.queryGraph.mockReturnValue({ nodes: [], reports: [] });
  mocks.runAgentWorkflow.mockResolvedValue(WORKFLOW_RESULT);
  mocks.runDeepResearch.mockImplementation(async (options: {
    onStateChange?: (state: string) => Promise<void>;
    onSubTask?: (sub: unknown) => Promise<void>;
  }) => {
    await options.onStateChange?.("collecting");
    await options.onSubTask?.(RESEARCH_RESULT.subQuestions[0]);
    await options.onStateChange?.("completed");
    return RESEARCH_RESULT;
  });
});

describe("MCP 环境变量 parseMcpEnv", () => {
  it("合法密钥时给出默认端口、监听地址与服务身份", () => {
    const env = parseMcpEnv({ CAUSE_MCP_API_KEY: KEY });
    expect(env.CAUSE_MCP_PORT).toBe(3101);
    expect(env.CAUSE_MCP_HOST).toBe("127.0.0.1");
    expect(env.CAUSE_MCP_ACTOR_ID).toBe("user_mcp_service");
    expect(env.CAUSE_MCP_REQUEST_TIMEOUT_MS).toBe(900000);
  });

  it("密钥缺失或过短时拒绝启动（fail-closed）", () => {
    expect(() => parseMcpEnv({})).toThrow(/CAUSE_MCP_API_KEY/);
    expect(() => parseMcpEnv({ CAUSE_MCP_API_KEY: "short" })).toThrow(/至少 32 字符/);
  });
});

describe("Bearer 鉴权 isAuthorized", () => {
  const headers = (value?: string) => new Headers(value === undefined ? {} : { authorization: value });

  it("正确令牌通过", () => {
    expect(isAuthorized(headers(`Bearer ${KEY}`), KEY)).toBe(true);
    expect(isAuthorized(headers(`bearer ${KEY}`), KEY)).toBe(true);
  });

  it("缺失、错误、长度不符、非 Bearer 一律拒绝", () => {
    expect(isAuthorized(headers(), KEY)).toBe(false);
    expect(isAuthorized(headers(`Bearer ${"x".repeat(64)}`), KEY)).toBe(false);
    expect(isAuthorized(headers(`Bearer ${KEY.slice(0, 32)}`), KEY)).toBe(false);
    expect(isAuthorized(headers(`Basic ${KEY}`), KEY)).toBe(false);
  });

  it("serviceActor 从环境变量取服务身份", () => {
    const env = parseMcpEnv({ CAUSE_MCP_API_KEY: KEY, CAUSE_MCP_ACTOR_ID: "user_bot", CAUSE_MCP_ACTOR_EMAIL: "bot@cause.local" });
    expect(serviceActor(env)).toMatchObject({ id: "user_bot", email: "bot@cause.local" });
  });
});

describe("任务问答 runAskTask", () => {
  it("创建 kind=ask 问答、落库答案并返回 payload", async () => {
    const result = await runAskTask({ question: "哪个大区 GMV 最高？" }, ACTOR);

    expect(mocks.prisma.question.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        userId: ACTOR.id,
        content: "哪个大区 GMV 最高？",
        status: "analyzing",
        context: expect.objectContaining({ kind: "ask", via: "mcp" }),
      }),
    }));
    // 答案与压缩摘要落库（供历史回看与追问）
    const update = mocks.prisma.question.update.mock.calls[0]?.[0] as { data: { status: string; answer: Record<string, unknown> } };
    expect(update.data.status).toBe("completed");
    expect(update.data.answer.content).toBe(WORKFLOW_RESULT.finalAnswer);
    expect(update.data.answer.contextSummary).toBe("本轮会话压缩摘要");

    expect(result.questionId).toMatch(/^question_/);
    expect(result).toMatchObject({
      status: "completed",
      route: "data_analysis",
      answer: WORKFLOW_RESULT.finalAnswer,
      chartCount: 1,
      tableCount: 1,
      elapsedMs: 1234,
    });
    expect(result.citations).toHaveLength(1);
  });

  it("追问时注入父问答的压缩摘要", async () => {
    mocks.prisma.question.findUnique.mockResolvedValue({
      id: "question_parent", content: "上一轮问题",
      answer: { content: "上一轮回答", contextSummary: "历史背景摘要" },
    });
    await runAskTask({ question: "继续分析", parentQuestionId: "question_parent" }, ACTOR);

    expect(mocks.runAgentWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      history: [
        { role: "user", content: "上一轮问题" },
        { role: "assistant", content: "【会话上下文摘要】历史背景摘要" },
      ],
    }));
    const create = mocks.prisma.question.create.mock.calls[0]?.[0] as { data: { context: Record<string, unknown> } };
    expect(create.data.context.parentQuestionId).toBe("question_parent");
  });

  it("工作流失败时标记 failed 并抛出", async () => {
    mocks.runAgentWorkflow.mockRejectedValue(new Error("模型网关不可达"));
    await expect(runAskTask({ question: "会失败的问题" }, ACTOR)).rejects.toThrow(/任务问答执行失败/);
    const update = mocks.prisma.question.update.mock.calls[0]?.[0] as { data: { status: string } };
    expect(update.data.status).toBe("failed");
  });
});

describe("深度研究 runResearchTask", () => {
  it("创建问答与主任务、子任务落库、报告落库并返回 payload", async () => {
    const result = await runResearchTask({ question: "AI 眼镜市场格局如何？", depth: "standard" }, ACTOR);

    const questionCreate = mocks.prisma.question.create.mock.calls[0]?.[0] as { data: { context: Record<string, unknown> } };
    expect(questionCreate.data.context).toMatchObject({ kind: "deep_research", via: "mcp", depth: "standard" });
    // 主任务 + 1 个子任务
    expect(mocks.prisma.researchTask.create).toHaveBeenCalledTimes(2);
    const subCreate = mocks.prisma.researchTask.create.mock.calls[1]?.[0] as { data: { parentTaskId: string; agentType: string } };
    expect(subCreate.data.agentType).toBe("researcher");
    expect(subCreate.data.parentTaskId).toBe(result.taskId);

    expect(result).toMatchObject({
      status: "completed",
      objective: RESEARCH_RESULT.objective,
      report: RESEARCH_RESULT.report,
      subQuestionCount: 1,
      elapsedMs: 5000,
    });
    expect(result.taskId).toMatch(/^task_/);
    expect(result.citations).toHaveLength(1);
    // 主任务完成态落库
    const mainUpdates = mocks.prisma.researchTask.update.mock.calls.map((c) => c[0] as { where: { id: string }; data: { status?: string } });
    expect(mainUpdates.some((u) => u.where.id === result.taskId && u.data.status === "completed")).toBe(true);
  });

  it("sourceQuestionId 把已完成问答的结论注入研究背景", async () => {
    mocks.prisma.question.findUnique.mockResolvedValue({
      id: "question_src", content: "华东区为什么下降？", status: "completed",
      answer: { content: "渠道结构变化", contextSummary: "华东区下降的背景摘要" },
    });
    await runResearchTask({ question: "深入研究华东区", depth: "deep", sourceQuestionId: "question_src" }, ACTOR);

    expect(mocks.runDeepResearch).toHaveBeenCalledWith(expect.objectContaining({
      depth: "deep",
      sourceContext: expect.stringContaining("华东区下降的背景摘要"),
    }));
  });

  it("研究失败时问答与主任务都标记 failed 并抛出", async () => {
    mocks.runDeepResearch.mockRejectedValue(new Error("检索服务不可用"));
    await expect(runResearchTask({ question: "会失败的研究" }, ACTOR)).rejects.toThrow(/深度研究执行失败/);
    const questionUpdate = mocks.prisma.question.update.mock.calls[0]?.[0] as { data: { status: string } };
    expect(questionUpdate.data.status).toBe("failed");
    const taskUpdates = mocks.prisma.researchTask.update.mock.calls.map((c) => c[0] as { data: { status?: string } });
    expect(taskUpdates.some((u) => u.data.status === "failed")).toBe(true);
  });
});

describe("MCP 协议装配 createCauseMcpServer", () => {
  async function connect(deps: { ask?: (input: unknown) => Promise<AskTaskResult>; research?: (input: unknown) => Promise<ResearchTaskResult> }) {
    const received: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const server = createCauseMcpServer({
      ask: async (input) => {
        received.push({ tool: "ask", input });
        if (deps.ask) return deps.ask(input);
        return { questionId: "question_1", status: "completed", route: "direct", answer: "答案", chartCount: 0, tableCount: 0, citations: [], critique: null, elapsedMs: 1 };
      },
      research: async (input) => {
        received.push({ tool: "deep_research", input });
        if (deps.research) return deps.research(input);
        return { questionId: "question_2", taskId: "task_1", status: "completed", objective: "目标", report: "报告", subQuestionCount: 2, citations: [], elapsedMs: 2 };
      },
    });
    const client = new Client({ name: "mcp-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { client, received };
  }

  it("tools/list 恰好暴露 ask 与 deep_research", async () => {
    const { client } = await connect({});
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["ask", "deep_research"]);
    const ask = tools.find((t) => t.name === "ask");
    expect(ask?.inputSchema.required).toContain("question");
  });

  it("tools/call ask 返回 JSON 文本结果", async () => {
    const { client, received } = await connect({});
    const result = await client.callTool({ name: "ask", arguments: { question: "GMV 趋势如何？" } });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as AskTaskResult;
    expect(payload.questionId).toBe("question_1");
    expect(received[0]?.input.question).toBe("GMV 趋势如何？");
  });

  it("deep_research 缺省 depth 为 standard", async () => {
    const { client, received } = await connect({});
    await client.callTool({ name: "deep_research", arguments: { question: "市场格局研究" } });
    expect(received[0]?.input.depth).toBe("standard");
  });

  it("业务失败返回 isError 与 { code, message } 外壳", async () => {
    const { client } = await connect({ ask: async () => { throw new Error("任务问答执行失败: 模型网关不可达"); } });
    const result = await client.callTool({ name: "ask", arguments: { question: "会失败" } });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as { code: string; message: string };
    expect(body.code).toBe("ASK_FAILED");
    expect(body.message).toContain("模型网关不可达");
  });

  it("入参不合法（空问题）被协议层拒绝", async () => {
    const { client, received } = await connect({});
    const result = await client.callTool({ name: "ask", arguments: { question: "" } });
    expect(result.isError).toBe(true);
    expect(received).toHaveLength(0);
  });
});