import { prisma } from "@/lib/db";
import { newId } from "@/lib/server/ids";
import { runAgentWorkflow } from "@/lib/server/agents/supervisor";
import { runDeepResearch } from "@/lib/server/agents/deep-research";
import { buildConversationContext, compressConversationContext } from "@/lib/server/agents/conversation";
import { researchSourceContextBlock, graphContextBlock } from "@/lib/server/agents/prompts";
import { loadGraph } from "@/lib/server/research-graph/store";
import { queryGraph } from "@/lib/server/research-graph/query";
import type { AgentEvent } from "@/lib/server/agents/events";
import type { McpActor } from "./auth";
import type {
  AskTaskInput, AskTaskResult, ResearchTaskInput, ResearchTaskResult,
} from "./protocol";

/**
 * MCP 两个工具的业务实现：任务问答（ask）与深度研究（deep_research）。
 *
 * 直接复用应用内的 Agent 工作流与 Prisma 落库，不经过 HTTP/SSE 路由；
 * 落库口径与 app/api/v1/ask/route.ts、app/api/v1/research/route.ts 保持一致
 * （MCP 产生的问答/研究同样出现在平台历史列表，可回看、可被洞察画布引用）。
 * 修改任一侧的持久化结构时须同步另一侧。
 *
 * 与路由的差异（有意为之）：
 * - 同步执行：工具调用阻塞到工作流完成，一次性返回最终结果（无 SSE）；
 * - 任务问答不写 Agent 轨迹明细（research_tasks 的 supervisor/worker/critic 行），
 *   仅落问答与答案；深度研究的子任务照常落库（研究详情页依赖）。
 */

/** 进度只写 stderr 供运维观察；MCP 调用方拿到的是最终结果 */
const logSink = (event: AgentEvent): void => {
  if (event.type === "phase") console.error(`[MCP] ${event.label}`);
};

