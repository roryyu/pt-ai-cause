/**
 * Cause MCP 服务入口（streamable-http，无状态模式）
 *
 * 把 pt-ai-cause 的任务问答与深度研究作为两个 MCP 工具对外提供，
 * 供 DeepSeek Harness 的 dsh-cause 插件（pt-ai-dsh-stack/plugins/cause）经子 agent 调用。
 *
 * 运行：npm run mcp（即 tsx mcp/server.ts）；先按 .env.example 配好应用变量与 MCP 一节。
 * 端点：POST /mcp（Bearer CAUSE_MCP_API_KEY）；GET /health 探活（无需鉴权）。
 * 设计与联调说明见 doc/mcp-service.md。
 */
process.loadEnvFile?.();

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parseMcpEnv } from "./config";
import { isAuthorized, serviceActor } from "./auth";

// fail fast：密钥缺失/过短直接拒绝启动，不开放匿名调用
const config = parseMcpEnv(process.env);
const actor = serviceActor(config);

// 依赖应用环境（lib/env）的模块在 loadEnvFile 之后动态加载（同 scripts/agent-smoke.ts 模式）
const { createCauseMcpServer } = await import("./app");
const { runAskTask, runResearchTask } = await import("./tasks");
const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.trim() ? JSON.parse(raw) : undefined;
}

function headersOf(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  }
  return headers;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? "/").split("?")[0];
  if (path === "/health") return json(res, 200, { ok: true, service: "pt-ai-cause-mcp" });
  if (path !== "/mcp") return json(res, 404, { code: "NOT_FOUND", message: "MCP 端点为 /mcp" });
  if (!isAuthorized(headersOf(req), config.CAUSE_MCP_API_KEY)) {
    return json(res, 401, { code: "UNAUTHORIZED", message: "缺少或无效的 Bearer 令牌" });
  }
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST", "content-type": "application/json" });
    res.end(JSON.stringify({ code: "METHOD_NOT_ALLOWED", message: "无状态模式仅支持 POST /mcp" }));
    return;
  }

  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    return json(res, 400, { code: "INVALID_REQUEST", message: "请求体不是合法 JSON" });
  }

  // 无状态：每个请求独立的 server + transport，响应结束即释放
  const server = createCauseMcpServer({
    ask: (input, sink) => runAskTask(input, actor, sink),
    research: (input, sink) => runResearchTask(input, actor, sink),
  });
  // SSE 流式响应（同 /ask 页面的模式）：SDK 每 15 秒自动发 keep-alive 注释帧，
  // 连接始终有数据流动，ALB 60 秒 idle 超时不会触发；最终结果仍是完整 JSON-RPC result。
  // 不用 enableJsonResponse：一次性 JSON 会让 POST 静默挂起数分钟，必被 idle 超时掐断。
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    console.error("[MCP] 请求处理异常:", error instanceof Error ? error.message : error);
    if (!res.headersSent) json(res, 500, { code: "INTERNAL", message: "MCP 请求处理失败" });
  }
}

const httpServer = createServer((req, res) => {
  void handle(req, res);
});
// 深度研究单次可达 10 分钟：请求超时须覆盖最长工具执行（默认 15 分钟）
httpServer.requestTimeout = config.CAUSE_MCP_REQUEST_TIMEOUT_MS;
httpServer.headersTimeout = 60_000;

httpServer.listen(config.CAUSE_MCP_PORT, config.CAUSE_MCP_HOST, () => {
  console.error(`[MCP] pt-ai-cause MCP 服务已启动：http://${config.CAUSE_MCP_HOST}:${config.CAUSE_MCP_PORT}/mcp（Bearer 鉴权，落库身份 ${actor.id}）`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}