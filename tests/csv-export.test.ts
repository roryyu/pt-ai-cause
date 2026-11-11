import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeCsv, downloadCsv } from "@/lib/csv";
import { MarkdownView } from "@/components/agent/MarkdownView";
import { DataTable } from "@/components/data/DataTable";
import type { CsvExportButton } from "@/components/data/CsvExportButton";

type ExportProps = ComponentProps<typeof CsvExportButton>;
const captured = vi.hoisted(() => [] as ExportProps[]);
vi.mock("@/components/data/CsvExportButton", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/data/CsvExportButton")>();
  return {
    CsvExportButton: (props: ExportProps) => {
      captured.push(props);
      return createElement(actual.CsvExportButton, props);
    },
  };
});

beforeEach(() => { captured.length = 0; });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("CSV 导出", () => {
  it("保留中文、千分位、百分比，并转义逗号、双引号和换行", () => {
    expect(serializeCsv([
      ["渠道", "安装量", "占比"],
      ['渠道,"甲"\n第二行', "10,018,218", "57.13%"],
    ])).toBe('\uFEFF"渠道","安装量","占比"\r\n"渠道,""甲""\n第二行","10,018,218","57.13%"\r\n');
  });

  it("空值留空，保留零值、负数、原始精度和结构化值", () => {
    expect(serializeCsv([[null, undefined, 0, -12.3456789, false, { a: 1 }]]))
      .toBe('\uFEFF"","","0","-12.3456789","false","{""a"":1}"\r\n');
  });

  it("防止文本公式注入，但不改变正常的正负数和百分比", () => {
    expect(serializeCsv([["=1+1", " +SUM(A1)", "-cmd", "\t@SUM(A1)", "-12.5", "+3", "-2.5%"]]))
      .toBe('\uFEFF"\'=1+1","\' +SUM(A1)","\'-cmd","\'\t@SUM(A1)","-12.5","+3","-2.5%"\r\n');
  });

  it("创建下载文件，并清理临时链接与 URL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
    const link = { href: "", download: "", hidden: false, click: vi.fn(), remove: vi.fn() };
    const appendChild = vi.fn();
    vi.stubGlobal("document", { createElement: vi.fn(() => link), body: { appendChild } });
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:csv-test");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    downloadCsv([["渠道"], ["Web"]], "渠道/排名");
    expect(link.download).toBe("渠道_排名-2026-10-30T12-00-00-000Z.csv");
    expect(link.href).toBe("blob:csv-test");
    expect(appendChild).toHaveBeenCalledWith(link);
    expect(link.click).toHaveBeenCalledOnce();
    expect(link.remove).toHaveBeenCalledOnce();
    const blob = createUrl.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe("text/csv;charset=utf-8;");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes)).toBe('"渠道"\r\n"Web"\r\n');
    expect(revokeUrl).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeUrl).toHaveBeenCalledWith("blob:csv-test");
  });
});

describe("问答表格导出入口", () => {
  const markdown = '| 渠道 | 安装量 | 备注 |\n| --- | ---: | --- |\n| **Web** | 10,018,218 | [详情](https://example.com)与`代码` |\n| 自然量 | 12 | ![图示](https://example.com/icon.png) |';

  it("正文每张表各有独立按钮，导出纯文本而非 Markdown 标记", () => {
    const html = renderToStaticMarkup(createElement(MarkdownView, {
      content: `${markdown}\n\n其他说明\n\n| 第二张表 |\n| --- |\n| 独立数据 |`,
      exportTables: true,
    }));
    expect(captured).toHaveLength(2);
    expect(html.indexOf("导出为 CSV")).toBeLessThan(html.indexOf("<table"));
    expect(captured[0]!.getRows()).toEqual([
      ["渠道", "安装量", "备注"],
      ["Web", "10,018,218", "详情与代码"],
      ["自然量", "12", "图示"],
    ]);
    expect(captured[1]!.getRows()).toEqual([["第二张表"], ["独立数据"]]);
  });

  it("未启用导出时不影响其他 Markdown 使用场景，无表格时不显示按钮", () => {
    renderToStaticMarkup(createElement(MarkdownView, { content: markdown }));
    renderToStaticMarkup(createElement(MarkdownView, { content: "只有正文", exportTables: true }));
    expect(captured).toHaveLength(0);
  });

  it.each([true, false])("查询表格无论展开状态为 %s，都导出所有已加载行及原始精度", (defaultOpen) => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ amount: i + 0.123456, channel: `渠道${i}` }));
    renderToStaticMarkup(createElement(DataTable, {
      columns: ["channel", "amount"], rows, title: "查询结果", defaultOpen, exportable: true,
    }));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.getRows()).toEqual([["channel", "amount"], ...rows.map((row) => [row.channel, row.amount])]);
    expect(captured[0]!.getRows()).toHaveLength(21);
  });

  it("无标题表也可导出，查询表默认不启用导出", () => {
    renderToStaticMarkup(createElement(DataTable, { columns: ["值"], rows: [{ 值: 1 }], exportable: true }));
    expect(captured).toHaveLength(1);
    captured.length = 0;
    renderToStaticMarkup(createElement(DataTable, { columns: ["值"], rows: [{ 值: 1 }] }));
    expect(captured).toHaveLength(0);
  });
});
