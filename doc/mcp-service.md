# Cause MCP 服务（任务问答 / 深度研究）

> 版本 v1（2026-11-05）· 状态：已实现，协议层本地冒烟通过；真实问答/研究联调待模型网关与数据库就绪后验证。

把 pt-ai-cause 的两个核心能力作为 MCP 工具对外提供，供 DeepSeek Harness 的 `dsh-cause` 插件
（`pt-ai-dsh-stack/plugins/cause`）经子 agent 调用：

| MCP 工具 | 能力 | 对应应用接口 | 典型耗时 |
|---|---|---|---|
| `ask` | 任务问答（数据分析 / 研究 / 直接回答自动路由） | `POST /api/v1/ask` | 10 秒～2 分钟 |
| `deep_research` | 深度研究（规划 → 检索深读 → 成稿） | `POST /api/v1/research` | 2～10 分钟 |

## 1. 架构

```
dsh 主 agent ── run_cause_task ──> dsh-cause 插件 ── 启动子 agent ──> mcp__cause__ask / mcp__cause__deep_research
                                                                        │ streamable-http + Bearer
                                                                        ▼
                                                          mcp/server.ts（本服务，默认 3101）
                                                                        │ 直接调用（不经 HTTP/SSE 路由）
                                                                        ▼
                                              runAgentWorkflow / runDeepResearch + Prisma 落库
```

- 独立进程：`npm run mcp`（`tsx mcp/server.ts`），与 Next.js 应用（3100）分开运行，共用 `.env` 与数据库。
  长耗时研究不受 Next 路由 `maxDuration` 与反向代理超时约束；单请求超时由 `CAUSE_MCP_REQUEST_TIMEOUT_MS` 控制（默认 15 分钟）。
- 无状态 streamable-http：每个 `POST /mcp` 请求独立处理，无会话 ID；`GET /mcp` 返回 405。
- SSE 流式响应（同 `/ask` 页面模式）：工具调用阻塞到工作流完成才给出最终结果，但响应以 `text/event-stream`
  持续输出——SDK 每 15 秒自动发 keep-alive 注释帧，连接始终有数据流动，ALB 等按「空闲时长」计时的代理
  （默认 60 秒 idle）不会掐断长调用。客户端带 `_meta.progressToken` 时，phase 事件另转为
  `notifications/progress` 进度通知；stderr 运维日志恒开。
  **不要用 `enableJsonResponse`**：一次性 JSON 会让 POST 静默挂起数分钟，必被 idle 超时掐断
  （曾导致 Next 代理 30 秒 / ALB 60 秒处 500 + socket hang up，后端任务却照常跑完落库）。
- 落库口径与两个 API 路由一致：MCP 产生的问答/研究出现在平台历史列表，可回看、可被洞察画布引用，
  `context.via = "mcp"` 标明来源。差异：MCP 任务问答不写 Agent 轨迹明细（`research_tasks` 的 supervisor/worker/critic 行），
  深度研究的子任务照常落库。**修改任一侧持久化结构时须同步另一侧**（`mcp/tasks.ts` ↔ `app/api/v1/{ask,research}/route.ts`；
  会话上下文逻辑已抽到 `lib/server/agents/conversation.ts` 共用）。

## 2. 鉴权（专用 Key，不走浏览器登录）

- 所有 `POST /mcp` 必须带 `Authorization: Bearer <CAUSE_MCP_API_KEY>`；恒定时间比较，缺失/不符一律 401。
- `CAUSE_MCP_API_KEY` 至少 32 字符（`openssl rand -hex 32` 生成），缺失时服务**拒绝启动**（fail-closed），不开放匿名调用。
- 调用落库为服务用户（`CAUSE_MCP_ACTOR_ID`，默认 `user_mcp_service`，首次调用自动创建），与浏览器登录用户隔离。
- `GET /health` 探活无需鉴权。默认只监听 `127.0.0.1`；跨机部署显式改 `CAUSE_MCP_HOST` 并置于内网/网关之后。
- 密钥只放环境变量（`.env` 不提交）；调用方 dsh-stack 侧的 `CAUSE_MCP_TOKEN` 填同一个值。

