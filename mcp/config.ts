import { z } from "zod";

/**
 * MCP 服务专属环境变量 Schema（与 lib/env.ts 的应用变量分开：应用本体不需要这些值）
 * 鉴权口径：专用 API Key（Bearer），不依赖浏览器登录、不开放匿名调用。
 * 新增变量须同步维护 .env.example 与 doc/mcp-service.md。
 */
export const mcpEnvSchema = z.object({
  /** 监听地址；默认只监听本机，跨机部署时显式覆盖并置于内网/网关之后 */
  CAUSE_MCP_HOST: z.string().min(1).default("127.0.0.1"),
  /** 监听端口（3100 已被 Next.js 应用占用） */
  CAUSE_MCP_PORT: z.coerce.number().int().min(1).max(65535).default(3101),
  /** 专用服务密钥：至少 32 字符，建议 openssl rand -hex 32 生成；缺失时拒绝启动（fail-closed） */
  CAUSE_MCP_API_KEY: z.string().min(32, "CAUSE_MCP_API_KEY 至少 32 字符（openssl rand -hex 32 生成）"),
  /** MCP 调用落库使用的服务用户（问答/研究的 userId），首次调用自动创建桩用户 */
  CAUSE_MCP_ACTOR_ID: z.string().min(1).default("user_mcp_service"),
  CAUSE_MCP_ACTOR_NAME: z.string().min(1).default("MCP 服务"),
  CAUSE_MCP_ACTOR_EMAIL: z.string().email().default("mcp-service@cause.local"),
  /** 单个 HTTP 请求超时：深度研究最长约 10 分钟，默认 15 分钟 */
  CAUSE_MCP_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(60_000).default(900_000),
});

export type McpEnv = z.infer<typeof mcpEnvSchema>;

/** 校验并返回 MCP 环境变量；失败立即抛错（fail fast），避免带病启动 */
export function parseMcpEnv(source: Record<string, string | undefined>): McpEnv {
  const parsed = mcpEnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`MCP 环境变量校验失败：\n${issues}\n请检查 .env 配置（参考 .env.example 的 MCP 服务一节）`);
  }
  return parsed.data;
}