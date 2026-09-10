# Kisaragirin OneBot

基于OneBot V11(Philia)的QQ机器人

已实现的功能：
- 群消息采集
- 消息与图片浏览
- @触发回复（支持merge_window合并）
- 闲时触发回复（沉默定时器 + 概率抽卡）
- 按群定时任务触发（crontab-like，支持触发前预研究）
- 两轮回复（支持深度研究agent）
- AgentHarness tool loop（`reply` 工具结束对话，支持消息数组与可选引用，`search_memory` 可在 loop 中多次调用）
- 手动 Compact（通过 harness.compact 触发会话压缩）
- 特殊消息类型（前情提要、系统消息）
- KV Store（持久化群元数据）
- 按群专属提示词（在 system prompt 人设之后注入群专属指令）
- Web面板：AgentHarness 会话日志查看（只读，按群过滤，新在前排序 + 前端分页，错误/中止消息高亮，支持条目 JSON 原文切换）

## 包管理

yarn

## 约束

- 遵循指令，而不是越俎代庖。对非{代码、文档}的文件的修改必须提前请示。git等会对文件产生影响的程序、命令必须提前请示。
- 优先使用成熟的库，避免造轮子。允许重构来保证代码始终为最优结构。
- `src/prompts.ts` 统一管理所有 LLM prompt（`Prompts` 类，带默认值，可被 `input.prompts` 覆盖），禁止在业务代码中硬编码 prompt
- 打日志必须用`lib/utl/logger.ts`
- `lib/` 是上游 SDK，不写业务逻辑
- 添加或修改功能、调整架构后需要更新README.md和AGENTS.md。
- 修复bug时，如果没有影响行为和架构，则不需要更新README.md和AGENTS.md。
- 完成修改后，bot部分的修改运行以下yarn任务：type:check, lint，webui部分非修改运行web:check, web:lint。所有warning、hint视同error处理。
- pi ai和pi agent的文档和源码保存在~/repos/their/pi
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
        index.ts            -- Database 连接工厂 + KV Store 工具 + 迁移逻辑 + 消息批量删除 helper
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
    graphiti-tool.ts    -- Graphiti 记忆工具（仅 search_memory），注册为 AgentTool 供 reply-agent 调用
    graphiti-client.ts  -- Graphiti Node.js 客户端（通过 stdio JSON-RPC 与 Python 服务通信）
    graphiti-episode.ts -- Graphiti episode 创建辅助（群消息 / bot 回复 / 深度研究结果共用）
    mem0-tool.ts        -- [已弃用] mem0 记忆工具
  prompts.ts            -- `Prompts` 类：所有 LLM prompt 的统一入口（默认值，可被 `input.prompts` 覆盖）
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
      group/[id].astro       -- 群消息 CRUD 浏览（分页表格 + 搜索 + 单条/批量删除 + 详情弹窗 + 按日期范围导入历史消息）
      group/[id]/preview.astro -- Prompt 预览（调用 ReplyAgent.buildPreviewPrompt）
      group/[id]/harness.astro -- AgentHarness 会话日志查看（调用 agent.getBranch，新在前排序 + 前端分页，错误/中止消息高亮，条目 JSON 原文切换）
      images.astro           -- 图片管理（分页 + 描述搜索 + 描述编辑）
      memories.astro         -- Graphiti 记忆管理（浏览 + 语义搜索 + 删除 + 实体图谱可视化：?view=graph 用 cytoscape.js 渲染实体事实网络，节点点击查看详情并可展开 1-hop 邻居，边点击查看事实并删除）
      api/
        images/...           -- 图片文件服务 + 描述管理 API
        memories/...         -- Graphiti REST API 封装（search / get_edges / get_edge / delete_edge / graph 子图 / graph 邻居）
        messages/delete.ts   -- 单条/批量删除消息 API
        preview-prompt.ts    -- Prompt 预览 API（调用 ReplyAgent.buildPreviewPrompt）
        compact.ts           -- 手动触发群消息 compact API
        harness.ts           -- AgentHarness 会话条目 API（调用 agent.getBranch）
        group/[id]/import.ts -- 按日期范围导入历史消息 API（调用 agent.importMessagesByDateRange）
