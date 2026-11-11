import type { NextConfig } from "next";

/**
 * 安全响应头（design.md 12.4 安全默认：响应附加安全头）
 * 跨站请求验证与 Origin 检查将在 API 层迭代中实现
 */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // rewrite 代理默认 30 秒即销毁上游连接（Next proxy-request 的 proxyTimeout || 30000），
  // 而 /mcp 的 ask/deep_research 会挂起 10 秒～10 分钟：默认值会在 30 秒掐断长调用，
  // 表现为 Next→MCP socket hang up/ECONNRESET、客户端收到纯文本 500、后端任务却照常跑完落库。
  // 与 CAUSE_MCP_REQUEST_TIMEOUT_MS / 客户端 CAUSE_MCP_TIMEOUT_MS（默认 900000）对齐。
  experimental: {
    proxyTimeout: 900_000,
  },
  // Prisma 7 客户端运行时（含 query compiler WASM）不参与打包，作为服务端外部依赖加载
  // duck-duck-scrape / @extractus/article-extractor（linkedom DOM 实现）同样外置，避免打包异常
  serverExternalPackages: ["@prisma/client", "duck-duck-scrape", "@extractus/article-extractor"],
  // 把公网 /mcp 反代到内网 MCP 服务（docker 服务名 mcp:3101），dsh 即可直接用 https://<域名>/mcp 接入。
  // 目标可用 CAUSE_MCP_PROXY_TARGET 覆盖（本地联调指向 http://127.0.0.1:3101/mcp）。
  // Next 仅透传请求方法、Authorization 头与请求体；MCP 的专用 Bearer Key 鉴权由 MCP 服务自身负责。
  // 注意：deep_research 会把 POST 挂起最长约 10 分钟，ALB / Next 代理 / MCP 服务三处超时都须覆盖该耗时。
  async rewrites() {
    return [
      {
        source: "/mcp",
        destination: process.env.CAUSE_MCP_PROXY_TARGET ?? "http://mcp:3101/mcp",
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
