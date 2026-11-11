import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AgentEvent } from "@/lib/server/agents/events";
import {
  askToolShape, researchToolShape,
  ASK_TOOL_DESCRIPTION, RESEARCH_TOOL_DESCRIPTION,
  type AskTaskInput, type AskTaskResult,
  type ResearchTaskInput, type ResearchTaskResult,
} from "./protocol";

/**
 * MCP 服务装配：把两个业务任务注册为 MCP 工具（ask / deep_research）。
 * 与传输层解耦：server.ts 走 streamable-http（SSE 流式），单测用 InMemoryTransport 直连。
 * 失败口径同 dsh 模块开发约束 B6：isError: true + JSON { code, message }。
 */

export const MCP_SERVER_NAME = "pt-ai-cause";

export interface CauseMcpDeps {
  ask(input: AskTaskInput, sink?: (event: AgentEvent) => void): Promise<AskTaskResult>;
  research(input: ResearchTaskInput, sink?: (event: AgentEvent) => void): Promise<ResearchTaskResult>;
}

const textContent = (value: unknown) => [{ type: "text" as const, text: JSON.stringify(value) }];
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * 进度 sink：客户端带 _meta.progressToken 时把 phase 事件转成 MCP 进度通知
 * （SSE 帧持续流动，与 /ask 页面同模式）；未带时维持 stderr 日志口径。
 */
function progressSink(extra: RequestHandlerExtra<ServerRequest, ServerNotification>) {
  const token = extra._meta?.progressToken;
  if (token === undefined) return undefined;
  let progress = 0;
  return (event: AgentEvent): void => {
    if (event.type !== "phase") return;
    progress += 1;
    void extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken: token, progress, message: event.label },
    }).catch(() => {});
  };
}

export function createCauseMcpServer(deps: CauseMcpDeps): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool("ask", {
    title: "任务问答",
    description: ASK_TOOL_DESCRIPTION,
    inputSchema: askToolShape,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (args, extra) => {
    try {
      return { content: textContent(await deps.ask(args as AskTaskInput, progressSink(extra))) };
    } catch (error) {
      return { isError: true, content: textContent({ code: "ASK_FAILED", message: errorText(error) }) };
    }
  });

  server.registerTool("deep_research", {
    title: "深度研究",
    description: RESEARCH_TOOL_DESCRIPTION,
    inputSchema: researchToolShape,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (args, extra) => {
    try {
      return { content: textContent(await deps.research(args as ResearchTaskInput, progressSink(extra))) };
    } catch (error) {
      return { isError: true, content: textContent({ code: "RESEARCH_FAILED", message: errorText(error) }) };
    }
  });

  return server;
}