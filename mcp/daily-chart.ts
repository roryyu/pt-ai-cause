import type { ChartSpec, TablePayload } from "@/lib/server/agents/events";
import type { DailyChart } from "./protocol";

function day(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function dailyChart(charts: ChartSpec[], tables: TablePayload[]): DailyChart | undefined {
  for (const chart of charts) {
    if (!chart || (chart.type !== "line" && chart.type !== "bar") || typeof chart.title !== "string"
      || chart.valueFormat === "percent" || chart.valueFormat === "wan"
      || typeof chart.xKey !== "string" || !Array.isArray(chart.yKeys)
      || chart.yKeys.length < 1 || chart.yKeys.length > 2 || new Set(chart.yKeys).size !== chart.yKeys.length
      || !chart.yKeys.every((key) => typeof key === "string" && key.trim() && key.length <= 80 && key !== chart.xKey)
      || !Array.isArray(chart.data) || chart.data.length < 2 || chart.data.length > 31) continue;
    if (!chart.data.every((row) => row && day(row[chart.xKey])
      && chart.yKeys.every((key) => typeof row[key] === "number" && Number.isFinite(row[key])))) continue;
    const dates = chart.data.map((row) => row[chart.xKey] as string);
    if (new Set(dates).size !== dates.length) continue;
    const matchingTable = tables.some((table) => table && Array.isArray(table.rows) && Array.isArray(table.columns)
      && table.rows.length === dates.length
      && [chart.xKey, ...chart.yKeys].every((key) => table.columns.includes(key))
      && chart.data.every((row) => table.rows.filter((item) => item && item[chart.xKey] === row[chart.xKey]).length === 1
        && table.rows.some((item) => item && item[chart.xKey] === row[chart.xKey]
          && chart.yKeys.every((key) => item[key] === row[key]))));
    if (!matchingTable) continue;
    return {
      title: chart.title.trim().slice(0, 120) || "每日趋势",
      labels: chart.yKeys.map((key) => {
        const label = chart.yKeys.length === 1 && typeof chart.yLabel === "string" ? chart.yLabel.trim() || key : key;
        const unit = typeof chart.unit === "string" ? chart.unit.trim() : "";
        return (unit ? `${label}（${unit}）` : label).slice(0, 80);
      }),
      days: chart.data.map((row) => ({
        date: row[chart.xKey] as string,
        values: chart.yKeys.map((key) => row[key] as number),
      })).sort((left, right) => left.date.localeCompare(right.date)),
    };
  }
}
