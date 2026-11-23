import { z } from "zod";

/**
 * ask 结构化返回契约（纯 zod，无服务端依赖）：
 * 调用方（如 pt-ai-decision 定时同步）传入专用 responseSchema，
 * ask 工作流完成后从原始查询表格抽取符合该结构的行数据（structured.rows）。
 *
 * 形状刻意保持「扁平行数组」：定时消费场景（campaign × 日 × 指标）都是表格形，
 * 扁平字段可被动态 zod 严格校验，避免任意 JSON Schema 的校验器依赖。
 */

export const responseSchemaFieldSpec = z.object({
  name: z.string().min(1).max(64).describe("字段名（输出行的键名）"),
  type: z.enum(["string", "number", "integer", "boolean", "date"]).describe("字段类型；date 为 YYYY-MM-DD"),
  required: z.boolean().optional().describe("是否必填（默认 true）；false 时允许 null/缺失"),
  description: z.string().max(200).optional().describe("字段口径说明，注入抽取提示词"),
});

export const responseSchemaSpec = z
  .object({
    description: z.string().max(500).optional().describe("整体口径说明（如数据来源与聚合粒度）"),
    fields: z.array(responseSchemaFieldSpec).min(1, "至少一个字段").max(64, "字段过多"),
  })
  .refine((spec) => new Set(spec.fields.map((f) => f.name)).size === spec.fields.length, {
    message: "字段名不得重复",
    path: ["fields"],
  });

export type ResponseSchemaField = z.infer<typeof responseSchemaFieldSpec>;
export type ResponseSchemaSpec = z.infer<typeof responseSchemaSpec>;

/** 按字段规格构建行校验器：number/integer 容忍字符串数字（表格抽取常见），date 严格 ISO 日。 */
export function buildRowSchema(spec: ResponseSchemaSpec) {
  const shape: Record<string, z.ZodType> = {};
  for (const field of spec.fields) {
    let base: z.ZodType;
    switch (field.type) {
      case "string":
        base = z.string();
        break;
      case "number":
        base = z.coerce.number().finite();
        break;
      case "integer":
        base = z.coerce.number().int();
        break;
      case "boolean":
        base = z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]);
        break;
      case "date":
        base = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date 字段必须为 YYYY-MM-DD");
        break;
    }
    shape[field.name] = field.required === false ? base.nullable().optional() : base;
  }
  return z.object(shape);
}