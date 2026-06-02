# Philia OneBot

基于OneBot V11的QQ机器人

## 功能

- [x] 接收、存储消息，并打包成simple-id格式
- [x] 处理消息中的图片（下载、去重、AI描述）
- [x] 回复消息（@触发 + 闲时触发，支持深度研究）
- [x] Web面板：群消息浏览（支持分页）
- [x] Web面板：图片管理（支持分页、按描述搜索）
- [x] Web面板：mem0记忆管理（增删改查、语义搜索）

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
| `/group/{id}` | 群消息浏览，50条/页，支持翻页 |
| `/images` | 图片管理，24张/页，支持按描述搜索和翻页 |
| `/memories` | mem0记忆管理，支持语义搜索、增删改查 |

## 技术栈

- **后端**: TypeScript + OneBot V11 (ws) + better-sqlite3 + Drizzle ORM
- **AI**: `@earendil-works/pi-agent-core` (Agent tool loop) + mem0ai
- **前端**: Astro 6.4 SSR (Node middleware模式)
