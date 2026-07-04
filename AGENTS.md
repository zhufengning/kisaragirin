# Kisaragirin OneBot

基于OneBot V11(Philia)的QQ机器人

已实现的功能：
- 群消息采集
- 消息与图片浏览
- @触发回复（支持merge_window合并）
- 闲时触发回复（沉默定时器 + 概率抽卡）
- 按群定时任务触发（crontab-like，支持触发前预研究）
- 两轮回复（支持深度研究agent）
- AgentHarness tool loop（`reply` 工具结束对话，`search_memory` / `add_memory` 可在 loop 中多次调用）
- 手动 Compact（通过 harness.compact 触发会话压缩）
- 特殊消息类型（前情提要、系统消息）
- KV Store（持久化群元数据）
- 按群专属提示词（在 system prompt 人设之后注入群专属指令）
- Web面板：AgentHarness 会话日志查看（只读，按群过滤）

## 包管理

yarn

## 约束

- 遵循指令，而不是越俎代庖。对非代码文件的修改必须提前请示。git等会对文件产生影响的程序、命令必须提前请示。
- 优先使用成熟的库，避免造轮子。允许重构来保证代码始终为最优结构。
- `src/prompts.ts` 统一管理所有 LLM prompt，禁止在业务代码中硬编码 prompt
- 打日志必须用`lib/utl/logger.ts`
- `lib/` 是上游 SDK，不写业务逻辑
- 添加或修改功能、调整架构后需要更新README.md和AGENTS.md。
- 修复bug时，如果没有影响行为和架构，则不需要更新README.md和AGENTS.md。
- 完成修改后，bot部分的修改运行以下yarn任务：type:check, lint，webui部分非修改运行web:check, web:lint。所有warning、hint视同error处理。
- pi ai和pi agent的文档和源码保存在~/repos/pi
- 其余库可通过context7查询文档
- 对于任何库，先阅读相关文档，再写代码
- 优先阅读文档，无法找到答案的，再阅读源代码
- 不到万不得已，禁止从node_modules中读取这些经过编译、压缩的代码。在此之前求助于文档，而不是你的记忆和想象
- 未经允许严禁私自运行服务和测试，禁止运行任何package.json中未定义的编译、打包、测试、类型检查指令.运行时必须通过yarn运行，禁止手动编写命令。
- 用户要求编辑配置文件，而没有要求编辑实例时，严禁对example做出任何修改。

## 架构设计

### 模块划分

