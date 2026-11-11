import { timingSafeEqual } from "node:crypto";
import type { McpEnv } from "./config";

/** MCP 服务身份（落库为服务用户，与浏览器登录用户隔离） */
export interface McpActor {
  id: string;
  name: string;
  email: string;
  role: string;
}

export function serviceActor(env: McpEnv): McpActor {
  return {
    id: env.CAUSE_MCP_ACTOR_ID,
    name: env.CAUSE_MCP_ACTOR_NAME,
    email: env.CAUSE_MCP_ACTOR_EMAIL,
    role: "admin",
  };
}

/**
 * 校验 Authorization: Bearer <CAUSE_MCP_API_KEY>（恒定时间比较）。
 * 缺失、格式不符、长度不符或值不符一律拒绝；密钥本身不写入日志。
 */
export function isAuthorized(headers: Headers, expectedKey: string): boolean {
  const header = headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const presented = Buffer.from(match[1]!, "utf8");
  const expected = Buffer.from(expectedKey, "utf8");
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}