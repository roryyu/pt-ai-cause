import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/**
 * GET /api/v1/questions — 返回 questions 表数据（userId, content, context, status, createdAt）
 */
export async function GET() {
  const questions = await prisma.question.findMany({
    select: {
      userId: true,
      content: true,
      context: true,
      status: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(questions);
}