```
src/
  index.ts              -- 入口：初始化 bot、db、queue、web panel
  config.ts             -- 根目录 TS 配置，使用 `@earendil-works/pi-ai` 的 `Model<Api>` 类型定义模型
  message-format.ts     -- OneBot 消息 ↔ 存储格式转换 + 渲染
  db/
    schema.ts           -- Drizzle SQLite 表定义（messages / images / kv_store）
    index.ts            -- Database 连接工厂 + KV Store 工具 + 迁移逻辑
  util/
    desc-queue.ts       -- 图片描述后台队列（多 Worker 并发，默认可配置 5 个）
    image-store.ts      -- 图片下载 + 本地存储
    image-preprocess.ts -- 图片转 jpg、压缩到 6MB 以下、动图切帧
    agent-retry.ts      -- Agent 调用通用指数退避重试封装
    credential-store.ts -- pi-ai 凭据内存存储与初始化
    models-factory.ts   -- 模型注册、bot Models 单例与 assignment 解析
    harness-factory.ts  -- AgentHarness `Session` 缓存与按群复用
    reply-tool.ts       -- 回复工具（`reply`），由 AgentHarness 调用
    reply-manager.ts    -- 群回复触发管理（@触发、闲时触发、单群FIFO队列）
    reply-agent.ts      -- 回复Agent（基于 `AgentHarness` 的自动 tool loop）
    scheduled-tasks.ts  -- Croner 定时任务调度，按群触发 ReplyManager
    mem0-tool.ts        -- mem0 记忆工具（search_memory / add_memory），注册为 AgentTool 供 reply-agent 调用
  prompts.ts            -- 所有 LLM prompt 的统一入口
  web/
    server.ts           -- Node.js HTTP server，加载 Astro handler

web/                  -- Astro 6.4 独立项目（SSR，Node middleware 模式）
  src/
    middleware.ts     -- Basic Auth
    lib/
      db.ts           -- 复用 globalThis.__db__（fallback 自建连接）
      queue.ts        -- 复用 globalThis.__queue__
    layouts/
      Layout.astro    -- 暗色主题全局布局
    pages/
      index.astro     -- 群列表
      group/[id].astro       -- 群消息浏览（分页，仅原始数据）
      group/[id]/preview.astro -- Prompt 预览（调用 ReplyAgent.buildPreviewPrompt）
      group/[id]/harness.astro -- AgentHarness 会话日志查看（调用 agent.getBranch）
      images.astro           -- 图片管理（分页 + 描述搜索 + 描述编辑）
      memories.astro         -- mem0 记忆管理（增删改查 + 语义搜索）
      api/
        images/...           -- 图片文件服务 + 描述管理 API
        memories/...         -- mem0 REST API 封装
        preview-prompt.ts    -- Prompt 预览 API（调用 ReplyAgent.buildPreviewPrompt）
        compact.ts           -- 手动触发群消息 compact API
        harness.ts           -- AgentHarness 会话条目 API（调用 agent.getBranch）
```

### 关键组件关系

- **Bot 主进程** 持有唯一的 `better-sqlite3` 连接和 `DescQueue` 实例
- 启动时通过 `globalThis.__db__` / `globalThis.__queue__` / `globalThis.__config__` 暴露给 Astro
- `replyManagers`（`Map<number, GroupReplyManager>`）通过 `globalThis.__replyManagers__` 暴露给 Astro，使 webui 能按群号获取 `ReplyAgent`
- `GroupReplyManager` 通过 `GroupReplyManager.create(...)` 异步初始化，内部调用 `ReplyAgent.create(...)` 获取按群复用的 `AgentHarness`
- `ReplyAgent.create(...)` 使用 `harness-factory.ts` 的 `getOrCreateGroupSession` 获取/创建持久化 `Session`；新 session 会从数据库读取该群历史消息并注入 harness
- `models-factory.ts` / `credential-store.ts` 负责 pi-ai `Models` 单例、自定义 provider 注册与凭据填充；运行时 `config.ts` 导出 `models` 单例供 bot 使用
- `ScheduledTaskManager` 在 bot 登录信息就绪、群 `ReplyManager` 预初始化后启动；使用 Croner 注册 `input.scheduled_tasks` 中白名单群的任务
- Astro `middleware.ts` 提供 Basic Auth；页面直接查 DB 渲染 HTML
- `src/web/server.ts` 仅做 Node HTTP server 适配，把请求交给 Astro `handler`

### Prompt 构建封装

- `ReplyAgent.generateReply(task)` 触发回复时，以 `task.lastTriggerId` 为界从数据库读取该群所有新消息，通过 `buildUserPromptArray` 打包为单条 user message 发送给 `AgentHarness`
- `ReplyAgent.buildPreviewPrompt(task)` 复用同一逻辑，从 `task.lastTriggerId` 读取消息并构造 user message 预览，不修改 harness 状态
- `ReplyAgent.triggerCompact()` 提供手动 compact 入口，bot 和 webui 共用
- **bot 和 webui 共用同一入口**，避免两边逻辑偏差
- `GroupReplyManager` 维护每群 `lastTriggerId`，回复完成后更新为最后一条 bot 回复的数据库 id；`ReplyAgent` 初始化时只将 `lastTriggerId` 及之前的历史消息 seed 进 harness
- `GroupReplyManager.create(...)` 异步初始化 `ReplyAgent`，并通过 `getAgent()` 暴露给外部
- webui 的 Prompt 预览页面（`/group/{id}/preview`）通过 API 调用 `agent.buildPreviewPrompt()`，结果与 bot 实际发送给模型的 user messages 一致
- webui 的 compact API（`/api/compact`）调用 `agent.triggerCompact()` 强制 compact

