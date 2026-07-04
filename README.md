# Kisaragirin OneBot

基于OneBot V11(Philia)的QQ机器人

## 功能

- [x] 接收、存储消息，并打包成simple-id格式
- [x] 处理消息中的图片（下载、去重、AI描述）
- [x] 回复消息（@触发 + 闲时触发，支持深度研究两轮回复）
- [x] 按群定时任务触发（crontab-like，支持触发前预研究）
- [x] **AgentHarness tool loop**：`reply` 工具结束对话，`search_memory` / `add_memory` 可在 loop 中多次调用
- [x] 手动 Compact（通过 harness.compact 触发会话压缩）
- [x] 特殊消息类型：前情提要（compact）、系统消息（system）
- [x] Web面板：群消息浏览（支持分页，仅显示原始数据）
- [x] Web面板：Prompt 预览（忠实反映 buildUserPromptArray 结果）
- [x] Web面板：图片管理（支持分页、按描述搜索、实时队列进度、描述编辑）
- [x] Web面板：mem0记忆管理（增删改查、语义搜索）
- [x] Web面板：手动触发群消息 compact
- [x] 日志写入文件（支持按级别过滤）

## 启动

```bash
cp config.example.ts config.ts

// 然后修改配置文件（必须填写 ai.assignments.agent_harness 和 ai.assignments.deep_research）

yarn web:build && yarn start
```

## 回复机制

- 支持 `@触发` 与 `闲时触发` 两种模式
- 支持按群配置定时任务触发。任务触发时会先写入一条系统消息作为最新消息，内容为任务自定义提示词；如果配置了 `deep_research_topic`，会在第一轮回复前自动执行一次深度研究并写入研究结果系统消息
- 采用两轮回复架构：第一轮即时回复，若需要则触发深度研究并给出第二轮回复
- 回复 Agent 基于 `@earendil-works/pi-agent-core` 的 `AgentHarness` 自动 tool loop；启用 mem0 时，`search_memory` / `add_memory` 会作为工具在 loop 中被模型按需多次调用
- 深度研究通过 `@earendil-works/pi-ai` 的 `completeSimple()` 调用 `ai.assignments.deep_research` 指定模型；深度研究指令会拼入 user message 以兼容 Hermes；若返回 `stopReason='error'` / `aborted` 或空结果，会记录错误并降级为 fallback 文本继续第二轮
- 深度研究会向群内写入系统消息（`开始深度研究：{keyword}` / `深度研究结束：{keyword}`），可在 Web 面板追踪
- 当模型返回 API 错误、未调用回复工具或回复为空时，会自动 reminder 重试；最终失败时 @触发返回 `@响应失败` / `@深度研究失败`，闲时触发静默失败
- 非 `reply` 工具调用轮数超过 `max_tool_call_rounds` 后会被强制阻止，并继续 reminder / 失败回退流程

## Web面板功能

访问 `http://<host>:<port>`（由 `config.web` 配置）：

| 页面 | 功能 |
|------|------|
| `/` | 群列表，显示消息数和最后活动时间 |
| `/group/{id}` | 群消息浏览，50条/页，仅显示原始数据（无图片描述查询），支持手动 compact |
| `/group/{id}/preview` | Prompt 预览，调用 `ReplyAgent.buildPreviewPrompt` 反映实际 user messages |
| `/group/{id}/harness` | AgentHarness 会话日志查看，按角色/类型筛选，只读 |
| `/images` | 图片管理，24张/页，支持按描述搜索、翻页、描述编辑 |
| `/memories` | mem0记忆管理，支持语义搜索、增删改查 |

## Compact 机制

- `ReplyAgent.triggerCompact()` 委托给 `AgentHarness.compact()`，由 harness 内部管理会话上下文压缩
- Compact 摘要以 `special_type='compact'` 的消息插入数据库，渲染为 `**前情提要**: (内容)`
- Web 面板支持手动触发 compact

## 定时任务配置

在 `config.ts` 的 `input.scheduled_tasks` 中按群号配置：

```typescript
scheduled_tasks: {
    123456789: [
        {
            name: 'daily-news',
            cron: '0 9 * * *',
            timezone: 'Asia/Shanghai',
            prompt: '请结合最近群聊，发起一个今日安全新闻简评。',
            deep_research_topic: '今日网络安全重要新闻',
        },
    ],
}
```

- `cron` 使用 Croner，支持 5/6/7 字段 cron 表达式、`@daily` 等 nickname 和时区
- `prompt` 会作为 `special_type='system'` 的消息插入该群最新消息
- `deep_research_topic` 可选；配置后会在第一轮回复前预先执行深度研究，研究开始/结束同样写入系统消息
- 只有 `group_whitelist` 中的群会注册定时任务

## 调试配置

在 `config.ts` 的 `input` 中配置：

```typescript
input: {
    // ... 其他配置
    debug_dump_prompt: true // 开启后将每次回复的 prompt 与模型输出保存到 data/debug/
}
```

- 开启后会在 `data/debug/` 目录下保存以下文件：
  - `{groupId}-{taskType}-{ts}-system.txt`：system prompt
  - `{groupId}-{taskType}-{ts}-user-{n}.txt`：第 n 条 user message（按发送给 harness 的顺序编号）
  - `{groupId}-{taskType}-{ts}-output.json`：该轮 assistant 输出消息（含 stopReason、工具调用等）
  - `{groupId}-{taskType}-{ts}-deep-research-system.txt`：深度研究 system prompt（仅存在 systemPrompt 时生成）
  - `{groupId}-{taskType}-{ts}-deep-research-user.txt`：深度研究 user prompt（包含深度研究指令和主题）
  - `{groupId}-{taskType}-{ts}-deep-research-prompt.json`：深度研究完整请求上下文
  - `{groupId}-{taskType}-{ts}-deep-research-payload.json`：深度研究发送给 provider 的最终 payload
  - `{groupId}-{taskType}-{ts}-deep-research-conversation.json`：深度研究完整对话数据（含响应或错误）
- 同一组文件使用相同时间戳前缀，便于关联 prompt 与输出

## 技术栈

- **Bot Harness**: TypeScript + OneBot V11 (ws) + better-sqlite3 + Drizzle ORM
- **LLM**: `@earendil-works/pi-agent-core` (Agent tool loop) + mem0ai
- **Scheduling**: Croner
- **Web UI前后端**: Astro 6.4 SSR (Node middleware模式)
