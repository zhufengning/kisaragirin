# Kisaragirin OneBot

基于OneBot V11(Philia)的QQ机器人

## 功能

- [x] 接收、存储消息，并打包成simple-id格式
- [x] 处理消息中的图片（下载、去重、AI描述）
- [x] 回复消息（@触发 + 闲时触发，支持深度研究两轮回复）
- [x] **Auto Compact**：超过 context window 阈值后自动摘要历史消息为「前情提要」
- [x] 特殊消息类型：前情提要（compact）、系统消息（system）
- [x] Web面板：群消息浏览（支持分页，仅显示原始数据）
- [x] Web面板：Prompt 预览（忠实反映 buildUserPrompt 结果）
- [x] Web面板：图片管理（支持分页、按描述搜索、实时队列进度、描述编辑）
- [x] Web面板：mem0记忆管理（增删改查、语义搜索）
- [x] Web面板：手动触发群消息 compact
- [x] 日志写入文件（支持按级别过滤）

## 启动

```bash
cp config.example.ts config.ts

// 然后修改配置文件（必须填写 ai.assignments.reply 和 ai.assignments.deep_research）

yarn web:build && yarn start
```

## 回复机制

- 支持 `@触发` 与 `闲时触发` 两种模式
- 采用两轮回复架构：第一轮即时回复，若需要则触发深度研究并给出第二轮回复
- 深度研究会向群内写入系统消息（`开始深度研究：{keyword}` / `深度研究结束：{keyword}`），可在 Web 面板追踪
- 当模型返回 API 错误、未调用回复工具或回复为空时，会自动 reminder 重试；最终失败时 @触发返回 `@响应失败` / `@深度研究失败`，闲时触发静默失败
- 工具调用轮数超过 `max_tool_call_rounds` 后强制终止并引导回复

## Web面板功能

访问 `http://<host>:<port>`（由 `config.web` 配置）：

| 页面 | 功能 |
|------|------|
| `/` | 群列表，显示消息数和最后活动时间 |
| `/group/{id}` | 群消息浏览，50条/页，仅显示原始数据（无图片描述查询），支持手动 compact |
| `/group/{id}/preview` | Prompt 预览，调用 `ReplyAgent.buildPrompt` 忠实反映模型输入 |
| `/images` | 图片管理，24张/页，支持按描述搜索、翻页、描述编辑 |
| `/memories` | mem0记忆管理，支持语义搜索、增删改查 |

## Auto Compact 配置

在 `config.ts` 的 `input` 中配置：

```typescript
input: {
    // ... 其他配置
    auto_compact_threshold: 0.7,      // 触发 compact 的 context window 使用百分比
    auto_compact_keep_recent: 20000,  // compact 后保留的最近 token 数
    auto_compact_reserve_tokens: 8000 // 为 LLM 响应预留的 token 数
}
```

- 当历史消息的 token 数超过 `(contextWindow - reserveTokens) * threshold` 时自动触发 compact
- Token 计算优先使用上一次回复模型返回的真实 `usage` 作为锚点，对锚点之后的新消息再用启发式（chars/4）增量估算，比纯估算更准确
- 如果 LLM 返回 context overflow 错误（覆盖 Anthropic/OpenAI/Google/Groq/OpenRouter 等常见文案），会自动移除错误回复、强制 compact 并重试一次
- Compact 会将旧消息摘要为一条「前情提要」消息插入数据库
- Web 面板支持手动触发 compact

## 技术栈

- **Bot Harness**: TypeScript + OneBot V11 (ws) + better-sqlite3 + Drizzle ORM
- **LLM**: `@earendil-works/pi-agent-core` (Agent tool loop) + mem0ai
- **Web UI前后端**: Astro 6.4 SSR (Node middleware模式)