### Agent Loop 与记忆机制

- **回复 Agent** (`reply-agent.ts`) 使用 `@earendil-works/pi-agent-core` 的 `AgentHarness` 类
- `AgentHarness` 自动处理 tool loop：LLM 调用工具 → 执行 → 结果回传 → 继续对话，支持多轮工具调用
- **mem0 工具** (`mem0-tool.ts`) 注册为 `AgentTool`，包含 `search_memory` 和 `add_memory`
- 记忆工具在 tool loop 中可被多次调用（先搜索 → 看到结果 → 决定再搜索别的）
- **回复工具** (`reply`) 设置 `terminate: true`，被调用后 Agent loop 立即退出
- **工具调用轮数限制**：通过 `input.max_tool_call_rounds`（默认 5）限制每轮 prompt 的非 `reply` 工具调用轮数。超过上限后通过 `tool_call` hook 阻止后续工具执行，并发送 reminder 提示词引导模型回复
- 如果 Agent loop 结束时未调用回复工具，或调用了回复工具但回复内容为空，自动发送 reminder 提示词重新引导（最多 2 次）
- **API 错误处理**：当模型返回 `stopReason='error'` 时，直接按该轮失败处理，不会把错误内容当作正常回复；所有尝试（初始 prompt + 最多 2 次 reminder）均失败后进入失败回退
- **失败回退**：@触发返回 `@响应失败`（第一轮）或 `@深度研究失败`（第二轮），闲时触发则静默失败
- 深度研究使用 `@earendil-works/pi-ai` 的 `completeSimple()` 调用 `ai.assignments.deep_research` 指定模型，不经过 Agent loop；深度研究指令拼入 user message 以兼容 Hermes；若返回 `stopReason='error'` / `aborted` 或空结果，记录错误并用 fallback 文本继续第二轮
- 深度研究会向群内写入系统消息（`开始深度研究：{keyword}` / `深度研究结束：{keyword}`）到数据库，这些系统消息会随 `lastTriggerId` 之后的新消息一起被打包进 user message，供模型在后续回复中参考
- 深度研究后的第二轮回复消息会添加 `reply` segment 指向第一轮的即时回复消息

### 定时任务触发机制

- `input.scheduled_tasks` 按群号配置任务数组，群号必须同时存在于 `group_whitelist`
- 每个任务使用 Croner 注册 crontab-like 表达式，支持 5/6/7 字段、nickname、timezone，并启用 `protect` 防止同一任务重入
- 任务触发时由 `GroupReplyManager.triggerScheduledReply` 插入一条 `special_type='system'` 的系统消息，内容为任务自定义 `prompt`，再以 `type='scheduled'` 入单群 FIFO 队列
- 若任务配置 `deep_research_topic`，队列执行时会通过 `ReplyTask.preResearchTopic` 传递给 `ReplyAgent.generateReply`，将预研究开始/结束写入系统消息；随后继续走普通第一轮回复和可能的后续两轮回复流程
- 定时任务不会自动添加 reply segment，失败回退行为与闲时触发一致，静默失败

### Compact 机制

- `ReplyAgent.triggerCompact()` 委托给 `AgentHarness.compact()`，由 harness 内部管理会话上下文压缩
- Compact 摘要以 `special_type='compact'` 的消息插入数据库，渲染为 `**前情提要**: (内容)`
- 手动 compact 可通过 webui 的 `/api/compact` 触发
- `kv_store` 表持久化 `lastTriggerId`（数据库自增 `id`）和 harness session 元数据，重启后不丢失上下文边界

