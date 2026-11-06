import { prisma } from "@/lib/db";
import { chatCompletion } from "@/lib/server/model-gateway";
import {
  CONTEXT_SUMMARY_PROMPT, CONTEXT_SUMMARY_MAX_LENGTH,
  composeContextSummaryInput, fallbackContextSummary,
} from "./prompts";

/**
 * 多轮追问的会话上下文（自 app/api/v1/ask/route.ts 抽出，路由与 MCP 服务共用）
 *
 * 优先使用父问答持久化的压缩摘要（每轮完成时生成，已含全链历史）；
 * 存量记录无摘要时回退为原始问答链回溯（最多 4 轮）。
 */
export async function buildConversationContext(
  parentQuestionId?: string,
): Promise<{
  history: Array<{ role: "user" | "assistant"; content: string }>;
  prevSummary: string | null;
}> {
  if (!parentQuestionId) return { history: [], prevSummary: null };
  const parent = await prisma.question.findUnique({ where: { id: parentQuestionId } });
  if (!parent) return { history: [], prevSummary: null };

  const answer = (parent.answer ?? {}) as { content?: string; contextSummary?: string };
  if (answer.contextSummary?.trim()) {
    // 压缩上下文作为对话历史注入（单条即含全链背景，避免长原文撑爆各节点窗口）
    return {
      history: [
        { role: "user", content: parent.content },
        { role: "assistant", content: `【会话上下文摘要】${answer.contextSummary}` },
      ],
      prevSummary: answer.contextSummary,
    };
  }

  // 兜底：存量记录无摘要，回溯原始问答链（最多 4 轮）
  const history: Array<{ role: "user" | "assistant"; content: string }> = [];
  let cursorId: string | null = parentQuestionId;
  for (let depth = 0; depth < 4 && cursorId; depth++) {
    const cursor = depth === 0 ? parent : await prisma.question.findUnique({ where: { id: cursorId } });
    if (!cursor) break;
    const cursorAnswer = (cursor.answer ?? {}) as { content?: string };
    if (cursorAnswer.content) history.unshift({ role: "assistant", content: cursorAnswer.content.slice(0, 2000) });
    history.unshift({ role: "user", content: cursor.content });
    const ctx = (cursor.context ?? {}) as { parentQuestionId?: string };
    cursorId = ctx.parentQuestionId ?? null;
  }
  return { history, prevSummary: null };
}

/**
 * 增量压缩会话上下文：已有摘要 + 本轮问答 → 新摘要（随 answer 落库）
 * LLM 调用失败时降级为机械拼接，不阻塞主流程。
 */
export async function compressConversationContext(
  prevSummary: string | null,
  question: string,
  answerContent: string,
): Promise<string> {
  try {
    const summary = await chatCompletion(
      [
        { role: "system", content: CONTEXT_SUMMARY_PROMPT },
        { role: "user", content: composeContextSummaryInput(prevSummary, question, answerContent) },
      ],
      { temperature: 0, maxTokens: 800 },
    );
    const trimmed = summary.trim();
    return trimmed
      ? trimmed.slice(0, CONTEXT_SUMMARY_MAX_LENGTH)
      : fallbackContextSummary(prevSummary, question, answerContent);
  } catch (error) {
    console.warn("[ASK] 上下文压缩失败，采用机械拼接兜底:", error instanceof Error ? error.message : error);
    return fallbackContextSummary(prevSummary, question, answerContent);
  }
}