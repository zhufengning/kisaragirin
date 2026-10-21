# Kisaragirin OneBot

基于OneBot V11(Philia)的QQ机器人

已实现的功能：
- 群消息采集（按群串行入库：每群一条 promise 链，保证数据库自增 id 与消息真实到达顺序一致，避免图片下载等入库前 await 造成乱序）
- 消息与图片浏览
- @触发回复（支持merge_window合并）
- 闲时触发回复（沉默定时器 + 概率抽卡）
- 按群定时任务触发（crontab-like，支持触发前预研究）
- 多轮回复（回合链：消息轮 + 可链式的深度研究轮，轮数上限可配置；模型可返回空消息数组主动选择不回复）
- AgentHarness tool loop（`reply` 工具结束对话，支持消息数组与可选引用，`search_memory` 可在 loop 中多次调用）
- 手动 Compact（通过 harness.compact 触发会话压缩）
- 特殊消息类型（前情提要、系统消息）
- KV Store（持久化群元数据）
- 按群专属提示词（在 system prompt 人设之后注入群专属指令）
- Web面板：AgentHarness 会话日志查看（只读，按群过滤，新在前排序 + 前端分页，错误/中止消息高亮，支持条目 JSON 原文切换）

## 包管理

pnpm

## 约束

- 遵循指令，而不是越俎代庖。对非{代码、文档}的文件的修改必须提前请示。git等会对文件产生影响的程序、命令必须提前请示。
- 优先使用成熟的库，避免造轮子。允许重构来保证代码始终为最优结构。
- `src/prompts.ts` 统一管理所有 LLM prompt（`Prompts` 类，带默认值，可被 `input.prompts` 覆盖），禁止在业务代码中硬编码 prompt
- 打日志必须用`lib/utl/logger.ts`
- `lib/` 是上游 SDK，不写业务逻辑
- 添加或修改功能、调整架构后需要更新README.md和AGENTS.md。
- 修复bug时，如果没有影响行为和架构，则不需要更新README.md和AGENTS.md。
- 完成修改后，bot部分的修改运行以下pnpm任务：type:check, lint，webui部分非修改运行web:check, web:lint。所有warning、hint视同error处理。
- pi ai和pi agent的文档和源码保存在~/repos/their/pi
- 其余库可通过context7查询文档
- 对于任何库，先阅读相关文档，再写代码
- 优先阅读文档，无法找到答案的，再阅读源代码
- 不到万不得已，禁止从node_modules中读取这些经过编译、压缩的代码。在此之前求助于文档，而不是你的记忆和想象
- 未经允许严禁私自运行服务和测试，禁止运行任何package.json中未定义的编译、打包、测试、类型检查指令.运行时必须通过pnpm运行，禁止手动编写命令。
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
    image-preprocess.ts -- 图片按大小上限压缩、长边与总像素按上限缩小、动图切帧，帧的mimeType按实际字节格式给出
    agent-retry.ts      -- Agent 调用通用指数退避重试封装
    credential-store.ts -- pi-ai 凭据内存存储与初始化
    models-factory.ts   -- 模型注册、bot Models 单例与 assignment 解析
    harness-factory.ts  -- AgentHarness `Session` 缓存与按群复用
    reply-tool.ts       -- 回复工具（`reply`），由 AgentHarness 调用
    reply-task.ts       -- `ReplyTask` / `ScheduledReplyTask` 任务类型
    reply-prompt.ts     -- 回复 system prompt 与 user message 构建
    reply-debug.ts      -- 回复流程的 `data/debug/` 调试导出
    memory-context.ts   -- 记忆关键词生成与 Graphiti 检索（含已注入记忆去重提取）
    deep-research.ts    -- 深度研究执行（模型路径 / pi rpc 路径）+ 开始/结果/结束系统消息写入
    reply-manager.ts    -- 群回复触发管理（@触发、闲时触发、单群FIFO队列、回合链编排）
    reply-sender.ts     -- 回复发送、落库、引用解析与 Graphiti episode 写入
    reply-agent.ts      -- 回复Agent（基于 `AgentHarness` 的自动 tool loop）
    pi-rpc-client.ts    -- pi CLI rpc 模式子进程客户端（深度研究）
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
      format-date.ts       -- 统一的时间展示格式
      messages-query.ts    -- 群消息页服务端数据加载与 URL 构建
      messages-render.ts   -- 群消息页渲染辅助（预览文本、发送者单元格、类型徽标）
      messages-actions.ts  -- 群消息页操作（导入、compact、清空、单条/批量删除）
      messages-detail-modal.ts -- 群消息详情弹窗
      messages-client.ts   -- 群消息页客户端入口
      memories-query.ts    -- 记忆管理页服务端数据加载与 URL 构建
      memories-graph.ts    -- 记忆实体图谱视图（cytoscape 布局、选中、悬浮提示）
      memories-panel.ts    -- 记忆图谱详情面板渲染
      memories-client.ts   -- 记忆管理页客户端入口
      harness-entry.ts     -- Harness 日志条目渲染与筛选
      harness-client.ts    -- Harness 日志页客户端入口
    styles/
      messages.css     -- 群消息页样式
      memories.css     -- 记忆管理页样式
      harness.css      -- Harness 日志页样式
    layouts/
      Layout.astro    -- 暗色主题全局布局
    pages/
      index.astro     -- 群列表
      group/[id].astro       -- 群消息 CRUD 浏览（分页表格 + 搜索 + 单条/批量删除 + 详情弹窗[带图片的消息同时展示图片描述，含 reply/forward 嵌套图片] + 按日期范围导入历史消息）
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

