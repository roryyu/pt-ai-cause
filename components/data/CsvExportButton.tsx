"use client";

import { Download } from "lucide-react";
import { downloadCsv } from "@/lib/csv";

export function CsvExportButton({
  getRows,
  title,
}: {
  getRows: () => readonly (readonly unknown[])[];
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => downloadCsv(getRows(), title)}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] border px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--purple-pale)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--purple)]"
      style={{ borderColor: "var(--line)", color: "var(--purple)" }}
      title="导出当前表格的全部已加载数据为 CSV"
    >
      <Download size={14} aria-hidden="true" />
      导出为 CSV
    </button>
  );
}
