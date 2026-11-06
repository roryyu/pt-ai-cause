/**
 * Cause MCP 服务独立联调脚本（零依赖，Node >= 18 直接运行，不需要 npm install）
 *
 * 用法：
 *   node tests/mcp-live.integration.mjs
 *   node tests/mcp-live.integration.mjs --url http://127.0.0.1:3101/mcp --token <CAUSE_MCP_API_KEY>
 *   node tests/mcp-live.integration.mjs --question "分析各渠道安装量情况"
 *
 * 参数优先级：命令行 > 环境变量（CAUSE_MCP_URL / CAUSE_MCP_TOKEN）> 默认值。
 * 默认问题「你好」走 direct 路由（约 10 秒）；换数据分析类问题可验证长耗时链路。
 *
 * 序列：GET /health → initialize → notifications/initialized → tools/list → tools/call ask。
 * 每一步打印耗时、HTTP 状态、响应头与正文；非 200 时完整保留错误 body，
 * 用于判别 500 的来源（约 29 秒稳定返回纯文本 Internal Server Error → API Gateway 集成超时）。
 *
 * 注意：tools/call 会在 Cause 系统真实创建问答记录并调用模型网关（计费）。
 */

// ---------- 参数解析 ----------
const argv = process.argv.slice(2);
function argOf(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  return fallback;
}

const MCP_URL = argOf("url", process.env.CAUSE_MCP_URL || "http://127.0.0.1:3101/mcp");
const TOKEN = argOf("token", process.env.CAUSE_MCP_TOKEN || process.env.CAUSE_MCP_API_KEY || "");
const QUESTION = argOf("question", process.env.MCP_QUESTION || "你好");
const TIMEOUT_MS = Number(argOf("timeout", process.env.CAUSE_MCP_TIMEOUT_MS || 900000));
const SKIP_ASK = argv.includes("--list-only");

const base = new URL(MCP_URL); // 非法 URL 直接抛错，fail fast
let nextId = 1;

function log(step, msg) {
  console.log(`[${new Date().toISOString()}] [${step}] ${msg}`);
}

// ---------- 单次 JSON-RPC POST（兼容 JSON 与 SSE 两种响应体） ----------
async function rpc(step, method, params, { expectResponse = true } = {}) {
  const body = { jsonrpc: "2.0", method, ...(expectResponse ? { id: nextId++ } : {}), ...(params ? { params } : {}) };
  const started = Date.now();
  log(step, `→ POST ${MCP_URL}  method=${method}`);

  let res;
  try {
    res = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    log(step, `✗ 网络层失败（耗时 ${Date.now() - started}ms）：${err.cause?.code || ""} ${err.message}`);
    throw err;
  }

  const headersElapsed = Date.now() - started;
  const text = await res.text();
  const elapsed = Date.now() - started; // SSE 模式下 headers 秒回、body 等流结束，计时以读完 body 为准
  log(step, `← HTTP ${res.status} ${res.statusText}（耗时 ${elapsed}ms${headersElapsed < elapsed ? `，首字节 ${headersElapsed}ms` : ""}）`);
  console.log(`  headers: ${JSON.stringify(Object.fromEntries(res.headers.entries()))}`);
  console.log(`  body(${text.length} chars): ${text.slice(0, 4000)}${text.length > 4000 ? " …(截断)" : ""}`);

  if (!res.ok) {
    const hint = res.status === 500 && text.trim() === "Internal Server Error" && elapsed > 20000
      ? `⚠ 纯文本 500 且耗时 ${(elapsed / 1000).toFixed(1)}s：符合 API Gateway 29s 集成超时指纹，请核对 URL 是否经 execute-api/网关`
      : "";
    if (hint) log(step, hint);
    throw new Error(`${step} 失败：HTTP ${res.status}，body 见上方日志`);
  }

  // 202（通知类）无 body；SSE 响应取最后一条 data: 消息
  if (res.status === 202 || !text.trim()) return { elapsed, message: null };
  let message;
  if ((res.headers.get("content-type") || "").includes("text/event-stream")) {
    const dataLines = text.split(/\r?\n/).filter((l) => l.startsWith("data:"));
    const last = dataLines[dataLines.length - 1];
    message = last ? JSON.parse(last.slice(5).trim()) : null;
  } else {
    message = JSON.parse(text);
  }
  if (message?.error) throw new Error(`${step} JSON-RPC 错误：${JSON.stringify(message.error)}`);
  return { elapsed, message };
}

// ---------- 主流程 ----------
async function main() {
  log("config", `URL=${MCP_URL}  token=${TOKEN ? TOKEN.slice(0, 4) + "****" : "(未设置)"}  question=${JSON.stringify(QUESTION)}  timeout=${TIMEOUT_MS}ms`);
  if (!TOKEN) log("config", "⚠ 未提供令牌：服务端开启鉴权时将得到 401（可用 --token 或 CAUSE_MCP_TOKEN 传入）");

  // 0) 探活（无需鉴权）：从 MCP URL 推导同源的 /health
  const healthUrl = new URL("/health", base);
  try {
    const t0 = Date.now();
    const h = await fetch(healthUrl, { signal: AbortSignal.timeout(10000) });
    log("health", `GET ${healthUrl} → HTTP ${h.status}（${Date.now() - t0}ms） ${await h.text()}`);
  } catch (err) {
    log("health", `探活失败（不阻断后续步骤）：${err.message}`);
  }

  // 1) initialize
  const init = await rpc("initialize", "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "cause-mcp-live-test", version: "1.0.0" },
  });
  log("initialize", `server: ${JSON.stringify(init.message?.result?.serverInfo)}`);

  // 2) notifications/initialized（无状态服务应返回 202）
  await rpc("initialized", "notifications/initialized", undefined, { expectResponse: false });

  // 3) tools/list
  const list = await rpc("tools/list", "tools/list", {});
  const tools = list.message?.result?.tools ?? [];
  log("tools/list", `工具：${tools.map((t) => t.name).join(", ") || "(空)"}`);

  if (SKIP_ASK) {
    log("done", "--list-only：跳过 tools/call，传输层验证通过");
    return;
  }
  if (!tools.some((t) => t.name === "ask")) throw new Error("tools/list 中没有 ask 工具，检查服务端版本");

  // 4) tools/call ask（真实落库 + 模型调用）
  const call = await rpc("tools/call", "tools/call", { name: "ask", arguments: { question: QUESTION } });
  const contentText = call.message?.result?.content?.[0]?.text;
  const isError = call.message?.result?.isError === true;
  let payload = null;
  try { payload = contentText ? JSON.parse(contentText) : null; } catch { /* 非 JSON 原样展示 */ }

  if (isError) {
    log("tools/call", `✗ 工具级错误（HTTP 200 + isError）：${contentText}`);
    process.exitCode = 1;
    return;
  }
  log("tools/call", `✓ 成功（总耗时 ${(call.elapsed / 1000).toFixed(1)}s）questionId=${payload?.questionId} route=${payload?.route} charts=${payload?.chartCount} tables=${payload?.tableCount}`);
  if (payload?.answer) console.log(`\n----- 答案全文 -----\n${payload.answer}\n--------------------`);
}

main()
  .then(() => log("done", `结束，exitCode=${process.exitCode || 0}`))
  .catch((err) => {
    console.error(`\n✗ 测试失败：${err.message}`);
    process.exitCode = 1; // 不用 process.exit()，让句柄自然排空（避免 Windows libuv 退出断言）
  });