- `ReplyAgent.runMessageTurn(task)`（每个任务的第一个回合）触发回复时，以 `task.lastTriggerId` 为界从数据库读取该群所有新消息（排除 bot 普通聊天消息——它们已通过 `appendBotMessage` 注入 harness；`system`/`compact` 消息保留），通过 `reply-prompt.ts` 的 `buildUserPromptArray` 打包为单条 user message 发送给 `AgentHarness`；后续深度研究轮由 `ReplyAgent.runResearchTurn(task, topic, boundary)` 执行（先由 `deep-research.ts` 研究并写系统消息，再读入期间新消息，以 `prompts.deepResearchTurnGuidance` 引导语 prompt），两个回合共用 `promptAndCollect`（append + prompt + reminder + 结果解析）
- `ReplyAgent.buildPreviewPrompt(task)` 复用同一逻辑，从 `task.lastTriggerId` 读取消息并构造 user message 预览，不修改 harness 状态
- `ReplyAgent.triggerCompact()` 提供手动 compact 入口，bot 和 webui 共用
- **bot 和 webui 共用同一入口**，避免两边逻辑偏差
- 所有 prompt 默认值集中在 `src/prompts.ts` 的 `Prompts` 类中，`input.prompts` 可在启动时覆盖任意成员（`applyPromptsOverrides`）；`prompts` 单例由回复流程各模块共用（`reply-prompt.ts` / `reply-agent.ts` / `reply-sender.ts` / `memory-context.ts` / `deep-research.ts` / `reply-tool.ts` / `desc-queue.ts`）
- `GroupReplyManager` 维护每群 `lastTriggerId`，回复完成后更新为本轮实际读入 prompt 的最大消息 id（`processedUpToId`），而非 bot 回复行 id——否则回复执行期间到达的新消息（id 小于 bot 回复行）会被永久跳过；新 session 创建时 `lastTriggerId` 由 `ReplyAgent.create` 推进到该群最新消息 id，历史上下文由 webui 按日期范围手动导入
- **乱序时序提示**：回复生成期间送达的消息 id 小于 bot 回复行 id，但在 harness 中排在回复之后。`ReplyAgent` 跟踪 `lastBotReplyId`（`appendBotMessage` 时更新，创建时从数据库恢复），prompt 构建时若读入 `id <= lastBotReplyId` 的消息，则将 `prompts.outOfOrderHint` 提示拼在 user 消息最后（在 graphiti 合并 episode 快照之后追加，不进记忆），提醒模型按消息 id 推断真实时序
- `GroupReplyManager.create(...)` 异步初始化 `ReplyAgent`，并通过 `getAgent()` 暴露给外部
- webui 的 Prompt 预览页面（`/group/{id}/preview`）通过 API 调用 `agent.buildPreviewPrompt()`，结果与 bot 实际发送给模型的 user messages 一致
- webui 的 compact API（`/api/compact`）调用 `agent.triggerCompact()` 强制 compact
- webui 的导入 API（`/api/group/{id}/import`）调用 `agent.importMessagesByDateRange(startTime, endTime)`，按本地时区当天起止时间戳查询消息导入 harness，忽略所有 compact 消息

