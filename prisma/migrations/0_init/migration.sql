-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "cause";

-- CreateEnum
CREATE TYPE "cause"."UserRole" AS ENUM ('admin', 'analyst', 'operator', 'viewer');

-- CreateEnum
CREATE TYPE "cause"."PermissionSubjectType" AS ENUM ('user', 'role', 'workspace');

-- CreateEnum
CREATE TYPE "cause"."PermissionResourceType" AS ENUM ('data_source', 'metric', 'report', 'board');

-- CreateEnum
CREATE TYPE "cause"."PermissionAction" AS ENUM ('read', 'write', 'admin');

-- CreateEnum
CREATE TYPE "cause"."DataSourceType" AS ENUM ('bi', 'api', 'mcp', 'web', 'browser');

-- CreateEnum
CREATE TYPE "cause"."MetricStatus" AS ENUM ('draft', 'published', 'deprecated');

-- CreateEnum
CREATE TYPE "cause"."ResearchState" AS ENUM ('queued', 'planning', 'collecting', 'analyzing', 'verifying', 'writing', 'reviewing', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "cause"."AgentType" AS ENUM ('supervisor', 'data_analyst', 'researcher', 'critic');

-- CreateEnum
CREATE TYPE "cause"."InsightDocKind" AS ENUM ('report', 'board', 'digest');

-- CreateEnum
CREATE TYPE "cause"."InsightDocStatus" AS ENUM ('draft', 'published', 'archived');

-- CreateEnum
CREATE TYPE "cause"."BindingSourceType" AS ENUM ('question', 'research', 'metric');

-- CreateEnum
CREATE TYPE "cause"."ScheduleAction" AS ENUM ('email', 'export');

-- CreateEnum
CREATE TYPE "cause"."DeliveryChannelType" AS ENUM ('email', 'image');

-- CreateEnum
CREATE TYPE "cause"."DeliveryStatus" AS ENUM ('queued', 'sent', 'failed');

-- CreateEnum
CREATE TYPE "cause"."AuditAction" AS ENUM ('create', 'read', 'update', 'delete', 'query', 'export', 'login', 'logout');

-- CreateTable
CREATE TABLE "cause"."users" (
    "id" TEXT NOT NULL,
    "username" TEXT,
    "email" TEXT,
    "name" TEXT NOT NULL,
    "department_id" TEXT,
    "role" "cause"."UserRole" NOT NULL DEFAULT 'viewer',
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cause"."auth_sessions" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "session_policy_version" INTEGER NOT NULL DEFAULT 0,
    "persistence_mode" TEXT NOT NULL DEFAULT 'session',
    "issuer" TEXT,
    "issuer_sid" TEXT,
    "idle_seconds" INTEGER NOT NULL DEFAULT 43200,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cause"."oidc_transactions" (
    "id" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "verifier" TEXT NOT NULL,
    "return_to" TEXT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "claimed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oidc_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cause"."workspaces" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "dataSourceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cause"."permissions" (
    "id" TEXT NOT NULL,
    "subject_type" "cause"."PermissionSubjectType" NOT NULL,
    "subject_id" TEXT NOT NULL,
    "resource_type" "cause"."PermissionResourceType" NOT NULL,
    "resource_id" TEXT NOT NULL,
    "action" "cause"."PermissionAction" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cause"."data_sources" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "cause"."DataSourceType" NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "connector_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cause"."metrics" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "formula" TEXT NOT NULL DEFAULT '',
    "unit" TEXT,
    "owner_id" TEXT NOT NULL,
    "status" "cause"."MetricStatus" NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "data_source_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cause"."semantic_models" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "data_source_id" TEXT,
    "table_ref" TEXT NOT NULL,
    "fields" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "semantic_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cause"."api_query_cache" (
    "id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "cache_key" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "content_type" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "elapsed_ms" INTEGER NOT NULL,
    "hit_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "api_query_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cause"."questions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "content" TEXT NOT NULL,
    "context" JSONB,
    "status" "cause"."ResearchState" NOT NULL DEFAULT 'queued',
    "answer" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cause"."research_tasks" (
    "id" TEXT NOT NULL,
    "question_id" TEXT NOT NULL,
    "parent_task_id" TEXT,
    "agentType" "cause"."AgentType" NOT NULL DEFAULT 'supervisor',
    "status" "cause"."ResearchState" NOT NULL DEFAULT 'queued',
    "input" JSONB,
    "output" JSONB,
    "citations" JSONB,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cause"."insight_docs" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "cause"."InsightDocKind" NOT NULL DEFAULT 'report',
    "description" TEXT NOT NULL DEFAULT '',
    "snapshot" JSONB NOT NULL DEFAULT '{}',
    "status" "cause"."InsightDocStatus" NOT NULL DEFAULT 'draft',
    "created_by" TEXT NOT NULL,
    "workspace_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "insight_docs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cause"."canvas_bindings" (
    "id" TEXT NOT NULL,
    "doc_id" TEXT NOT NULL,
    "shape_id" TEXT NOT NULL,
    "source_type" "cause"."BindingSourceType" NOT NULL,
    "source_id" TEXT,
    "query" JSONB,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "sourceStatus" TEXT NOT NULL DEFAULT 'unknown',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "canvas_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cause"."schedule_jobs" (
    "id" TEXT NOT NULL,
    "doc_id" TEXT NOT NULL,
    "action" "cause"."ScheduleAction" NOT NULL DEFAULT 'email',
    "cron_expr" TEXT NOT NULL,
    "recipients" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_run_at" TIMESTAMPTZ(3),
    "next_run_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "schedule_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cause"."delivery_records" (
    "id" TEXT NOT NULL,
    "doc_id" TEXT NOT NULL,
    "channel" "cause"."DeliveryChannelType" NOT NULL,
    "status" "cause"."DeliveryStatus" NOT NULL DEFAULT 'queued',
    "detail" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cause"."audit_logs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "action" "cause"."AuditAction" NOT NULL,
    "resource" TEXT NOT NULL,
    "resource_id" TEXT,
    "detail" JSONB,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "cause"."users"("email");

-- CreateIndex
CREATE INDEX "auth_sessions_subject_idx" ON "cause"."auth_sessions"("subject");

-- CreateIndex
CREATE INDEX "auth_sessions_expires_at_idx" ON "cause"."auth_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "oidc_transactions_expires_at_idx" ON "cause"."oidc_transactions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "api_query_cache_cache_key_key" ON "cause"."api_query_cache"("cache_key");

-- CreateIndex
CREATE INDEX "api_query_cache_source_id_idx" ON "cause"."api_query_cache"("source_id");

-- CreateIndex
CREATE INDEX "api_query_cache_expires_at_idx" ON "cause"."api_query_cache"("expires_at");

-- CreateIndex
CREATE INDEX "canvas_bindings_doc_id_idx" ON "cause"."canvas_bindings"("doc_id");

-- CreateIndex
CREATE INDEX "schedule_jobs_enabled_next_run_at_idx" ON "cause"."schedule_jobs"("enabled", "next_run_at");

-- CreateIndex
CREATE INDEX "delivery_records_doc_id_idx" ON "cause"."delivery_records"("doc_id");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_idx" ON "cause"."audit_logs"("user_id");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "cause"."audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_resource_resource_id_idx" ON "cause"."audit_logs"("resource", "resource_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "cause"."audit_logs"("created_at");

-- AddForeignKey
ALTER TABLE "cause"."workspaces" ADD CONSTRAINT "workspaces_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "cause"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cause"."metrics" ADD CONSTRAINT "metrics_data_source_id_fkey" FOREIGN KEY ("data_source_id") REFERENCES "cause"."data_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cause"."semantic_models" ADD CONSTRAINT "semantic_models_data_source_id_fkey" FOREIGN KEY ("data_source_id") REFERENCES "cause"."data_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cause"."questions" ADD CONSTRAINT "questions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "cause"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cause"."questions" ADD CONSTRAINT "questions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "cause"."workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cause"."research_tasks" ADD CONSTRAINT "research_tasks_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "cause"."questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cause"."insight_docs" ADD CONSTRAINT "insight_docs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "cause"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cause"."insight_docs" ADD CONSTRAINT "insight_docs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "cause"."workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cause"."canvas_bindings" ADD CONSTRAINT "canvas_bindings_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "cause"."insight_docs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cause"."schedule_jobs" ADD CONSTRAINT "schedule_jobs_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "cause"."insight_docs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cause"."delivery_records" ADD CONSTRAINT "delivery_records_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "cause"."insight_docs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cause"."audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "cause"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
