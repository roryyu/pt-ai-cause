import { prisma } from "@/lib/db";
import { newId } from "@/lib/server/ids";

/**
 * MCP 调用日志：记录外部系统每次工具调用的工具名、输入、输出与是否成功。
 *
 * 口径：
 * - 执行前先落 running 行（进程中途崩溃也能看到未完成的调用），结束后回写 completed/failed；
 * - 成功时 output 存最终返回 payload，并提取 questionId 关联平台问答历史；
 * - 失败时 error 存错误信息，异常原样向上抛（MCP 层照常转 isError 结果）；
 * - 日志写入失败只打 stderr，绝不阻断业务调用。
 *
 * 由 mcp/server.ts 在装配 deps 时包裹 runAskTask / runResearchTask；
 * 查看入口为平台「MCP 日志」页（/mcp-logs，API /api/v1/mcp-logs）。
 */

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Prisma Json 字段要求纯 JSON 值 */
const toJson = (value: unknown): object => JSON.parse(JSON.stringify(value ?? {})) as object;

export async function withCallLog<T extends { questionId?: string }>(
  tool: string,
  input: unknown,
  run: () => Promise<T>,
): Promise<T> {
  const id = newId("mcp_log");
  const startedAt = Date.now();
  await prisma.mcpCallLog
    .create({ data: { id, tool, input: toJson(input) } })
    .catch((err) => console.warn("[MCP] 调用日志写入失败:", errorText(err)));

  try {
    const result = await run();
    await prisma.mcpCallLog
      .update({
        where: { id },
        data: {
          status: "completed",
          output: toJson(result),
          questionId: result.questionId ?? null,
          elapsedMs: Date.now() - startedAt,
          completedAt: new Date(),
        },
      })
      .catch((err) => console.warn("[MCP] 调用日志回写失败:", errorText(err)));
    return result;
  } catch (error) {
    await prisma.mcpCallLog
      .update({
        where: { id },
        data: {
          status: "failed",
          error: errorText(error),
          elapsedMs: Date.now() - startedAt,
          completedAt: new Date(),
        },
      })
      .catch((err) => console.warn("[MCP] 调用日志回写失败:", errorText(err)));
    throw error;
  }
}