### Agent Loop 与记忆机制

- **回复 Agent** (`reply-agent.ts`) 使用 `@earendil-works/pi-agent-core` 的 `AgentHarness` 类
- `AgentHarness` 自动处理 tool loop：LLM 调用工具 → 执行 → 结果回传 → 继续对话，支持多轮工具调用
- **Graphiti 工具** (`graphiti-tool.ts`) 注册为 `AgentTool`，仅包含 `search_memory`（agent 不主动添加记忆；episode 由 `graphiti-episode.ts` 的 `addMessageEpisode` 和 `addMergedMessagesEpisode` 自动创建：触发回复时（合并消息，内容与模型看到的 user message 一致）、bot 回复发送后、深度研究结果产生时）
- **记忆语言**：graphiti 服务端（`graphiti/server.py`）覆写 graphiti-core 官方语言扩展点 `get_extraction_language_instruction`（docstring 声明可 override；库默认文案 "Otherwise, output English." 是英文记忆的根因），统一注入简体中文指令，经 `generate_response` 覆盖全部生成型调用（事实/摘要/去重）；专有名词/昵称/引用原文保留不翻译
- **JSON 输出修复**：graphiti 服务端在传输层补丁 `AsyncOpenAI.chat.completions.create`，用 jsonrepair（`graphiti/json_repair.js`，经 pythonmonkey 加载并用 `require` 解析 bot 的 `node_modules/jsonrepair`）修复模型返回的非法 JSON：markdown 围栏、被 max_tokens 截断、缺失括号等；jsonrepair 不接受根值之后的额外内容，此时按其 `JSONRepairError.position` 截断后重试。修复结果与原内容相同或修复失败时保持原样，交给 graphiti-core 自身的重试与报错路径
- 记忆工具在 tool loop 中可被多次调用（先搜索 → 看到结果 → 决定再搜索别的）
- **自动记忆搜索**：配置 `ai.assignments.memory_keyword` 后，`memory-context.ts` 每次触发回复时自动调用指定模型从全部最新消息生成搜索关键词（自然语言查询 + 实体名称），查询走 `search`；`ai.memoryKeyword.enable_entity_search` 为 true 时实体走 `search_nodes`，结果按「事实」与「相关实体」两节各取前 10 条注入，默认关闭（仅注入事实列表），注入位置为最后一条 user message 末尾
- **回复工具** (`reply`) 设置 `terminate: true`，参数 `messages` 为消息数组（每条含 `text`，可选 `ref` 指向被引用消息的数据库 id），被调用后 Agent loop 立即退出；`messages` 传空数组表示模型主动选择不回复（合法结果，不视为失败）
- **回合链编排**：`GroupReplyManager.executeTask` 按 `消息轮（runMessageTurn）→ 深度研究轮（runResearchTurn，可链式）` 组织任务执行；回合的 reply 工具结果中 `requires_deep_research=true` 时进入研究轮，研究轮中可再次请求研究，直到达到 `input.max_deep_research_rounds`（默认 3）后忽略；每回合有独立的工具调用轮数配额
- **工具调用轮数限制**：通过 `input.max_tool_call_rounds`（默认 5）限制每轮 prompt 的非 `reply` 工具调用轮数。超过上限后通过 `tool_call` hook 阻止后续工具执行，并发送 reminder 提示词引导模型回复
- 如果 Agent loop 结束时未调用回复工具，自动发送 reminder 提示词重新引导（最多 2 次）；API 错误（`stopReason='error'/'aborted'`）同样进入 reminder 重试，且使用专用的错误 reminder 提示词（`prompts.replyErrorReminder`）
- **API 错误处理**：当模型返回 `stopReason='error'` 时，不会把错误内容当作正常回复；所有尝试（初始 prompt + 最多 2 次 reminder）均失败后进入失败回退
- **失败回退**：消息轮失败时 @触发返回 `@响应失败`（`prompts.atFailureFallback`），闲时/定时触发则静默失败；深度研究轮失败时，引用上一轮回复消息并回复兜底文案（所有触发类型），文案按失败原因区分：深度研究本身失败回复 `深度研究失败`（`prompts.deepResearchFailedFallback`），研究成功但回复生成失败回复 `回复生成失败`（`prompts.deepResearchFinalFailedFallback`）
- **空任务跳过**：排队任务执行时若 `lastTriggerId` 之后无新消息（触发消息已被前序任务读入其 prompt），`runMessageTurn` 返回 `noop: true`，静默跳过不发送失败回退
- 深度研究按 `ai.assignments.deep_research` 的类型执行：字符串为 `ai.models` 中的模型 key，用 `completeSimple()` 通过 LLM 兼容接口直接发起单次研究；对象为 pi CLI rpc 模式子进程（`src/util/pi-rpc-client.ts`），以严格 JSONL 协议写入 prompt，等待 `agent_settled` 后通过 `get_last_assistant_text` 取回最后一条 assistant 消息文本，研究报告由 pi agent 自己的模型与工具（网络检索等）产出，子进程的模型、凭据与扩展由 `PI_CODING_AGENT_DIR` 指向的配置目录决定；两种方式都把深度研究指令（`prompts.deepResearchSystem`）拼入 prompt 文本；失败（API 错误、子进程退出、超时、assistant 报错、空结果）时记录错误并用 fallback 文本继续研究轮
- 深度研究会向群内写入系统消息（`开始深度研究：{keyword}` / `深度研究结束：{keyword}`）到数据库，这些系统消息会随 `lastTriggerId` 之后的新消息一起被打包进 user message，供模型在后续回复中参考
- 深度研究轮（及其链式后续回合）的回复消息会添加 `reply` segment 指向上一轮的最后一条回复消息

