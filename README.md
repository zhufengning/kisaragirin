# Kisaragirin OneBot

基于 OneBot V11 的 QQ 机器人。

## 功能

- 接收并存储群消息
- 下载、去重并 AI 描述消息中的图片
- 自动回复：@触发、闲时触发
- 按群定时任务触发
- 支持深度研究两轮回复
- 手动 Compact
- Web 面板：群消息浏览、Prompt 预览、图片管理、mem0 记忆管理、手动 compact
- 日志写入文件

## 启动

```bash
cp config.example.ts config.ts

# 修改 config.ts，填写 ai.assignments.agent_harness 和 ai.assignments.deep_research

yarn web:build && yarn start
```

## 回复机制

- 支持 `@触发` 与 `闲时触发` 两种模式
- 支持按群配置定时任务触发
- 采用两轮回复架构：第一轮即时回复，若需要则触发深度研究并给出第二轮回复
- 启用 mem0 时，可在回复中搜索或添加记忆

## Web 面板

访问 `http://<host>:<port>`（由 `config.web` 配置）：

| 页面 | 功能 |
|------|------|
| `/` | 群列表 |
| `/group/{id}` | 群消息 CRUD 浏览：分页表格、按发送者/内容搜索、单条/批量删除、详情弹窗、手动 compact |
| `/group/{id}/preview` | Prompt 预览 |
| `/group/{id}/harness` | 会话日志查看 |
| `/images` | 图片管理 |
| `/memories` | mem0 记忆管理 |

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

- `cron` 支持 5/6/7 字段 cron 表达式、`@daily` 等 nickname 和时区
- `deep_research_topic` 可选；配置后会在第一轮回复前预先执行深度研究
- 只有 `group_whitelist` 中的群会注册定时任务

## 调试配置

在 `config.ts` 的 `input` 中配置：

```typescript
input: {
    // ... 其他配置
    debug_dump_prompt: true // 开启后将每次回复的 prompt 与模型输出保存到 data/debug/
}
```

## 技术栈

- **Bot**: TypeScript + OneBot V11 (ws) + better-sqlite3 + Drizzle ORM
- **LLM**: `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai` + mem0ai
- **Scheduling**: Croner
- **Web UI**: Astro 6.4 SSR (Node middleware)
