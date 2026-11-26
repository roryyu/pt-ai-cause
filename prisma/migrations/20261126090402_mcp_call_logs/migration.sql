-- CreateTable
CREATE TABLE "mcp_call_logs" (
    "id" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "input" JSONB NOT NULL,
    "output" JSONB,
    "error" TEXT,
    "question_id" TEXT,
    "elapsed_ms" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "mcp_call_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mcp_call_logs_created_at_idx" ON "mcp_call_logs"("created_at");

-- CreateIndex
CREATE INDEX "mcp_call_logs_tool_status_idx" ON "mcp_call_logs"("tool", "status");
