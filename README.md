# Philia OneBot

基于OneBot V11的QQ机器人

## 功能

- [x] 接收、存储消息，并打包成simple-id格式
- [x] 处理消息中的图片（下载、去重、AI描述）
- [x] 回复消息（@触发 + 闲时触发，支持深度研究两轮回复）
- [x] **Auto Compact**：超过 context window 阈值后自动摘要历史消息为「前情提要」
- [x] 特殊消息类型：前情提要（compact）、系统消息（system）
- [x] Web面板：群消息浏览（支持分页，仅显示原始数据）
- [x] Web面板：Prompt 预览（忠实反映 buildUserPrompt 结果）
- [x] Web面板：图片管理（支持分页、按描述搜索、实时队列进度）
- [x] Web面板：mem0记忆管理（增删改查、语义搜索）
- [x] Web面板：手动触发群消息 compact
- [x] 日志写入文件（支持按级别过滤）

## 启动

```bash
cp config.example.ts config.ts

// 然后修改配置文件（必须填写 ai.assignments.reply 和 ai.assignments.deep_research）

yarn web:build && yarn start
```

## Web面板功能

访问 `http://<host>:<port>`（由 `config.web` 配置）：

| 页面 | 功能 |
|------|------|
| `/` | 群列表，显示消息数和最后活动时间 |
| `/group/{id}` | 群消息浏览，50条/页，仅显示原始数据（无图片描述查询），支持手动 compact |
| `/group/{id}/preview` | Prompt 预览，调用 `ReplyAgent.buildPrompt` 忠实反映模型输入 |
| `/images` | 图片管理，24张/页，支持按描述搜索和翻页 |
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

- 当历史消息的估算 token 数超过 `(contextWindow - reserveTokens) * threshold` 时自动触发 compact
- Compact 会将旧消息摘要为一条「前情提要」消息插入数据库
- Web 面板支持手动触发 compact

## 技术栈

- **后端**: TypeScript + OneBot V11 (ws) + better-sqlite3 + Drizzle ORM
- **AI**: `@earendil-works/pi-agent-core` (Agent tool loop) + mem0ai
- **前端**: Astro 6.4 SSR (Node middleware模式)
