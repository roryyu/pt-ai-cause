import { ApiError, handleApiError, ok, requireActor } from "@/lib/server/api-runtime";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

/**
 * GET /api/v1/mcp-logs/[id] — 单条调用日志详情（含完整输出 output）
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireActor(request);
    const { id } = await params;
    const log = await prisma.mcpCallLog.findUnique({ where: { id } });
    if (!log) {
      throw new ApiError(404, "MCP_LOG_NOT_FOUND", "MCP 调用日志不存在");
    }
    return ok(log);
  } catch (error) {
    return handleApiError(error);
  }
}