```

### 关键组件关系

- **Bot 主进程** 持有唯一的 `better-sqlite3` 连接和 `DescQueue` 实例
- 启动时通过 `globalThis.__db__` / `globalThis.__queue__` / `globalThis.__config__` 暴露给 Astro
- `replyManagers`（`Map<number, GroupReplyManager>`）通过 `globalThis.__replyManagers__` 暴露给 Astro，使 webui 能按群号获取 `ReplyAgent`
- `GroupReplyManager` 通过 `GroupReplyManager.create(...)` 异步初始化，内部调用 `ReplyAgent.create(...)` 获取按群复用的 `AgentHarness`
- `ReplyAgent.create(...)` 使用 `harness-factory.ts` 的 `getOrCreateGroupSession` 获取/创建持久化 `Session`；新 session 不再自动从数据库导入历史消息，创建时会把 `lastTriggerId` 推进到该群最新消息 id（后续回复只处理新消息），历史上下文由 webui 按日期范围手动导入（`importMessagesByDateRange`，忽略 compact 消息）
- `models-factory.ts` / `credential-store.ts` 负责 pi-ai `Models` 单例、自定义 provider 注册与凭据填充；运行时 `config.ts` 导出 `models` 单例供 bot 使用
- `ScheduledTaskManager` 在 bot 登录信息就绪、群 `ReplyManager` 预初始化后启动；使用 Croner 注册 `input.scheduled_tasks` 中白名单群的任务
- Astro `middleware.ts` 提供 Basic Auth；页面直接查 DB 渲染 HTML
- `src/web/server.ts` 仅做 Node HTTP server 适配，把请求交给 Astro `handler`

### Prompt 构建封装

- `ReplyAgent.generateReply(task)` 触发回复时，以 `task.lastTriggerId` 为界从数据库读取该群所有新消息（排除 bot 普通聊天消息——它们已通过 `appendBotMessage` 注入 harness；`system`/`compact` 消息保留），通过 `buildUserPromptArray` 打包为单条 user message 发送给 `AgentHarness`
- `ReplyAgent.buildPreviewPrompt(task)` 复用同一逻辑，从 `task.lastTriggerId` 读取消息并构造 user message 预览，不修改 harness 状态
- `ReplyAgent.triggerCompact()` 提供手动 compact 入口，bot 和 webui 共用
- **bot 和 webui 共用同一入口**，避免两边逻辑偏差
- 所有 prompt 默认值集中在 `src/prompts.ts` 的 `Prompts` 类中，`input.prompts` 可在启动时覆盖任意成员（`applyPromptsOverrides`）；`prompts` 单例被 `reply-agent.ts` / `reply-tool.ts` / `desc-queue.ts` 共用
- `GroupReplyManager` 维护每群 `lastTriggerId`，回复完成后更新为本轮实际读入 prompt 的最大消息 id（`processedUpToId`），而非 bot 回复行 id——否则回复执行期间到达的新消息（id 小于 bot 回复行）会被永久跳过；新 session 创建时 `lastTriggerId` 由 `ReplyAgent.create` 推进到该群最新消息 id，历史上下文由 webui 按日期范围手动导入
- `GroupReplyManager.create(...)` 异步初始化 `ReplyAgent`，并通过 `getAgent()` 暴露给外部
- webui 的 Prompt 预览页面（`/group/{id}/preview`）通过 API 调用 `agent.buildPreviewPrompt()`，结果与 bot 实际发送给模型的 user messages 一致
- webui 的 compact API（`/api/compact`）调用 `agent.triggerCompact()` 强制 compact
- webui 的导入 API（`/api/group/{id}/import`）调用 `agent.importMessagesByDateRange(startTime, endTime)`，按本地时区当天起止时间戳查询消息导入 harness，忽略所有 compact 消息

### Agent Loop 与记忆机制

- **回复 Agent** (`reply-agent.ts`) 使用 `@earendil-works/pi-agent-core` 的 `AgentHarness` 类
- `AgentHarness` 自动处理 tool loop：LLM 调用工具 → 执行 → 结果回传 → 继续对话，支持多轮工具调用
- **Graphiti 工具** (`graphiti-tool.ts`) 注册为 `AgentTool`，仅包含 `search_memory`（agent 不主动添加记忆；episode 由 `graphiti-episode.ts` 的 `addMessageEpisode` 和 `addMergedMessagesEpisode` 自动创建：触发回复时（合并消息，内容与模型看到的 user message 一致）、bot 回复发送后、深度研究结果产生时）
- **记忆语言**：graphiti 服务端（`graphiti/server.py`）覆写 graphiti-core 官方语言扩展点 `get_extraction_language_instruction`（docstring 声明可 override；库默认文案 "Otherwise, output English." 是英文记忆的根因），统一注入简体中文指令，经 `generate_response` 覆盖全部生成型调用（事实/摘要/去重）；专有名词/昵称/引用原文保留不翻译
- 记忆工具在 tool loop 中可被多次调用（先搜索 → 看到结果 → 决定再搜索别的）
- **自动记忆搜索**：配置 `ai.assignments.memory_keyword` 后，每次触发回复时自动调用指定模型从全部最新消息生成搜索关键词，搜索 Graphiti 取最近 5 条记忆，注入到最后一条 user message 末尾（带 `--- 记忆自动检索 ---` 分割线）
- **回复工具** (`reply`) 设置 `terminate: true`，参数 `messages` 为消息数组（每条含 `text`，可选 `ref` 指向被引用消息的数据库 id），被调用后 Agent loop 立即退出
- **工具调用轮数限制**：通过 `input.max_tool_call_rounds`（默认 5）限制每轮 prompt 的非 `reply` 工具调用轮数。超过上限后通过 `tool_call` hook 阻止后续工具执行，并发送 reminder 提示词引导模型回复
- 如果 Agent loop 结束时未调用回复工具，或调用了回复工具但回复内容为空，自动发送 reminder 提示词重新引导（最多 2 次）；API 错误（`stopReason='error'/'aborted'`）同样进入 reminder 重试，且使用专用的错误 reminder 提示词（`prompts.replyErrorReminder`）
- **API 错误处理**：当模型返回 `stopReason='error'` 时，不会把错误内容当作正常回复；所有尝试（初始 prompt + 最多 2 次 reminder）均失败后进入失败回退
- **失败回退**：@触发第一轮失败返回 `@响应失败`，闲时触发则静默失败；深度研究第二轮失败时，引用第一轮即时回复消息并回复兜底文案（所有触发类型），文案按失败原因区分：深度研究本身失败回复 `深度研究失败`（`prompts.deepResearchFailedFallback`），研究成功但最终回复生成失败回复 `回复生成失败`（`prompts.deepResearchFinalFailedFallback`）
- **空任务跳过**：排队任务执行时若 `lastTriggerId` 之后无新消息（触发消息已被前序任务读入其 prompt），`generateFirstTurn` 返回 `noop: true`，静默跳过不发送失败回退
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
- `input.prompts`：按成员覆盖 `src/prompts.ts` 中 `Prompts` 类的默认 prompt（`Partial<Prompts>`），如 `rules`（群聊回复规则）、`deepResearchSystem`（深度研究提示词）；未覆盖的成员使用 `prompts.ts` 中的通用默认值。启动时由 `src/index.ts` 调用 `applyPromptsOverrides` 应用
- `input.scheduled_tasks`：按群号配置的定时任务（`Record<number, ScheduledGroupTask[]>`），字段包含 `name`、`cron`、`timezone`、`prompt`、`deep_research_topic`、`enabled`
- `ai.assignments.agent_harness`：驱动 `AgentHarness` 的模型 assignment（`string | ScheduledModelAssignment`）
- `ai.assignments.deep_research`：深度研究专用模型 assignment（`string | ScheduledModelAssignment`）
- `ai.assignments.memory_keyword`：记忆关键词生成模型 assignment，启用后每次回复前自动搜索相关记忆注入上下文（`string | ScheduledModelAssignment`）
- `ai.memoryKeyword`：记忆关键词生成模型的额外配置
  - `disable_thinking`：所用模型/端点默认开启深度思考时设为 `true`，调用时注入 `thinking=disabled`，默认 `false`
- `ai.assignments` 所有字段均支持 `ScheduledModelAssignment` 时段调度：配置 `slots`（含 `start`/`end`/`model`，支持跨日如 `18:00→09:00`）和 `default`，运行时按当前时间匹配第一个命中的 slot 模型，未命中则用 default；也可直接用字符串指定单一模型
- `ai.assignments` 所有字段（含 `slot.model` 和 `default`）均支持配置为**元组回退链**（`string[]`，即 `ModelAssignmentKey`）：API 错误时按数组顺序依次回退到下一个模型。harness 回复中回退不消耗 reminder 额度，回退链耗尽后才进入 reminder 重试；深度研究、记忆关键词、图片描述同理按链回退（`resolveAssignmentModels()` 返回按回退顺序排列的 `ModelEntry[]`）
- `ai.graphiti`：可选 Graphiti 配置，启用后通过 stdio JSON-RPC 连接 Python Graphiti 服务，`search_memory` 工具会加入 harness；记忆自动创建（触发回复时合并消息、bot 回复发送后、深度研究结果产生时）
- `ai.graphiti.debug_dump_rpc`：是否 dump Graphiti JSON-RPC 报文到 `data/debug/`，默认 `false`
- `ai.graphiti.llm.disable_thinking`：所用模型/端点默认开启深度思考时设为 `true`，server 侧给 AsyncOpenAI 客户端打补丁注入 `extra_body={"thinking": {"type": "disabled"}}`，默认 `false`

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
- `src/util/reply-agent.ts` — 回复Agent（基于 `AgentHarness` 的自动 tool loop，支持 Graphiti 记忆工具多轮调用）
- `src/util/harness-factory.ts` — AgentHarness `Session` 缓存与按群复用
- `src/util/models-factory.ts` — 模型注册、bot Models 单例与 assignment 解析
- `src/util/credential-store.ts` — pi-ai 凭据内存存储与初始化
- `src/util/reply-tool.ts` — 回复工具（`reply`）
- `src/util/scheduled-tasks.ts` — Croner 定时任务调度
- `src/util/graphiti-tool.ts` — Graphiti 记忆工具（仅 `search_memory`），注册为 `AgentTool`
- `src/util/graphiti-client.ts` — Graphiti Node.js 客户端（stdio JSON-RPC 通信）
- `src/util/graphiti-episode.ts` — Graphiti episode 创建辅助（`addMessageEpisode`，群消息 / bot 回复 / 深度研究结果共用）
- `src/util/mem0-tool.ts` — [已弃用] mem0 记忆工具
- `src/prompts.ts` — `Prompts` 类：所有 LLM prompt 的统一入口（默认值，可通过 `input.prompts` 覆盖）
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
