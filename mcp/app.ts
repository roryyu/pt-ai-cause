import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  askToolShape, researchToolShape,
  ASK_TOOL_DESCRIPTION, RESEARCH_TOOL_DESCRIPTION,
  type AskTaskInput, type AskTaskResult,
  type ResearchTaskInput, type ResearchTaskResult,
} from "./protocol";

/**
 * MCP 服务装配：把两个业务任务注册为 MCP 工具（ask / deep_research）。
 * 与传输层解耦：server.ts 走 streamable-http，单测用 InMemoryTransport 直连。
 * 失败口径同 dsh 模块开发约束 B6：isError: true + JSON { code, message }。
 */

export const MCP_SERVER_NAME = "pt-ai-cause";

export interface CauseMcpDeps {
  ask(input: AskTaskInput): Promise<AskTaskResult>;
  research(input: ResearchTaskInput): Promise<ResearchTaskResult>;
}

const textContent = (value: unknown) => [{ type: "text" as const, text: JSON.stringify(value) }];
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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
  }, async (args) => {
    try {
      return { content: textContent(await deps.ask(args as AskTaskInput)) };
    } catch (error) {
      return { isError: true, content: textContent({ code: "ASK_FAILED", message: errorText(error) }) };
    }
  });

  server.registerTool("deep_research", {
    title: "深度研究",
    description: RESEARCH_TOOL_DESCRIPTION,
    inputSchema: researchToolShape,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (args) => {
    try {
      return { content: textContent(await deps.research(args as ResearchTaskInput)) };
    } catch (error) {
      return { isError: true, content: textContent({ code: "RESEARCH_FAILED", message: errorText(error) }) };
    }
  });

  return server;
}