# Philia OneBot

基于OneBot V11的QQ机器人

已实现的功能：
- 群消息采集
- 消息与图片浏览
- @触发回复（支持merge_window合并）
- 闲时触发回复（沉默定时器 + 概率抽卡）
- 两轮回复（支持深度研究agent）

## 包管理

yarn

## 约束

- `src/prompts.ts` 统一管理所有 LLM prompt，禁止在业务代码中硬编码 prompt
- 打日志必须用`lib/utl/logger.ts`
- `lib/` 是上游 SDK，不写业务逻辑
- 添加或修改功能、调整架构后需要更新README.md和AGENTS.md。
- 修复bug时，如果没有影响行为和架构，则不需要更新README.md和AGENTS.md。
- pi ai和pi agent的文档和源码保存在~/repos/pi
- 其余库可通过context7查询文档
- 对于任何库，先阅读相关文档，再写代码
- 优先阅读文档，无法找到答案的，再阅读源代码
- 不到万不得已，禁止从node_modules中读取这些经过编译、压缩的代码。在此之前求助于文档，而不是你的记忆和想象
- 未经允许严禁私自运行服务和测试，禁止运行任何package.json中未定义的编译、打包、测试、类型检查指令

## 架构设计

### 模块划分

```
src/
  index.ts           -- 入口：初始化 bot、db、queue、web panel
  config.ts          -- 根目录 TS 配置，使用 `@earendil-works/pi-ai` 的 `Model<Api>` 类型定义模型
  web/server.ts       -- Node.js HTTP server，加载 Astro handler
  message-format.ts  -- OneBot 消息 ↔ 存储格式转换 + 渲染
  db/
    schema.ts        -- Drizzle SQLite 表定义
    index.ts         -- Database 连接工厂
  util/
    desc-queue.ts       -- 图片描述后台队列（多 Worker 并发，默认可配置 5 个）
    image-store.ts      -- 图片下载 + 本地存储
    image-preprocess.ts -- 图片转 jpg、压缩到 6MB 以下、动图切帧
    agent-retry.ts      -- Agent 调用通用指数退避重试封装
    reply-manager.ts    -- 群回复触发管理（@触发、闲时触发、单群FIFO队列）
    reply-agent.ts      -- 回复Agent（两轮回复 + 深度研究调用，基于 pi-agent-core Agent 的自动 tool loop）
    mem0-tool.ts        -- mem0 记忆工具（search_memory / add_memory），注册为 AgentTool 供 reply-agent 调用
  prompts.ts         -- 所有 LLM prompt 的统一入口
  web/
    server.ts        -- Node.js HTTP server，加载 Astro handler

web/                  -- Astro 6.4 独立项目（SSR，Node middleware 模式）
  src/
    middleware.ts    -- Basic Auth
    lib/
      db.ts          -- 复用 globalThis.__db__（fallback 自建连接）
      queue.ts       -- 复用 globalThis.__queue__
    layouts/
      Layout.astro   -- 暗色主题全局布局
    pages/
      index.astro    -- 群列表
      group/[id].astro       -- 群消息浏览（分页，仅原始数据）
      group/[id]/preview.astro -- Prompt 预览（调用 ReplyAgent.buildPrompt）
      images.astro           -- 图片管理（分页 + 描述搜索）
      memories.astro         -- mem0 记忆管理（增删改查 + 语义搜索）
      api/
        images/...           -- 图片文件服务 + 描述管理 API
        memories/...         -- mem0 REST API 封装
        preview-prompt.ts    -- Prompt 预览 API（调用 ReplyAgent.buildPrompt）
```

### 关键组件关系

- **Bot 主进程** 持有唯一的 `better-sqlite3` 连接和 `DescQueue` 实例
- 启动时通过 `globalThis.__db__` / `globalThis.__queue__` 暴露给 Astro
- `replyManagers`（`Map<number, GroupReplyManager>`）通过 `globalThis.__replyManagers__` 暴露给 Astro，使 webui 能按群号获取 `ReplyAgent`
- mem0 配置通过 `globalThis.__mem0_config__` 暴露给 Astro
- Astro `middleware.ts` 提供 Basic Auth；页面直接查 DB 渲染 HTML
- `src/web/server.ts` 仅做 Node HTTP server 适配，把请求交给 Astro `handler`

### Prompt 构建封装

- `ReplyAgent.buildPrompt(groupId, lastTriggerId, task)` 封装了历史消息获取 + `buildUserPrompt`
- **bot 和 webui 共用同一入口**，避免两边逻辑偏差
- `generateReply` 内部调用 `buildPrompt`，不再重复写查询逻辑
- `GroupReplyManager` 在构造时即初始化 `ReplyAgent`，并通过 `getAgent()` 暴露给外部
- webui 的 Prompt 预览页面（`/group/{id}/preview`）通过 API 调用 `agent.buildPrompt()`，结果与 bot 实际发送给模型的 prompt 完全一致

### Agent Loop 与记忆机制

- **回复 Agent** (`reply-agent.ts`) 使用 `@earendil-works/pi-agent-core` 的 `Agent` 类
- Agent 自动处理 tool loop：LLM 调用工具 → 执行 → 结果回传 → 继续对话，支持多轮工具调用
- **mem0 工具** (`mem0-tool.ts`) 注册为 `AgentTool`，包含 `search_memory` 和 `add_memory`
- 记忆工具在 tool loop 中可被多次调用（先搜索 → 看到结果 → 决定再搜索别的）
- **回复工具** (`reply_first_turn` / `reply_second_turn`) 设置 `terminate: true`，被调用后 Agent loop 立即退出
- **工具调用轮数限制**：通过 `input.max_tool_call_rounds`（默认 5）限制每轮 prompt 的工具调用轮数。超过上限后通过 `afterToolCall` hook 强制 terminate，然后发送 reminder 提示词引导模型回复
- 如果 Agent loop 结束时未调用回复工具，自动发送 reminder 提示词重新引导（最多 2 次）
- **失败回退**：所有尝试（初始 prompt + 最多 2 次 reminder）均失败后，@触发返回 `@响应失败`（第一轮）或 `@深度研究失败`（第二轮），闲时触发则静默失败
- 深度研究使用 `openai` SDK 的非流式 `chat.completions.create` 调用 Hermes，不经过 Agent loop
- 深度研究后的第二轮回复消息会添加 `reply` segment 指向第一轮的即时回复消息

### AI 配置架构

配置统一放在根目录`config.ts`，`src/config.ts`为类型声明。每次添加新配置项，都需要更新config.example.ts。

- `input.vision_concurrency`：图片描述并发 Worker 数，默认 5

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
- `src/message-format.ts` — 消息数据结构 + simple-id 序列化
- `src/db/schema.ts` — Drizzle 表定义
- `src/util/desc-queue.ts` — 图片描述队列（使用 `@earendil-works/pi-agent-core` 的 `Agent` 调用 vision 模型）
- `src/util/image-store.ts` — 图片下载存储
- `src/util/image-preprocess.ts` — 发送给 LLM 前统一转 jpg、压缩、动图切帧
- `src/util/reply-manager.ts` — 群回复触发管理与队列
- `src/util/reply-agent.ts` — 回复Agent（基于 `Agent` 类的自动 tool loop，支持 mem0 记忆工具多轮调用）
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
