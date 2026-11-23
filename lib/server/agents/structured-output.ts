import { z } from "zod";
import { chatCompletion } from "@/lib/server/model-gateway";
import type { TablePayload } from "./events";
import { buildRowSchema, type ResponseSchemaSpec } from "./response-schema";

/**
 * ask 结构化输出抽取（doc/periodic.md P0，pt-ai-decision 定时同步消费）：
 * 工作流完成后，以原始查询表格为唯一数值来源，按调用方 responseSchema 抽取扁平行数组。
 *
 * 不变量：
 * - 数值只能来自 tables（防止综合回答转述失真），不允许模型编造；
 * - 输出经动态 zod 严格校验，校验失败带问题清单重试一次，仍失败抛 StructuredOutputError
 *   （调用方本轮放弃、下轮重试，幂等同步不产生副作用）；
 * - 不改动数据分析/综合节点本身，structured 与 Markdown 答案并存。
 */

export class StructuredOutputError extends Error {
  readonly code = "STRUCTURED_OUTPUT_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "StructuredOutputError";
  }
}

/** 证据规模护栏：超出即拒绝抽取（调用方应缩小日期窗口/ campaigns 分批），防提示词与输出截断。 */
const MAX_EVIDENCE_ROWS = 20000;
const MAX_OUTPUT_TOKENS = 8192;

const EXTRACT_SYSTEM_PROMPT = [
  "你是结构化数据抽取引擎。任务：把给定的原始查询表格整理为符合字段规格的行数组。",
  "硬规则：",
  "1. 只输出一个 JSON 对象：{\"rows\":[...]}，不要输出任何解释、Markdown 或代码块以外的文本；",
  "2. 每个行对象的键名与字段规格完全一致；数值必须逐字来自原始表格，禁止推算、补零或编造；",
  "3. 表格中缺失的数值：字段允许为空时输出 null，必填字段无法凑齐时宁可少输出该行；",
  "4. date 字段输出 YYYY-MM-DD；number/integer 输出数字（不带千分位与单位）；",
  "5. 同一 campaign × 日在表格中若有多行（如按国家/渠道拆分），按字段规格口径聚合为一行（数值求和）。",
].join("\n");

function evidenceBlock(tables: TablePayload[]): string {
  const totalRows = tables.reduce((sum, t) => sum + t.rows.length, 0);
  if (totalRows > MAX_EVIDENCE_ROWS) {
    throw new StructuredOutputError(`原始表格共 ${totalRows} 行，超过 ${MAX_EVIDENCE_ROWS} 行上限，请缩小查询窗口或分批`);
  }
  return tables
    .map((t, i) => `表${i + 1}「${t.title}」${t.note ? `（${t.note}）` : ""}\n${JSON.stringify({ columns: t.columns, rows: t.rows })}`)
    .join("\n\n");
}

function specBlock(spec: ResponseSchemaSpec): string {
  const lines = spec.fields.map((f) =>
    `- ${f.name}（${f.type}${f.required === false ? "，可空" : "，必填"}）${f.description ? `：${f.description}` : ""}`);
  return `${spec.description ? `${spec.description}\n` : ""}字段规格：\n${lines.join("\n")}`;
}

/** 从模型输出提取 JSON（容忍 markdown 代码块包裹，口径同 supervisor.extractJson）。 */
function parseJson(raw: string): unknown {
  const text = raw.trim();
  try {
    return JSON.parse(text);
  } catch {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
    if (fenced) return JSON.parse(fenced[1]!.trim());
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new SyntaxError("输出不是合法 JSON");
  }
}

export interface ExtractStructuredInput {
  spec: ResponseSchemaSpec;
  question: string;
  tables: TablePayload[];
  dataSummary?: string;
}

/** 抽取并校验结构化行；失败重试一次后抛 StructuredOutputError。 */
export async function extractStructuredRows(input: ExtractStructuredInput): Promise<{ rows: Record<string, unknown>[] }> {
  const { spec, question, tables, dataSummary } = input;
  if (tables.length === 0) {
    throw new StructuredOutputError("数据分析未产出任何表格，无法抽取结构化结果（请检查问题是否命中已建模数据）");
  }
  const evidence = evidenceBlock(tables);
  const rowSchema = buildRowSchema(spec);
  const outputSchema = z.object({ rows: z.array(rowSchema) });

  const baseUser = `用户问题：${question}\n\n${specBlock(spec)}\n\n原始查询表格（数值唯一来源）：\n${evidence}${dataSummary ? `\n\n数据分析摘要（仅口径参考，数值以表格为准）：\n${dataSummary.slice(0, 2000)}` : ""}`;

  let lastIssues = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const userContent = attempt === 0
      ? baseUser
      : `${baseUser}\n\n上一次输出未通过校验，问题如下，请修正后重新输出完整 JSON：\n${lastIssues}`;
    const raw = await chatCompletion(
      [
        { role: "system", content: EXTRACT_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      { temperature: 0, maxTokens: MAX_OUTPUT_TOKENS },
    );
    let parsed: unknown;
    try {
      parsed = parseJson(raw);
    } catch (error) {
      lastIssues = `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`;
      continue;
    }
    const result = outputSchema.safeParse(parsed);
    if (result.success) return { rows: result.data.rows };
    lastIssues = result.error.issues
      .slice(0, 20)
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("；");
  }
  throw new StructuredOutputError(`结构化输出校验失败（已重试）：${lastIssues}`);
}