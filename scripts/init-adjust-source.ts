/**
 * Adjust 数据源与语义初始化脚本（幂等，可重复执行）
 *
 * 面向服务器部署 / 全新数据库的一次性初始化入口，依次完成：
 * 1. 确保 data schema 存在（adjust-sync 的 ensureTable 只建表，schema 缺失会在建表时失败）
 * 2. 注册/刷新 API 数据源「Adjust 报告服务」（cause.data_sources；bearer 凭证取 ADJUST_API_TOKEN；
 *    名字是 adjust-sync.ts 挂载语义模型时血缘关联的锚点，勿改名）
 * 3. 经 runAdjustSync 完成语义初始化——挂载语义模型「Adjust 投放日指标」（5 维 / 16 指标，
 *    自动关联第 2 步的数据源）并补录 Adjust 口径指标定义（cause.metrics），随后按参数回补数据
 *
 * 运行：npx tsx scripts/init-adjust-source.ts [--days N | --from YYYY-MM-DD --to YYYY-MM-DD] [--reset]
 *   参数语义与 scripts/sync-adjust-data.ts 完全一致（缺省 --days 3：昨日 + 回补 2 天）
 *
 * 前置：DATABASE_URL 指向的库须已执行 prisma migrate deploy（cause schema 与业务表就绪）
 * 依赖 .env：ADJUST_API_TOKEN（必填）、DATABASE_URL、ADJUST_RS_API_BASE_URL（可选，缺省官方地址）
 * 幂等：数据源按 name+type 定位（存在则刷新 config，token 轮换后重跑即可），其余步骤均为 upsert / 先删后插
 */
import { randomUUID } from "node:crypto";

export {}; // 标记为模块（顶层 await 需要）

process.loadEnvFile?.();

if (!process.env.ADJUST_API_TOKEN) {
  console.error("缺少 ADJUST_API_TOKEN，请在 .env 中配置（Adjust 控制面板 → 账户设置 → 个人档案）");
  process.exit(1);
}

// --days N 解析（默认 3）；--from/--to 绝对日期区间，同时提供时优先于 --days
const daysArgIdx = process.argv.indexOf("--days");
const days = daysArgIdx >= 0 ? Math.max(1, Number(process.argv[daysArgIdx + 1]) || 3) : 3;
const fromIdx = process.argv.indexOf("--from");
const toIdx = process.argv.indexOf("--to");
const from = fromIdx >= 0 ? process.argv[fromIdx + 1] : undefined;
const to = toIdx >= 0 ? process.argv[toIdx + 1] : undefined;
const reset = process.argv.includes("--reset");

// 动态导入：确保 .env 先于 env 校验加载（静态 import 会提升先于 loadEnvFile 执行）
const { prisma } = await import("../lib/db");
const { env } = await import("../lib/env");
const { runAdjustSync } = await import("../lib/server/integrations/adjust-sync");

const log = (message: string) => console.log(message);

// ─── 1. data schema ──────────────────────────────────────────────────────────
await prisma.$executeRawUnsafe("CREATE SCHEMA IF NOT EXISTS data");
log("✓ data schema 就绪");

// ─── 2. 注册/刷新 API 数据源「Adjust 报告服务」 ─────────────────────────────
// config 组装与 POST /api/v1/datasources 的 api 分支保持一致
const config = JSON.stringify({
  endpoint: env.ADJUST_RS_API_BASE_URL,
  protocol: "rest",
  authType: "bearer",
  authToken: process.env.ADJUST_API_TOKEN,
});
const existing = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
  "SELECT id FROM cause.data_sources WHERE name = $1 AND type = $2 LIMIT 1",
  "Adjust 报告服务", "api",
);
let sourceId: string;
if (existing[0]) {
  sourceId = existing[0].id;
  await prisma.$executeRawUnsafe(
    "UPDATE cause.data_sources SET config = $2::jsonb WHERE id = $1",
    sourceId, config,
  );
  log(`✓ 数据源已存在，凭证配置已刷新（${sourceId}）`);
} else {
  sourceId = `data_source_${randomUUID()}`;
  await prisma.$executeRawUnsafe(
    "INSERT INTO cause.data_sources(id, name, type, connector_id, config) VALUES ($1, $2, $3, $4, $5::jsonb)",
    sourceId, "Adjust 报告服务", "api", "api", config,
  );
  log(`✓ 数据源已注册（${sourceId}）`);
}

// ─── 3. 语义初始化 + 数据回补（挂载语义模型/补录指标时自动关联上面的数据源） ───
try {
  const result = await runAdjustSync({ days, from, to, reset, onLog: log });
  if (result.skipped) log(`（本次跳过：${result.skipped}）`);
  log("✅ Adjust 数据源与语义初始化完成");
  process.exit(0);
} catch (err) {
  console.error("Adjust 数据源初始化失败:", err instanceof Error ? err.message : err);
  process.exit(1);
}
