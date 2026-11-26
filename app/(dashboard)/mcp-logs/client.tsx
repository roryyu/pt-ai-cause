"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ScrollText, RefreshCw, Loader2, X, CheckCircle2, XCircle, Clock, ChevronLeft, ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api-fetch";

/**
 * MCP 日志（外部系统排障入口）
 * 外部系统经 MCP 调用 ask / deep_research 的每次工具调用流水：
 * 工具名、输入、输出、是否成功与耗时；详情弹窗展示完整输入/输出 JSON。
 * 数据来源：mcp/call-log.ts 落库 → /api/v1/mcp-logs。
 */

interface McpLogItem {
  id: string;
  tool: string;
  status: "running" | "completed" | "failed";
  input: { question?: string } & Record<string, unknown>;
  error?: string | null;
  questionId?: string | null;
  elapsedMs?: number | null;
  createdAt: string;
  completedAt?: string | null;
}

interface McpLogDetail extends McpLogItem {
  output?: Record<string, unknown> | null;
}

const TOOL_META: Record<string, { label: string; bg: string; fg: string }> = {
  ask: { label: "任务问答", bg: "var(--purple-pale)", fg: "var(--purple)" },
  deep_research: { label: "深度研究", bg: "var(--warning-pale)", fg: "var(--warning)" },
};

const STATUS_META: Record<McpLogItem["status"], { label: string; bg: string; fg: string }> = {
  running: { label: "执行中", bg: "var(--warning-pale)", fg: "var(--warning)" },
  completed: { label: "成功", bg: "var(--success-pale)", fg: "var(--success)" },
  failed: { label: "失败", bg: "var(--danger-pale)", fg: "var(--danger)" },
};

const PAGE_SIZE = 20;
/** 自动刷新间隔：深度研究单次可达 10 分钟，执行中的行需要持续跟进 */
const REFRESH_INTERVAL_MS = 15_000;

const inputStyle = {
  borderColor: "var(--line)",
  background: "var(--paper)",
  color: "var(--ink)",
} as const;

const formatTime = (iso: string) => new Date(iso).toLocaleString("zh-CN", { hour12: false });
const formatElapsed = (ms?: number | null) => {
  if (ms === undefined || ms === null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
};
const prettyJson = (value: unknown) => JSON.stringify(value ?? null, null, 2);

/** 工具徽章 */
function ToolBadge({ tool }: { tool: string }) {
  const meta = TOOL_META[tool] ?? { label: tool, bg: "var(--purple-pale)", fg: "var(--purple)" };
  return (
    <span className="rounded-full px-2 py-px text-xs font-medium" style={{ background: meta.bg, color: meta.fg }}>
      {meta.label}
      <code className="ml-1 font-mono text-[10px] opacity-70">{tool}</code>
    </span>
  );
}

/** 状态徽章 */
function StatusBadge({ status }: { status: McpLogItem["status"] }) {
  const meta = STATUS_META[status] ?? STATUS_META.running;
  const Icon = status === "completed" ? CheckCircle2 : status === "failed" ? XCircle : Clock;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-px text-xs font-medium"
      style={{ background: meta.bg, color: meta.fg }}
    >
      <Icon size={11} className={status === "running" ? "animate-pulse" : undefined} />
      {meta.label}
    </span>
  );
}