/** 确保服务用户存在（口径同路由的 ensureUserExists） */
async function ensureUser(actor: McpActor): Promise<void> {
  const existing = await prisma.user.findUnique({ where: { id: actor.id } });
  if (!existing) {
    await prisma.user.create({
      data: { id: actor.id, email: actor.email, name: actor.name, role: "admin" },
    });
  }
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * 任务问答：创建问答 → 多 Agent 工作流 → 压缩会话上下文 → 落库 → 返回最终答案。
 * 失败时把问答标记为 failed 再抛出（MCP 层转为 isError 结果）。
 */
export async function runAskTask(input: AskTaskInput, actor: McpActor): Promise<AskTaskResult> {
  await ensureUser(actor);
  const { history, prevSummary } = await buildConversationContext(input.parentQuestionId);
  const questionId = newId("question");

  await prisma.question.create({
    data: {
      id: questionId,
      userId: actor.id,
      workspaceId: input.workspaceId || null,
      content: input.question,
      context: {
        kind: "ask",
        via: "mcp",
        ...(input.dataSourceIds ? { dataSourceIds: input.dataSourceIds } : {}),
        ...(input.parentQuestionId ? { parentQuestionId: input.parentQuestionId } : {}),
      },
      status: "analyzing",
    },
  });

  try {
    const result = await runAgentWorkflow({
      questionId,
      question: input.question,
      history,
      sink: logSink,
    });
    const contextSummary = await compressConversationContext(prevSummary, input.question, result.finalAnswer);

    // JSON.parse(JSON.stringify()) 将 TS interface 归一化为纯 JSON 值（Prisma Json 字段要求）
    const answerPayload = JSON.parse(JSON.stringify({
      content: result.finalAnswer,
      route: result.route,
      charts: result.dataFindings.charts,
      tables: result.dataFindings.tables,
      sql: result.dataFindings.sql,
      citations: result.researchFindings.citations,
      critique: result.critique,
      elapsedMs: result.elapsedMs,
      contextSummary,
    })) as object;
    await prisma.question.update({
      where: { id: questionId },
      data: { status: "completed", answer: answerPayload },
    });

    return {
      questionId,
      status: "completed",
      route: result.route,
      answer: result.finalAnswer,
      chartCount: result.dataFindings.charts.length,
      tableCount: result.dataFindings.tables.length,
      citations: result.researchFindings.citations,
      critique: result.critique ? { score: result.critique.score, passed: result.critique.passed } : null,
      elapsedMs: result.elapsedMs,
    };
  } catch (error) {
    const message = errorText(error);
    console.error("[MCP] 任务问答异常:", message);
    await prisma.question
      .update({ where: { id: questionId }, data: { status: "failed", answer: { error: message } } })
      .catch(() => {});
    throw new Error(`任务问答执行失败: ${message}`);
  }
}

/**
 * 深度研究：来源背景 + 图谱背景 → Planner/Executor/Synthesizer → 报告与子任务落库。
 * 失败时把问答与主任务标记为 failed 再抛出。
 */
export async function runResearchTask(input: ResearchTaskInput, actor: McpActor): Promise<ResearchTaskResult> {
  await ensureUser(actor);
  // MCP 协议层已按 zod default 补齐；直接调用方省略时同样落 standard
  const depth = input.depth ?? "standard";

  const questionId = newId("question");
  const taskId = newId("task");

  // 来源任务问答背景（口径同 research 路由）：源不存在/未完成时静默降级为无背景研究
  let sourceContext: string | undefined;
  if (input.sourceQuestionId) {
    const source = await prisma.question.findUnique({ where: { id: input.sourceQuestionId } });
    if (source && source.status === "completed") {
      const sourceAnswer = (source.answer ?? {}) as { content?: string; contextSummary?: string };
      const block = researchSourceContextBlock({
        question: source.content,
        contextSummary: sourceAnswer.contextSummary ?? null,
        answerContent: sourceAnswer.content ?? null,
      });
      if (block) sourceContext = block;
    }
  }

  // 研究知识图谱背景：空图/无命中/图谱不可用均静默跳过
  let graphContext: string | undefined;
  try {
    const graph = await loadGraph();
    const hits = queryGraph(graph, input.question);
    const block = graphContextBlock(hits);
    if (block) graphContext = block;
  } catch {
    // 图谱不可用不影响研究发起
  }

  await prisma.question.create({
    data: {
      id: questionId,
      userId: actor.id,
      workspaceId: input.workspaceId || null,
      content: input.question,
      context: {
        kind: "deep_research",
        via: "mcp",
        taskId,
        depth,
        ...(sourceContext && input.sourceQuestionId ? { sourceQuestionId: input.sourceQuestionId } : {}),
      },
      status: "planning",
    },
  });
  await prisma.researchTask.create({
    data: {
      id: taskId,
      questionId,
      agentType: "supervisor",
      status: "planning",
      input: { question: input.question, depth },
    },
  });

  try {
    // 子任务行 id（sub.id → rowId）：引用编号收敛重排后回写子任务产出
    const subTaskRowIds = new Map<string, string>();

    const result = await runDeepResearch({
      questionId,
      question: input.question,
      depth,
      sourceContext,
      graphContext,
      sink: logSink,
      onStateChange: async (state) => {
        await prisma.researchTask.update({ where: { id: taskId }, data: { status: state } }).catch(() => {});
        await prisma.question.update({ where: { id: questionId }, data: { status: state } }).catch(() => {});
      },
      onSubTask: async (sub) => {
        const rowId = newId("task");
        subTaskRowIds.set(sub.id, rowId);
        await prisma.researchTask
          .create({
            data: {
              id: rowId,
              questionId,
              parentTaskId: taskId,
              agentType: "researcher",
              status: "completed",
              input: { subQuestion: sub.question, rationale: sub.rationale, searchedQueries: sub.searchedQueries },
              output: { findings: sub.findings, evidence: sub.evidence ?? [], citationNos: sub.citationNos, elapsedMs: sub.elapsedMs },
              startedAt: new Date(Date.now() - sub.elapsedMs),
              completedAt: new Date(),
            },
          })
          .catch((err) => console.warn("[MCP] 研究子任务持久化失败:", err));
      },
    });

    // 回写子任务产出：收敛重排后的 citationNos 与主报告参考文献对齐（失败不阻断）
    for (const sub of result.subQuestions) {
      const rowId = subTaskRowIds.get(sub.id);
      if (!rowId) continue;
      await prisma.researchTask
        .update({
          where: { id: rowId },
          data: {
            output: {
              findings: sub.findings,
              evidence: sub.evidence ?? [],
              citationNos: sub.citationNos,
              elapsedMs: sub.elapsedMs,
            } as object,
          },
        })
        .catch((err) => console.warn("[MCP] 研究子任务重排回写失败:", err));
    }

    const answerPayload = JSON.parse(JSON.stringify({
      kind: "deep_research",
      content: result.report,
      objective: result.objective,
      subQuestions: result.subQuestions.map((sub) => ({
        id: sub.id,
        question: sub.question,
        findings: sub.findings,
        evidence: sub.evidence ?? [],
        citationNos: sub.citationNos,
        searchedQueries: sub.searchedQueries,
        elapsedMs: sub.elapsedMs,
      })),
      citations: result.citations,
      elapsedMs: result.elapsedMs,
      ...(result.graphStats ? { graphStats: result.graphStats } : {}),
      ...(result.review ? { review: result.review } : {}),
    })) as object;
    await prisma.question.update({
      where: { id: questionId },
      data: { status: "completed", answer: answerPayload },
    });
    await prisma.researchTask.update({
      where: { id: taskId },
      data: {
        status: "completed",
        output: {
          objective: result.objective,
          report: result.report,
          subQuestionCount: result.subQuestions.length,
          knowledgeAnswer: result.knowledgeAnswer ?? "",
        } as object,
        citations: JSON.parse(JSON.stringify(result.citations)) as object,
        completedAt: new Date(),
      },
    });

    return {
      questionId,
      taskId,
      status: "completed",
      objective: result.objective,
      report: result.report,
      subQuestionCount: result.subQuestions.length,
      citations: result.citations,
      elapsedMs: result.elapsedMs,
    };
  } catch (error) {
    const message = errorText(error);
    console.error("[MCP] 深度研究异常:", message);
    await prisma.question
      .update({ where: { id: questionId }, data: { status: "failed", answer: { kind: "deep_research", error: message } } })
      .catch(() => {});
    await prisma.researchTask
      .update({ where: { id: taskId }, data: { status: "failed", completedAt: new Date() } })
      .catch(() => {});
    throw new Error(`深度研究执行失败: ${message}`);
  }
}