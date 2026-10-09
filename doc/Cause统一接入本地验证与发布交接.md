# Cause 统一接入本地验证与发布交接

> 版本：v1.0
> 日期：2026-10-09
> 状态：本地实施及隔离验证完成；远端交付、生产配置与部署未执行

Cause 使用共享 `pt-ai` Realm、`pt-ai-cause` Client 和 `cause` Entry。用户确认没有存量用户/业务数据；服务器已有 schema/Prisma 历史仍须由管理员确认。当前接入合同为 [鉴权设计 v1.1](鉴权接入PT-AI-Access设计.md)。本次验证不等于生产验收。

## 本地证据

| 范围 | 结果与边界 |
|---|---|
| Cause 单元测试 | 191 通过、8 跳过；跳过的是未配置 Adjust 凭据的真实接口测试 |
| Cause 编译 | Node 24.7.0，Next production build 与类型检查通过；保留原有动态图谱文件 tracing 警告 |
| Cause lint | 未通过：原有 `lib/api-fetch.ts` 两个默认泛型 `any` 错误仍存在，未关闭规则或扩大类型重构范围；另有原有 warnings |
| 共享认证 | 全部共享包 build/test 通过；真实 PostgreSQL 事务回归 38 通过，两个浏览器项另外执行；Chrome 记住登录/普通会话持久化 2 通过 |
| 真实隔离认证 | Keycloak → Access → Cause：授权登录、无权限拒绝、旧 context 写拒绝、跨标签退出、保留 Identity SSO 后主动登录、切换账号通过；匿名业务首页无 JS 异常、只发起一次登录；后台 GET/HEAD 不推进活动时钟；正式构建产物也通过同一浏览器套件 |
| 撤权/停用 | 合成账号授权后，撤销 entitlement 或停用账号，已有会话下一次写请求立即返回 401，并撤销 Cause session；验证后恢复测试夹具 |
| 增量流式 | 实际 Cause API 和 Hook，在最终事件被暂缓时已显示第一段文本；完成后第二段出现。Foundation 为隔离 HTTP 夹具，已检查 Sol 别名与 low 请求参数；没有真实 Provider 推理 |
| Foundation 兼容 | 当前本地源码 `6118c26ce41f428a8078b343d9bd0a3476fe9f1b` 的原生 Responses 流式契约测试 5 通过；Foundation 没有本次源码改动 |
| Access | 服务测试 69 通过、5 跳过；Web 测试 16 通过；lint/typecheck/Web build 通过 |
| Identity 镜像 | 标准 Dockerfile 的 Maven 基础镜像下载超时，完整构建未通过。改用已缓存且 SPI 未改动的 Identity 基座＋当前主题＋正式 UI TGZ 资产的测试覆盖镜像，完成真实浏览器验证；不能代替上线镜像构建 |
| Workspace | 文档/治理校验通过；生产配置 opt-in 测试通过；布局检查因本任务功能分支与 registry 默认分支不一致而失败，未改 registry 绕过检查 |

认证 0.8.0 单包正式来源：Workspace `6f8337f80069678092bbc037a552166f4ed01184`。TGZ SHA-256：`91c8da78904a7e84e8ae03db72053fc5818c1193dedf7ab1971fa785726630c0`。见 [vendor 清单](../vendor/frontend/manifest.json)。确定性 pack、五消费者 pin、Cause npm lock integrity 均通过。旧四应用保留原认证包版本。

重现浏览器流程的入口为 [browser-auth.integration.mjs](../tests/browser-auth.integration.mjs)，只接 localhost/127.0.0.1 和显式合成账号夹具；它自行关闭浏览器，并使用无 Provider 的本地模型事件服务器。生产付费和正式 UAT 未执行。

## 平台侧负责

1. 按 CodeArts 独立仓库交付并审核：Workspace 来源/正式 TGZ/编排输入，Access 协调脚本/主题/目录；Cause 代码由 Rory 的管理员审核合入。当前均只做本地提交，不推送或自动合入。
2. Foundation 为 Cause 配置独立 Agent Token、Sol 模型路由/授权和预算；确认 `openai/gpt-5.6-sol` 是目标环境的实际别名，支持原生 Responses（含流式及工具调用）。low 已由 Cause 在请求中显式设置。不要把模型展示名直接当成可调用别名。
3. 在已批准的 runtime inputs 中设置 `cause.enabled=true` 和 `cause.appOrigin=https://cause.pmdevops.com`。配置独立 `causeOidcClientSecret`；若模式为 shadow/enforce，另需 `causeSessionStatusClientSecret`。生产秘密经受控渠道交付，不写代码/消息/PR。曾经公开过的旧 secret 不再沿用。
4. Access 管理员用 `config/catalog/cause.json` 登记草稿应用，核对实际 launch URL 和 `cause` ID，按需给测试人员授权；登记不自动赋予所有用户权限。Cause 实际上线后再更新为 connected/published。
5. 按 Foundation → Access → Workspace 管理的 Identity/配置发布并验证现有应用；补齐标准 Identity 镜像构建。向 Rory 提供确切平台提交/镜像、Issuer、回调注册、可达内部端点、会话模式和受控凭据。只有实际版本可用后才通知 Cause 发布。

## Rory / Cause 管理员负责

1. 审核并合入 Cause 分支，在自己的本地环境用正式 TGZ 和平台匹配配置复验；先处理已知 lint 门禁问题及目标环境未满足的构建条件，不能把本地合入当成上线完成。
2. 按 [部署手册](../deploy.md) 配置自己的宿主机：共享 Issuer、Client、Access 内部基址/secret、Foundation Gateway/Agent Token/Sol 别名，以及与平台相同的会话模式；enforce 使用专属受限 status 客户端。
3. 确认数据库迁移历史。空库正常 `db:deploy`；已通过 db push 建表的非空库先核对并 baselining，再应用认证增量迁移。可重复 `auth:migrate`，不重置库/删卷。发布包必须含 vendor 与迁移。
4. 等平台实际版本发上去并收到交接后，再构建发布 Cause。核验浏览器到 Identity 的 HTTPS，以及 Cause 后端到 Access/Foundation/Identity 内部端点的连通性；明确日志/告警与回退镜像。
5. 在真实环境验证授权、拒绝、撤权/停用、切换/旧流隔离、跨标签退出、过期恢复和 Sol low 增量文本；真实付费调用另按授权执行。记录真实版本和结果后，再由平台管理员发布应用入口。

## 本次未完成的范围

远端 push/MR/merge、生产应用登记/权限写入、秘密发放、平台及 Cause 上线、真实 Sol Provider 调用、真实 Identity enforce 模式联合验收与正式 UAT 都未执行。它们是后续有顺序和授权边界的发布工作，不是本地测试通过的延伸声明。
