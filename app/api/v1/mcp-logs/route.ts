import { z } from "zod";
import { handleApiError, ok, parsePagination, requireActor } from "@/lib/server/api-runtime";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

/** 列表筛选：工具名与执行状态 */
const ListQuerySchema = z.object({
  tool: z.enum(["ask", "deep_research"]).optional(),
  status: z.enum(["running", "completed", "failed"]).optional(),
});

/**
 * GET /api/v1/mcp-logs — MCP 调用日志列表（服务端分页，按时间倒序）
 * 列表不返回 output（研究报告可达数十 KB），完整输出走 /api/v1/mcp-logs/[id]
 */
export async function GET(request: Request) {
  try {
    await requireActor(request);
    const params = new URL(request.url).searchParams;
    const { tool, status } = ListQuerySchema.parse({
      tool: params.get("tool") || undefined,
      status: params.get("status") || undefined,
    });
    const { skip, take } = parsePagination(request.url);
    const where = { ...(tool ? { tool } : {}), ...(status ? { status } : {}) };

    const [logs, total] = await Promise.all([
      prisma.mcpCallLog.findMany({
        where,
        select: {
          id: true,
          tool: true,
          status: true,
          input: true,
          error: true,
          questionId: true,
          elapsedMs: true,
          createdAt: true,
          completedAt: true,
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.mcpCallLog.count({ where }),
    ]);
    return ok({ logs, total });
  } catch (error) {
    return handleApiError(error);
  }
}