export function McpLogsClient() {
  const [logs, setLogs] = useState<McpLogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [toolFilter, setToolFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [detail, setDetail] = useState<McpLogDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const loadLogs = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (toolFilter) query.set("tool", toolFilter);
    if (statusFilter) query.set("status", statusFilter);
    const json = await apiFetch<{ logs: McpLogItem[]; total: number }>(`/api/v1/mcp-logs?${query}`);
    if (json.ok) {
      setLogs(json.data.logs ?? []);
      setTotal(json.data.total ?? 0);
      setError("");
    } else {
      setError(json.error?.message ?? "加载失败");
    }
    setLoading(false);
    setRefreshing(false);
  }, [page, toolFilter, statusFilter]);

  useEffect(() => {
    // 微任务延迟，避免 effect 内同步 setState（react-hooks/set-state-in-effect）
    Promise.resolve().then(() => loadLogs(true));
    const timer = setInterval(() => void loadLogs(true), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [loadLogs]);

  /** 打开详情：拉取完整输出（列表接口不带 output） */
  const openDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    const json = await apiFetch<McpLogDetail>(`/api/v1/mcp-logs/${id}`);
    if (json.ok) setDetail(json.data);
    else setError(json.error?.message ?? "详情加载失败");
    setDetailLoading(false);
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (loading) {
    return (
      <div className="flex justify-center py-24">
        <Loader2 size={24} className="animate-spin" style={{ color: "var(--purple)" }} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="flex items-center gap-2 text-lg font-bold" style={{ color: "var(--ink)" }}>
          <ScrollText size={19} style={{ color: "var(--purple)" }} />
          MCP 日志
        </h1>
        <p className="mt-0.5 text-sm" style={{ color: "var(--muted)" }}>
          外部系统经 MCP 调用任务问答（ask）与深度研究（deep_research）的输入、输出与执行结果
          <span className="ml-2 font-semibold" style={{ color: "var(--purple)" }}>共 {total} 条</span>
        </p>
      </header>

      {/* 筛选工具栏 */}
      <div
        className="flex flex-wrap items-center gap-3 rounded-[var(--radius-sm)] border px-4 py-3"
        style={{ borderColor: "var(--line)", background: "var(--surface)" }}
      >
        <label className="flex items-center gap-1.5 text-xs" style={{ color: "var(--ink-soft)" }}>
          工具
          <select
            value={toolFilter}
            onChange={(e) => { setToolFilter(e.target.value); setPage(1); }}
            className="rounded-[8px] border px-2.5 py-1.5 text-xs outline-none focus:border-[var(--purple)]"
            style={inputStyle}
          >
            <option value="">全部</option>
            <option value="ask">任务问答（ask）</option>
            <option value="deep_research">深度研究（deep_research）</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs" style={{ color: "var(--ink-soft)" }}>
          状态
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
            className="rounded-[8px] border px-2.5 py-1.5 text-xs outline-none focus:border-[var(--purple)]"
            style={inputStyle}
          >
            <option value="">全部</option>
            <option value="running">执行中</option>
            <option value="completed">成功</option>
            <option value="failed">失败</option>
          </select>
        </label>
        <button
          onClick={() => void loadLogs()}
          disabled={refreshing}
          className="ml-auto flex items-center gap-1.5 rounded-[8px] border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-black/5 disabled:opacity-50"
          style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}
        >
          <RefreshCw size={12} className={refreshing ? "animate-spin" : undefined} />
          刷新
        </button>
        <span className="text-[11px]" style={{ color: "var(--muted)" }}>每 15 秒自动刷新</span>
      </div>

      {error && (
        <p className="rounded-[8px] px-3 py-2 text-xs" style={{ background: "var(--danger-pale)", color: "var(--danger)" }}>
          {error}
        </p>
      )}

      {/* 调用流水表 */}
      <section
        className="overflow-hidden rounded-[var(--radius-sm)] border"
        style={{ borderColor: "var(--line)", background: "var(--surface)" }}
      >
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b" style={{ borderColor: "var(--line)", color: "var(--muted)" }}>
              <th className="px-4 py-2.5 font-medium">调用时间</th>
              <th className="px-3 py-2.5 font-medium">工具</th>
              <th className="px-3 py-2.5 font-medium">问题</th>
              <th className="px-3 py-2.5 font-medium">状态</th>
              <th className="px-3 py-2.5 font-medium">耗时</th>
              <th className="px-3 py-2.5 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id} className="border-b last:border-b-0 hover:bg-black/[0.02]" style={{ borderColor: "var(--line)" }}>
                <td className="whitespace-nowrap px-4 py-2.5" style={{ color: "var(--ink-soft)" }}>
                  {formatTime(log.createdAt)}
                </td>
                <td className="whitespace-nowrap px-3 py-2.5"><ToolBadge tool={log.tool} /></td>
                <td className="max-w-[360px] px-3 py-2.5">
                  <span className="block truncate" style={{ color: "var(--ink)" }} title={log.input?.question ?? ""}>
                    {log.input?.question ?? "—"}
                  </span>
                  {log.status === "failed" && log.error && (
                    <span className="block truncate text-[11px]" style={{ color: "var(--danger)" }} title={log.error}>
                      {log.error}
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2.5"><StatusBadge status={log.status} /></td>
                <td className="whitespace-nowrap px-3 py-2.5" style={{ color: "var(--ink-soft)" }}>
                  {formatElapsed(log.elapsedMs)}
                </td>
                <td className="whitespace-nowrap px-3 py-2.5">
                  <button
                    onClick={() => void openDetail(log.id)}
                    className="rounded-[6px] px-2 py-1 text-xs font-medium transition-colors hover:bg-black/5"
                    style={{ color: "var(--purple)" }}
                  >
                    详情
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {logs.length === 0 && (
          <p className="px-4 py-10 text-center text-xs" style={{ color: "var(--muted)" }}>
            暂无 MCP 调用记录（外部系统经 /mcp 端点调用 ask / deep_research 后自动记录）
          </p>
        )}
      </section>

      {/* 分页 */}
      <div className="flex items-center justify-end gap-3 text-xs" style={{ color: "var(--ink-soft)" }}>
        <span>第 {page} / {totalPages} 页</span>
        <button
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page <= 1}
          className="flex items-center gap-1 rounded-[8px] border px-2.5 py-1.5 transition-colors hover:bg-black/5 disabled:opacity-40"
          style={{ borderColor: "var(--line)" }}
        >
          <ChevronLeft size={12} />
          上一页
        </button>
        <button
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={page >= totalPages}
          className="flex items-center gap-1 rounded-[8px] border px-2.5 py-1.5 transition-colors hover:bg-black/5 disabled:opacity-40"
          style={{ borderColor: "var(--line)" }}
        >
          下一页
          <ChevronRight size={12} />
        </button>
      </div>

      {/* 详情弹窗：完整输入/输出 JSON */}
      {(detail || detailLoading) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgb(24 18 36 / 42%)" }}>
          <div
            className="flex max-h-[85vh] w-[min(760px,calc(100%-48px))] flex-col rounded-[var(--radius-sm)] border p-6"
            style={{ borderColor: "var(--line)", background: "#fff", boxShadow: "0 24px 80px rgb(28 18 48 / 24%)" }}
          >
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-base font-semibold" style={{ color: "var(--ink)" }}>
                MCP 调用详情
                {detail && <ToolBadge tool={detail.tool} />}
                {detail && <StatusBadge status={detail.status} />}
              </h2>
              <button onClick={() => setDetail(null)} className="rounded-full p-1 hover:bg-black/5" aria-label="关闭">
                <X size={18} style={{ color: "var(--muted)" }} />
              </button>
            </div>

            {detailLoading || !detail ? (
              <div className="flex justify-center py-16">
                <Loader2 size={20} className="animate-spin" style={{ color: "var(--purple)" }} />
              </div>
            ) : (
              <div className="mt-4 min-h-0 flex-1 space-y-4 overflow-y-auto">
                {/* 元信息 */}
                <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs" style={{ color: "var(--ink-soft)" }}>
                  <p>调用时间：{formatTime(detail.createdAt)}</p>
                  <p>结束时间：{detail.completedAt ? formatTime(detail.completedAt) : "—"}</p>
                  <p>耗时：{formatElapsed(detail.elapsedMs)}</p>
                  <p>
                    关联问答：
                    {detail.questionId
                      ? <code className="font-mono text-[11px]" style={{ color: "var(--purple)" }}>{detail.questionId}</code>
                      : "—"}
                  </p>
                  <p className="col-span-2">
                    日志 ID：<code className="font-mono text-[11px]" style={{ color: "var(--muted)" }}>{detail.id}</code>
                  </p>
                </div>

                {detail.error && (
                  <p className="whitespace-pre-wrap rounded-[8px] px-3 py-2 text-xs" style={{ background: "var(--danger-pale)", color: "var(--danger)" }}>
                    {detail.error}
                  </p>
                )}

                <JsonBlock title="输入（tools/call arguments）" value={detail.input} />
                {detail.status === "completed" && <JsonBlock title="输出（最终返回 payload）" value={detail.output} />}
                {detail.status === "running" && (
                  <p className="text-xs" style={{ color: "var(--muted)" }}>调用仍在执行中，完成后自动记录输出。</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** JSON 展示块（可折叠，默认展开输入） */
function JsonBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <details open className="rounded-[8px] border" style={{ borderColor: "var(--line)" }}>
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium" style={{ color: "var(--purple)" }}>
        {title}
      </summary>
      <pre
        className={cn("max-h-[320px] overflow-auto border-t px-3 py-2.5 font-mono text-[11px] leading-relaxed")}
        style={{ borderColor: "var(--line)", background: "var(--paper)", color: "var(--ink-soft)" }}
      >
        {prettyJson(value)}
      </pre>
    </details>
  );
}