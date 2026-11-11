/** 生成带 UTF-8 BOM 的 CSV，便于 Excel 正确识别中文。 */
export function serializeCsv(rows: readonly (readonly unknown[])[]): string {
  return "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function csvCell(value: unknown): string {
  let text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  // 防止外部文本被表格软件作为公式执行；正常的正负数、百分比仍保留原值。
  const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?%?$/.test(text.trim());
  if (typeof value === "string" && !numeric && /^[\s\p{Cc}]*[=+\-@]/u.test(text)) {
    text = "'" + text;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

/** 仅在用户点击时调用，不请求后端或重新执行查询。 */
export function downloadCsv(rows: readonly (readonly unknown[])[], title = "问答表格"): void {
  const blob = new Blob([serializeCsv(rows)], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const safeTitle = title.replace(/[<>:"/\\|?*\p{Cc}]/gu, "_").trim().slice(0, 100) || "问答表格";
  link.href = url;
  link.download = `${safeTitle}-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  link.hidden = true;
  try {
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    // 留出下载启动时间，再释放临时 URL。
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
