import { z } from "zod";

/**
 * MCP 工具协议（纯 zod，无服务端依赖）：工具入参形状与返回 payload 类型。
 * 与 dsh 插件 pt-ai-dsh-stack/plugins/cause 的工具白名单一一对应：
 *   ask → mcp__cause__ask；deep_research → mcp__cause__deep_research
 */

/** 任务问答入参（口径同 POST /api/v1/ask） */
export const askToolShape = {
  question: z.string().min(1).max(2000).describe("用户问题原文（数据分析 / 研究 / 直接回答由系统自动路由）"),
  parentQuestionId: z.string().optional().describe("多轮追问：上一轮问答返回的 questionId，取其会话上下文"),
  dataSourceIds: z.array(z.string()).optional().describe("限定分析的数据源 ID；不传用全部已接入数据源"),
  workspaceId: z.string().optional().describe("工作区 ID（可选）"),
};

/** 深度研究入参（口径同 POST /api/v1/research） */
export const researchToolShape = {
  question: z.string().min(4).max(2000).describe("研究问题（至少 4 个字）"),
  depth: z.enum(["standard", "deep"]).default("standard").describe("抓取深度：standard 每子问题深读 2 页，deep 深读 3 页"),
  sourceQuestionId: z.string().optional().describe("来源任务问答的 questionId：其结论作为研究背景注入"),
  workspaceId: z.string().optional().describe("工作区 ID（可选）"),
};

export const askToolInputSchema = z.object(askToolShape);
export const researchToolInputSchema = z.object(researchToolShape);
/** 调用方入参（z.input：depth 可省略，MCP 协议层按 zod default 补 standard） */
export type AskTaskInput = z.input<typeof askToolInputSchema>;
export type ResearchTaskInput = z.input<typeof researchToolInputSchema>;

/** 引用条目（编号与回答/报告正文中的 [n] 对应） */
export interface McpCitation {
  no: number;
  title: string;
  url: string;
}

/** 任务问答返回：完整答案在 answer；图表/表格全量数据落库，这里只给数量 */
export interface AskTaskResult {
  questionId: string;
  status: "completed";
  route: "direct" | "data_analysis" | "research";
  answer: string;
  chartCount: number;
  tableCount: number;
  citations: McpCitation[];
  critique: { score: number; passed: boolean } | null;
  elapsedMs: number;
}

/** 深度研究返回：完整报告在 report；子问题明细与证据落库可回看 */
export interface ResearchTaskResult {
  questionId: string;
  taskId: string;
  status: "completed";
  objective: string;
  report: string;
  subQuestionCount: number;
  citations: McpCitation[];
  elapsedMs: number;
}

export const ASK_TOOL_DESCRIPTION = [
  "（任务）Cause 归因平台的任务问答：对已接入的投放数据做自然语言分析（自动路由数据分析 / 研究 / 直接回答），同步返回最终答案。",
  "会在 Cause 系统创建问答记录（questionId 可用于追问或发起深度研究）。耗时通常 10 秒～2 分钟。",
  "返回 JSON：questionId、route、answer（Markdown 全文）、chartCount、tableCount、citations、critique、elapsedMs。",
].join("\n");

export const RESEARCH_TOOL_DESCRIPTION = [
  "（任务）Cause 归因平台的深度研究：规划子问题 → 并行检索与深读 → 证据抽取 → 流式成稿，同步返回完整研究报告。",
  "会在 Cause 系统创建研究记录（questionId / taskId）。耗时通常 2～10 分钟，请耐心等待，不要中途重复发起。",
  "返回 JSON：questionId、taskId、objective、report（Markdown 全文）、subQuestionCount、citations、elapsedMs。",
].join("\n");