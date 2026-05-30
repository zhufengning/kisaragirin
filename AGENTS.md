# Philia OneBot

基于OneBot V11的QQ机器人

已实现的功能：
- 群消息采集
- 消息与图片浏览

## 包管理

yarn

## 约束

- `StoredImageSegment` 只有 `sha256`，description 存 `images` 表
- `messages.segments` JSON 不内嵌 description，渲染时通过 `resolveDesc` 回填
- `src/prompts.ts` 统一管理所有 LLM prompt，禁止在业务代码中硬编码 prompt
- `lib/` 是上游 SDK，不写业务逻辑
- NapCat 扩展字段在 `lib/types/messages.ts` 定义，不用 `as any`
- 数据库变更：删 `data.db`，`npx drizzle-kit push` 重建

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
    desc-queue.ts    -- 图片描述后台队列（单线程轮询）
    image-store.ts   -- 图片下载 + 本地存储
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
      group/[id].astro   -- 群消息浏览
      images.astro   -- 图片管理
      api/images/... -- 图片文件服务 + 描述管理 API
```

### 数据流

```
OneBot WS  ←→  src/index.ts  ←→  src/db (SQLite)
                              ←→  src/util/desc-queue.ts
                              ←→  web/dist/server/entry.mjs (Astro SSR)
```

### 关键组件关系

- **Bot 主进程** 持有唯一的 `better-sqlite3` 连接和 `DescQueue` 实例
- 启动时通过 `globalThis.__db__` / `globalThis.__queue__` 暴露给 Astro
- Astro `middleware.ts` 提供 Basic Auth；页面直接查 DB 渲染 HTML
- `src/web/server.ts` 仅做 Node HTTP server 适配，把请求交给 Astro `handler`

### AI 配置架构

配置统一放在根目录 `config.ts`，`src/config.ts` 仅做 re-export。

```
config.ts
  onebot     -- OneBot 连接参数
  input      -- 群白名单等输入过滤
  web        -- Web 面板监听地址与 Basic Auth
  ai
    models
      [name]       -- 单个模型配置（复用 `Model<Api>` 类型）
        model      -- 模型元数据（id、api、provider、baseUrl、cost 等）
        apiKey     -- 该模型的 API key
    assignments
      vision       -- 用途对应已配置的模型名称，如 "qwen"
```

通过 `satisfies Model<Api>` 让 TypeScript 在编译期校验模型字段，近似模型可复用基础对象后展开。

## 代码规范

### 命名约定
- 函数/变量：camelCase
- 类型/接口：PascalCase
- 常量：UPPER_SNAKE_CASE（局部）或 camelCase（模块级）

### 目录结构
- `lib/` — 上游 OneBot SDK，**禁止写业务逻辑**
- `src/` — 核心业务代码
- `web/` — Astro 前端项目，**与 `src/` 共享 DB schema 类型**

### 技术栈版本要求
- TypeScript ^5.7
- Astro ^6.4
- `@astrojs/node` ^10（middleware 模式）
- Drizzle ORM ^0.45
- better-sqlite3 ^12.10

## 核心文件

- `src/index.ts` — 入口
- `src/message-format.ts` — 消息数据结构 + simple-id 序列化
- `src/db/schema.ts` — Drizzle 表定义
- `src/util/desc-queue.ts` — 图片描述队列（使用 `@earendil-works/pi-agent-core` 的 `Agent` 调用 vision 模型）
- `src/util/image-store.ts` — 图片下载存储
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