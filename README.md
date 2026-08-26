# Kisaragirin OneBot

基于 OneBot V11 的 QQ 机器人。

## 功能

- 接收并存储群消息
- 下载、去重并 AI 描述消息中的图片
- 自动回复：@触发、闲时触发
- 按群定时任务触发
- 支持深度研究两轮回复
- 手动 Compact
- 新群 session 默认不自动导入历史消息，可在 Web 面板按日期范围手动导入（忽略压缩消息）
- 回复前自动检索 Graphiti 相关记忆注入上下文
- Web 面板：群消息浏览、Prompt 预览、图片管理、Graphiti 记忆管理、手动 compact、历史消息导入
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
- 新群的会话（harness session）创建时不再自动导入数据库历史消息，`lastTriggerId` 直接推进到该群最新消息；如需历史上下文，可在 Web 面板的群消息页按日期范围手动导入（导入会忽略压缩消息）
- 启用 Graphiti 时，可在回复中通过 `search_memory` 工具搜索记忆；记忆自动创建（群消息接收时、bot 回复发送后、深度研究结果产生时）
- 配置 `ai.assignments.memory_keyword` 后，每次回复前自动从最新消息提取关键词检索 Graphiti，将相关记忆注入上下文

## Web 面板

访问 `http://<host>:<port>`（由 `config.web` 配置）：

| 页面 | 功能 |
|------|------|
| `/` | 群列表 |
| `/group/{id}` | 群消息 CRUD 浏览：分页表格、按发送者/内容搜索、单条/批量删除、详情弹窗、手动 compact、按日期范围导入历史消息 |
| `/group/{id}/preview` | Prompt 预览 |
| `/group/{id}/harness` | 会话日志查看：新在前排序、前端分页、角色筛选、错误/中止高亮、条目 JSON 原文切换 |
| `/images` | 图片管理 |
| `/memories` | Graphiti 记忆管理 |

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

## Prompt 配置

所有 LLM prompt 的默认值集中在 `src/prompts.ts` 的 `Prompts` 类中（群聊回复规则、深度研究提示词、回复工具描述、记忆关键词提取 prompt 等）。可在 `config.ts` 的 `input.prompts` 字段中覆盖任意成员：

```typescript
input: {
    // ... 其他配置
    prompts: {
        rules: `1. ...\n2. ...`,
        deepResearchSystem: `你是一个研究助手。...`,
    },
}
```

- 字符串字段直接给值即可覆盖；方法（如 `replyIdentity`）需提供同签名函数，若函数内部引用了其他成员请使用普通函数以保证 `this` 绑定
- 未覆盖的成员使用 `src/prompts.ts` 中的默认值

## 技术栈

- **Bot**: TypeScript + OneBot V11 (ws) + better-sqlite3 + Drizzle ORM
- **LLM**: `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai` + Graphiti
- **Scheduling**: Croner
- **Web UI**: Astro 6.4 SSR (Node middleware)
