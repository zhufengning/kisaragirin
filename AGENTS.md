# Philia OneBot

基于OneBot V11的QQ机器人

已实现的功能：
- 群消息采集
- 消息与图片浏览

## 约束

- `StoredImageSegment` 只有 `sha256`，description 存 `images` 表
- `messages.segments` JSON 不内嵌 description，渲染时通过 `resolveDesc` 回填
- `describeImage()` 是假函数，LLM 调用在 `DescQueue` 中
- `lib/` 是上游 SDK，不写业务逻辑
- NapCat 扩展字段在 `lib/types/messages.ts` 定义，不用 `as any`
- 数据库变更：删 `data.db`，`npx drizzle-kit push` 重建

## 核心文件

- `src/index.ts` — 入口
- `src/message-format.ts` — 消息数据结构 + simple-id 序列化
- `src/db/schema.ts` — Drizzle 表定义
- `src/util/desc-queue.ts` — 图片描述队列
- `src/util/image-store.ts` — 图片下载存储
- `src/web/server.ts` — Web 面板
- `lib/types/messages.ts` — OneBot 消息段类型

## 相关

- [docs/消息格式.md](docs/消息格式.md)
- [config.toml](config.toml)
- [package.json](package.json)
- [package.json](package.json)