### AI 配置架构

配置统一放在根目录`config.ts`，`src/config.ts`为类型声明。每次添加新配置项，都需要更新config.example.ts。

- `input.vision_concurrency`：图片描述并发 Worker 数，默认 5
- `input.max_tool_call_rounds`：每轮回复中允许的非 `reply` 工具调用轮数上限，默认 5
- `input.group_custom_prompts`：按群号配置的专属提示词（`Record<number, string>`），注入在 system prompt 人设之后，有 `----- 本群专属提示 -----` 分割线
- `input.scheduled_tasks`：按群号配置的定时任务（`Record<number, ScheduledGroupTask[]>`），字段包含 `name`、`cron`、`timezone`、`prompt`、`deep_research_topic`、`enabled`
- `ai.assignments.agent_harness`：驱动 `AgentHarness` 的模型 assignment
- `ai.assignments.deep_research`：深度研究专用模型 assignment
- `ai.mem0`：可选 mem0 OSS 配置，启用后 `search_memory` / `add_memory` 工具会加入 harness

- `debug_dump_prompt`：是否将每次回复的 system prompt、user prompt、模型输出以及深度研究完整 prompt、provider payload、对话数据保存到 `data/debug/`，默认 `false`

通过`satisfies Model<Api>`让 TypeScript 在编译期校验模型字段，近似模型可复用基础对象后展开。

## 代码规范

### 命名约定
- 函数/变量：camelCase
- 类型/接口：PascalCase
- 常量：UPPER_SNAKE_CASE（局部）或 camelCase（模块级）

### 目录结构
- `lib/` — 上游 OneBot SDK，**禁止写业务逻辑**
- `src/` — 核心业务代码
- `web/` — Astro 前端项目，**与 `src/` 共享 DB schema 类型**

## 核心文件

- `src/index.ts` — 入口
- `src/message-format.ts` — 消息数据结构 + simple-id 序列化，`StoredMessage` 含内部自增 `id` 用于触发边界
- `src/db/schema.ts` — Drizzle 表定义（messages / images / kv_store）
- `src/util/desc-queue.ts` — 图片描述队列（使用 `@earendil-works/pi-agent-core` 的 `Agent` 调用 vision 模型）
- `src/util/image-store.ts` — 图片下载存储
- `src/util/image-preprocess.ts` — 发送给 LLM 前统一转 jpg、压缩、动图切帧
- `src/util/reply-manager.ts` — 群回复触发管理与队列
- `src/util/reply-agent.ts` — 回复Agent（基于 `AgentHarness` 的自动 tool loop，支持 mem0 记忆工具多轮调用）
- `src/util/harness-factory.ts` — AgentHarness `Session` 缓存与按群复用
- `src/util/models-factory.ts` — 模型注册、bot Models 单例与 assignment 解析
- `src/util/credential-store.ts` — pi-ai 凭据内存存储与初始化
- `src/util/reply-tool.ts` — 回复工具（`reply`）
- `src/util/scheduled-tasks.ts` — Croner 定时任务调度
- `src/util/mem0-tool.ts` — mem0 记忆工具（`search_memory` / `add_memory`），注册为 `AgentTool`
- `src/prompts.ts` — 所有 LLM prompt 的统一入口
- `src/web/server.ts` — Web 面板 Node adapter
- `lib/types/messages.ts` — OneBot 消息段类型

## 相关

- [docs/消息格式.md](docs/消息格式.md)
- [config.ts](config.ts)
- [package.json](package.json)
- [web/astro.config.mjs](web/astro.config.mjs)
- [web/tsconfig.json](web/tsconfig.json)


## 其他

- 只考虑数组格式消息，不考虑CQ码。允许使用napcat扩展，禁止在任何时候提及go-cqhttp
- api key绝不会出现在环境变量里