### 定时任务触发机制

- `input.scheduled_tasks` 按群号配置任务数组，群号必须同时存在于 `group_whitelist`
- 每个任务使用 Croner 注册 crontab-like 表达式，支持 5/6/7 字段、nickname、timezone，并启用 `protect` 防止同一任务重入
- 任务触发时由 `GroupReplyManager.triggerScheduledReply` 插入一条 `special_type='system'` 的系统消息，内容为任务自定义 `prompt`，再以 `type='scheduled'` 入单群 FIFO 队列
- 若任务配置 `deep_research_topic`，队列执行时会通过 `ReplyTask.preResearchTopic` 传递给 `ReplyAgent.runMessageTurn`，将预研究开始/结束写入系统消息；随后继续走普通消息轮回复和可能的后续深度研究轮流程
- 定时任务不会自动添加 reply segment，失败回退行为与闲时触发一致，静默失败

### Compact 机制

- `ReplyAgent.triggerCompact()` 委托给 `AgentHarness.compact()`，由 harness 内部管理会话上下文压缩
- Compact 摘要以 `special_type='compact'` 的消息插入数据库，渲染为 `**前情提要**: (内容)`
- 手动 compact 可通过 webui 的 `/api/compact` 触发
- `kv_store` 表持久化 `lastTriggerId`（数据库自增 `id`）和 harness session 元数据，重启后不丢失上下文边界

### AI 配置架构

配置统一放在根目录`config.ts`，`src/config.ts`为类型声明。每次添加新配置项，都需要更新config.example.ts。

