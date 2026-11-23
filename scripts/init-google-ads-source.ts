/**
 * Google Ads 数据源注册脚本（幂等，可重复执行）
 *
 * 注册/刷新 API 数据源「Google Ads」（cause.data_sources），config 与
 * POST /api/v1/datasources 的 google_ads 分支一致：固定官方 endpoint + 服务端 ADC，
 * 不存任何凭证；认证由 google-auth-library 默认凭据链提供。
 *
 * 运行：npx tsx scripts/init-google-ads-source.ts [--customer-id 1234567890] [--login-customer-id 9876543210]
 *   两个 ID 均可选（去掉连字符的 10 位数字）；缺省时 ask 会先走 accounts 发现账户，
 *   也可之后在数据源管理页的 Google Ads 面板保存默认账户。
 *
 * 前置：DATABASE_URL 指向的库须已执行 prisma migrate deploy
 * 幂等：按 name+type 定位，存在则刷新 config
 */
import { randomUUID } from "node:crypto";

export {}; // 标记为模块（顶层 await 需要）

process.loadEnvFile?.();

const idArg = (flag: string) => {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
};

// 动态导入：确保 .env 先于 env 校验加载（静态 import 会提升先于 loadEnvFile 执行）
const { prisma } = await import("../lib/db");
const { googleAdsSourceConfig } = await import("../lib/server/connectors/google-ads");

const config = JSON.stringify(googleAdsSourceConfig(idArg("--customer-id"), idArg("--login-customer-id")));
const existing = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
  "SELECT id FROM cause.data_sources WHERE name = $1 AND type = $2 LIMIT 1",
  "Google Ads", "api",
);
if (existing[0]) {
  await prisma.$executeRawUnsafe(
    "UPDATE cause.data_sources SET config = $2::jsonb WHERE id = $1",
    existing[0].id, config,
  );
  console.log(`✓ 数据源已存在，配置已刷新（${existing[0].id}）`);
} else {
  const sourceId = `data_source_${randomUUID()}`;
  await prisma.$executeRawUnsafe(
    "INSERT INTO cause.data_sources(id, name, type, connector_id, config) VALUES ($1, $2, $3, $4, $5::jsonb)",
    sourceId, "Google Ads", "api", "google-ads", config,
  );
  console.log(`✓ Google Ads 数据源已注册（${sourceId}）`);
}
console.log(`  config: ${config}`);
process.exit(0);