## 3. 工具契约

返回均为 JSON 文本（`content[0].text`）；失败时 `isError: true` + `{ code, message }`（`ASK_FAILED` / `RESEARCH_FAILED`）。

### ask

入参：`question`（必填，1～2000 字）、`parentQuestionId`（追问：上一轮 questionId）、`dataSourceIds`、`workspaceId`。

返回：

```json
{
  "questionId": "question_…", "status": "completed",
  "route": "direct | data_analysis | research",
  "answer": "Markdown 全文",
  "chartCount": 1, "tableCount": 1,
  "citations": [{ "no": 1, "title": "…", "url": "…" }],
  "critique": { "score": 85, "passed": true },
  "elapsedMs": 12345
}
```

图表/表格全量数据落库（历史回看可见），MCP 只返回数量，避免撑爆调用方上下文。

### deep_research

入参：`question`（必填，4～2000 字）、`depth`（`standard` 默认 / `deep`）、`sourceQuestionId`（来源问答，其结论注入研究背景）、`workspaceId`。

返回：

```json
{
  "questionId": "question_…", "taskId": "task_…", "status": "completed",
  "objective": "研究目标", "report": "Markdown 全文",
  "subQuestionCount": 4,
  "citations": [{ "no": 1, "title": "…", "url": "…" }],
  "elapsedMs": 240000
}
```

## 4. 运行与联调

```bash
# .env：应用变量照常（DATABASE_URL / MODEL_GATEWAY_* / AUTH_SECRET），另加 MCP 一节（见 .env.example）
CAUSE_MCP_API_KEY=$(openssl rand -hex 32)   # 写入 .env，勿提交

npm run mcp                                  # 监听 http://127.0.0.1:3101/mcp

# 冒烟（协议层，不触 DB/模型）
curl -s http://127.0.0.1:3101/health
curl -s -X POST http://127.0.0.1:3101/mcp \
  -H "authorization: Bearer $CAUSE_MCP_API_KEY" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

dsh 侧接入：在 `pt-ai-dsh-stack` 根目录 `.env` 设

```bash
CAUSE_MCP_URL=http://127.0.0.1:3101/mcp
CAUSE_MCP_TOKEN=<与 CAUSE_MCP_API_KEY 同值>
# CAUSE_MCP_TIMEOUT_MS=900000   # 客户端单次工具调用超时，默认 15 分钟，须覆盖深研耗时
```

真实 `tools/call` 会创建问答/研究记录并调用模型网关（计费），联调时注意。

## 5. 代码与测试

| 文件 | 职责 |
|---|---|
| `mcp/config.ts` | MCP 专属环境变量 zod 校验（fail fast） |
| `mcp/auth.ts` | Bearer 恒定时间比较、服务身份 |
| `mcp/protocol.ts` | 工具入参形状与返回 payload 类型（纯 zod） |
| `mcp/tasks.ts` | 两个工具的业务实现与落库 |
| `mcp/app.ts` | McpServer 装配（与传输解耦，可 InMemoryTransport 直连测试） |
| `mcp/server.ts` | streamable-http 入口（node:http，无状态） |
| `tests/mcp-service.test.ts` | 16 个单测：env/鉴权/落库口径/协议装配（不连 DB、模型、网络） |

```bash
npx vitest run tests/mcp-service.test.ts
npm run typecheck
```

依赖：`@modelcontextprotocol/sdk`（已显式声明，^1.30.0）。

## 6. 已验证 / 待验证

- 已验证：单测 16 过；`tsc --noEmit` 无错误；本地启动后 `/health` 200、无令牌/错令牌 401、
  `initialize` 与 `tools/list` 正常（ask / deep_research，question 必填）。
- 待验证（需数据库与模型网关就绪）：真实 `tools/call ask` / `deep_research` 全链路、
  追问上下文注入、dsh 插件经子 agent 的端到端调用。