- `input.vision_concurrency`：图片描述并发 Worker 数，默认 5
- `input.vision_thinking_level`：图片描述 Agent 的思考级别（`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`），默认 `off`；端点不接受关闭思考（如 `openai-responses` 只接受 `minimal` 及以上）时设为 `minimal` 等级别
- `input.vision_max_size_bytes` / `input.vision_max_frames` / `input.vision_initial_quality` / `input.vision_max_long_edge` / `input.vision_max_total_pixels`：发送给 vision 模型的图片预处理参数，分别为压缩后的字节上限（默认 6MB）、动图最多抽取的帧数（默认 5）、动图抽帧与尺寸缩放时使用的 jpeg 质量（默认 80）、长边像素上限与总像素上限（超过则按比例缩小，0（默认）表示不限制）
- `input.silence_recent_window` / `input.silence_recent_bot_threshold` / `input.silence_recent_bot_multiplier`：闲时触发前检查最近 `silence_recent_window` 条消息，其中 bot 消息数达到 `silence_recent_bot_threshold` 时闲时等待时间按 `silence_recent_bot_multiplier` 倍延长（默认 1，不放大）；每次有新消息都会重新计算等待时间；window 或 threshold 为 0（默认）表示禁用该检查
- `input.max_tool_call_rounds`：每个回合中允许的非 `reply` 工具调用轮数上限，默认 5
- `input.max_deep_research_rounds`：每个任务内允许的最大深度研究次数（研究轮可链式再次请求研究，达到上限后忽略后续的 `requires_deep_research`），默认 3
- `input.group_custom_prompts`：按群号配置的专属提示词（`Record<number, string>`），注入在 system prompt 人设之后，有 `----- 本群专属提示 -----` 分割线
- `input.prompts`：按成员覆盖 `src/prompts.ts` 中 `Prompts` 类的默认 prompt（`Partial<Prompts>`），如 `rules`（群聊回复规则）、`deepResearchSystem`（深度研究提示词）；未覆盖的成员使用 `prompts.ts` 中的通用默认值。启动时由 `src/index.ts` 调用 `applyPromptsOverrides` 应用
- `input.scheduled_tasks`：按群号配置的定时任务（`Record<number, ScheduledGroupTask[]>`），字段包含 `name`、`cron`、`timezone`、`prompt`、`deep_research_topic`、`enabled`
- `ai.assignments.agent_harness`：驱动 `AgentHarness` 的模型 assignment（`string | ScheduledModelAssignment`）
- `ai.assignments.deep_research`：深度研究执行方式（`string | PiRpcConfig`）。字符串为 `ai.models` 中的模型 key，通过 LLM 兼容接口直接发起单次研究；对象为 pi rpc 配置，字段：`command`（pi CLI 命令，默认 `pi`）、`args`（追加在 `--mode rpc` 之后的参数，默认 `['--no-session']`）、`env`（子进程环境变量，覆盖 `process.env` 同名变量）、`cwd`（子进程工作目录，默认当前工作目录）、`timeout_ms`（单次研究超时时间，默认 1800000）
- `ai.assignments.memory_keyword`：记忆关键词生成模型 assignment，启用后每次回复前自动搜索相关记忆注入上下文（`string | ScheduledModelAssignment`）
- `ai.memoryKeyword`：记忆关键词生成模型的额外配置
  - `disable_thinking`：仅对 `openai-completions` 协议生效，所用模型/端点默认开启深度思考时设为 `true`，调用时注入 `thinking=disabled`，默认 `false`
  - `reasoning_effort`：仅对 `openai-responses` 协议生效，设值后注入 `reasoning.effort`，取值 `none` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`；不设置则不注入，沿用端点默认
  - `response_format`：调用时是否请求 JSON 输出格式，默认 `true`；`openai-responses` 协议用 `text: {format: {type: 'json_object'}}`，其余协议用 `response_format: {type: 'json_object'}`。端点不支持时设为 `false`，返回内容由 jsonrepair 修复后再解析
  - `enable_entity_search`：是否启用实体搜索（`search_nodes`），默认 `false`；启用后「--- 记忆自动检索 ---」按「事实」与「相关实体」两节注入
- `ai.assignments` 所有字段均支持 `ScheduledModelAssignment` 时段调度：配置 `slots`（含 `start`/`end`/`model`，支持跨日如 `18:00→09:00`）和 `default`，运行时按当前时间匹配第一个命中的 slot 模型，未命中则用 default；也可直接用字符串指定单一模型
- `ai.assignments` 中模型字段（含 `slot.model` 和 `default`）均支持配置为**元组回退链**（`string[]`，即 `ModelAssignmentKey`）：API 错误时按数组顺序依次回退到下一个模型。harness 回复中回退不消耗 reminder 额度，回退链耗尽后才进入 reminder 重试；记忆关键词、图片描述同理按链回退（`resolveAssignmentModels()` 返回按回退顺序排列的 `ModelEntry[]`）；深度研究为 `string | PiRpcConfig`，字符串形式是单个 `ai.models` key（不参与回退链），对象形式改由 pi rpc 执行
- `ai.graphiti`：可选 Graphiti 配置，启用后通过 stdio JSON-RPC 连接 Python Graphiti 服务，`search_memory` 工具会加入 harness；记忆自动创建（触发回复时合并消息、bot 回复发送后、深度研究结果产生时）
- `ai.graphiti.debug_dump_rpc`：是否 dump Graphiti JSON-RPC 报文到 `data/debug/`，默认 `false`
- `ai.graphiti.llm.disable_thinking`：所用模型/端点默认开启深度思考时设为 `true`，server 侧给 AsyncOpenAI 客户端打补丁注入 `extra_body={"thinking": {"type": "disabled"}}`，默认 `false`
- `ai.graphiti.llm.headers`：附加到 Graphiti LLM 请求的头部（`Record<string, string | null>`），值为 `null` 表示删除 SDK 默认头部（如 `X-Stainless-*`）；server 侧在构造 AsyncOpenAI 客户端时把 `null` 转换为 Python SDK 的 `omit` 哨兵后作为 `default_headers` 传入。该配置只作用于生成型 LLM，嵌入与重排由 graphiti-core 内部各自创建客户端，不受其影响

- `debug_dump_prompt`：由 `reply-debug.ts` 将每次回复的 system prompt、user prompt、模型输出，以及深度研究模型路径的 prompt/payload/对话、pi rpc 路径的 prompt/启动配置/研究结果保存到 `data/debug/`，默认 `false`

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
- `src/util/image-preprocess.ts` — 发送给 LLM 前按上限压缩与缩小、动图切帧，帧的mimeType按实际字节格式给出
- `src/util/reply-task.ts` — `ReplyTask` / `ScheduledReplyTask` 任务类型
- `src/util/reply-manager.ts` — 群回复触发管理、队列与回合链编排
- `src/util/reply-sender.ts` — 回复发送、落库、引用解析与 Graphiti episode 写入
- `src/util/reply-prompt.ts` — 回复 system prompt 与 user message 构建
- `src/util/reply-debug.ts` — 回复流程的 `data/debug/` 调试导出
- `src/util/reply-agent.ts` — 回复Agent（基于 `AgentHarness` 的自动 tool loop，支持 Graphiti 记忆工具多轮调用）
- `src/util/memory-context.ts` — 记忆关键词生成、Graphiti 检索与已注入记忆去重
- `src/util/deep-research.ts` — 深度研究执行（模型路径 / pi rpc 路径）与开始/结果/结束系统消息写入
- `src/util/pi-rpc-client.ts` — pi CLI rpc 模式子进程客户端（严格 JSONL 帧、prompt 提交、`agent_settled` 等待、最后一条 assistant 文本获取）
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
- `web/src/lib/messages-*.ts` / `memories-*.ts` / `harness-*.ts` — Web 页面的服务端数据加载、渲染辅助与客户端脚本
- `web/src/styles/*.css` — Web 页面样式
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
