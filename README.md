# Kisaragirin OneBot

基于 OneBot V11 的 QQ 机器人。

## 功能

- 接收并存储群消息
- 下载、去重并 AI 描述消息中的图片
- 自动回复：@触发、闲时触发
- 按群定时任务触发
- 支持深度研究多轮回复（研究轮可链式再次请求研究，轮数上限可配置）
- 手动 Compact
- 新群 session 默认不自动导入历史消息，可在 Web 面板按日期范围手动导入（忽略压缩消息）
- 回复前自动检索 Graphiti 相关记忆注入上下文
- Web 面板：群消息浏览、Prompt 预览、图片管理、Graphiti 记忆管理、手动 compact、历史消息导入
- 日志写入文件

## 启动

```bash
cp config.example.ts config.ts

# 修改 config.ts，填写 ai.models / ai.assignments 与 web 相关配置

pnpm web:build && pnpm start
```

## 回复机制

- 支持 `@触发` 与 `闲时触发` 两种模式
- 闲时触发可配置 `input.silence_recent_window`、`input.silence_recent_bot_threshold` 与 `input.silence_recent_bot_multiplier`：最近 `silence_recent_window` 条消息中 bot 消息数达到 `silence_recent_bot_threshold` 时，闲时等待时间按 `silence_recent_bot_multiplier` 倍延长；每次有新消息都会重新计算等待时间；window 或 threshold 为 0（默认）表示关闭该检查
- 支持按群配置定时任务触发
- 采用回合链架构：消息轮即时回复，若模型要求则执行深度研究（按 `ai.assignments.deep_research` 的配置走模型或 pi rpc）并追加研究轮回复；研究轮中模型可再次请求深度研究（链式，上限由 `input.max_deep_research_rounds` 控制，默认 3）；模型也可返回空消息数组主动选择不回复
- 新群的会话（harness session）创建时不再自动导入数据库历史消息，`lastTriggerId` 直接推进到该群最新消息；如需历史上下文，可在 Web 面板的群消息页按日期范围手动导入（导入会忽略压缩消息）
- 启用 Graphiti 时，可在回复中通过 `search_memory` 工具搜索记忆；记忆自动创建（触发回复时合并消息，内容与模型看到的 user message 一致；bot 回复发送后、深度研究结果产生时）；通过覆写 graphiti-core 官方语言扩展点强制事实与摘要以简体中文生成（专有名词/昵称/引用原文保留）；服务端在传输层用 jsonrepair 修复模型返回的非法 JSON（markdown 围栏、被截断、根值之后的尾随内容）
- 可通过 `ai.graphiti.llm.headers` 为 Graphiti 的 LLM 请求附加自定义头部；值为 null 表示删除 SDK 默认头部（如 `X-Stainless-*`）。该配置只作用于生成型 LLM，嵌入与重排请求由 graphiti-core 内部各自创建客户端，不受其影响
- 配置 `ai.assignments.memory_keyword` 后，每次回复前自动从最新消息生成搜索关键词（自然语言查询 + 实体名称）检索 Graphiti，将相关记忆按「事实」与「相关实体」两节注入上下文；实体搜索由 `ai.memoryKeyword.enable_entity_search` 控制（默认关闭，关闭时仅注入事实列表）
- 可通过 `ai.memoryKeyword.disable_thinking` 关闭记忆关键词生成模型的深度思考（`openai-completions` 协议注入 `thinking=disabled`）；`openai-responses` 协议用 `ai.memoryKeyword.reasoning_effort` 指定 `reasoning.effort`，不设置则不注入
- 记忆关键词生成的请求协议按所配模型 `model.api` 区分：`openai-responses` 走 `/responses`（JSON 输出用 `text: {format: {type: 'json_object'}}`），其余走 OpenAI 兼容的 chat completions（JSON 输出用 `response_format: {type: 'json_object'}`）；端点不支持时可将 `ai.memoryKeyword.response_format` 设为 false，此时返回内容由 jsonrepair 修复后再解析

## 模型 Assignment 配置

`config.ts` 的 `ai.assignments` 中各模型字段（`agent_harness` / `vision` / `memory_keyword`）支持三种写法：

```typescript
assignments: {
    // 1. 简单字符串：直接指定 ai.models 中的 key
    agent_harness: 'minimax-m3',

    // 2. 元组：API 错误时按数组顺序依次回退到下一个模型
    agent_harness: ['minimax-m3', 'hermes'],

    // 3. 时段调度：按当前时间匹配 slot（支持跨日），slot.model 和 default 也支持元组回退
    agent_harness: {
        slots: [
            {start: '12:00', end: '14:00', model: ['minimax-m3', 'hermes']},
            {start: '18:00', end: '09:00', model: 'minimax-m3'},  // 跨日：18:00 ~ 次日 09:00
        ],
        default: ['hermes', 'minimax-m3'],
    },
}
```

- 回退触发条件：API 错误（`stopReason='error'/'aborted'`、网络错误、限流等）。模型正常返回但内容不合规（未调用 reply 工具等）不触发模型回退，仍走原有 reminder 重试
- harness 回复中模型回退不消耗 reminder 额度；回退链全部失败后才进入原有 reminder 重试（最多 2 次）
- 每次触发回复时会重新解析 assignment（时段调度随时间生效）；回退只影响当次调用，下次触发仍从链首模型开始

## 深度研究配置

`ai.assignments.deep_research` 有两种写法：

```typescript
assignments: {
    // 1. 字符串：ai.models 中的模型 key，通过 LLM 兼容接口直接发起单次研究
    deep_research: 'hermes',

    // 2. 对象：pi CLI 的 rpc 模式子进程，pi 使用自己的模型配置与工具（网络检索等）
    deep_research: {
        command: 'pi',                                                      // pi CLI 命令，默认 pi
        args: ['--no-session'],                                             // 追加在 `--mode rpc` 之后的参数，默认 ['--no-session']
        env: {PI_CODING_AGENT_DIR: join(process.cwd(), '.pi_dir/agent')},   // 子进程环境变量，覆盖 process.env 的同名变量
        cwd: join(process.cwd(), '.pi_dir/workspace'),                      // 子进程工作目录，默认当前工作目录
        timeout_ms: 1800000,                                                // 单次研究从提交到完成的超时时间，默认 1800000
    },
}
```

- 字符串形式使用 bot 自己的模型与 apiKey（`ai.models`），与 `agent_harness` 等 assignment 一样是单个模型 key
- 对象形式下 pi 使用的模型、凭据与扩展（网络检索等）由 `PI_CODING_AGENT_DIR` 指向的配置目录决定（`models.json`、`auth.json`、`settings.json`）
- 对象形式的请求以严格 JSONL 协议写入子进程 stdin，等待 `agent_settled` 事件后通过 `get_last_assistant_text` 取回最后一条 assistant 消息文本
- 对象形式子进程无人值守运行：扩展对话框（select / confirm / input / editor）一律以 cancelled 回应，避免等待终端输入而挂起
- `args` 默认包含 `--no-session`，研究过程不写入会话文件；也可用 `--tools` 限定 pi 可用的工具
- 两种形式的失败（API 错误、子进程退出、超时、空结果）都按原有的失败兜底流程处理

## Web 面板

访问 `http://<host>:<port>`（由 `config.web` 配置）：

| 页面 | 功能 |
|------|------|
| `/` | 群列表 |
| `/group/{id}` | 群消息 CRUD 浏览：分页表格、按发送者/内容搜索、单条/批量删除、详情弹窗（带图片的消息同时展示图片描述，含 reply/forward 嵌套图片）、手动 compact、按日期范围导入历史消息 |
| `/group/{id}/preview` | Prompt 预览 |
| `/group/{id}/harness` | 会话日志查看：新在前排序、前端分页、角色筛选、错误/中止高亮、条目 JSON 原文切换 |
| `/images` | 图片管理 |
| `/memories` | Graphiti 记忆管理：语义搜索 / 分页列表 / 实体图谱可视化（`?view=graph`，cytoscape.js 力导向图，节点点击查看详情并支持展开 1-hop 邻居、边点击查看事实并可删除） |

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
- `deep_research_topic` 可选；配置后会在消息轮回复前预先执行深度研究
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

## 图片处理配置

消息中的图片在交给 vision 模型描述前按上限处理：长边或总像素超过上限时按比例缩小，字节数超过上限时压缩，这几种处理后输出的都是 jpg；未超过上限的图片保持原有格式；帧的mimeType按实际字节格式给出。参数在 `config.ts` 的 `input` 中配置：

```typescript
input: {
    // ... 其他配置
    vision_max_size_bytes: 6 * 1024 * 1024,   // 压缩后的字节上限，默认6MB；超过则依次降低 jpeg 质量（70/60/50/40）并按每级0.75倍缩小尺寸，直到不超限或宽高都不大于400像素
    vision_max_frames: 5,                     // 动图最多抽取的帧数，默认5（按帧号均匀抽取）
    vision_initial_quality: 80,               // 动图抽帧与尺寸缩放时使用的 jpeg 质量，默认80
    vision_max_long_edge: 0,                  // 长边像素上限，默认0（不限制）；超过则按比例缩小
    vision_max_total_pixels: 0,               // 总像素（宽乘高）上限，默认0（不限制）；超过则按比例缩小
    vision_thinking_level: 'off',             // 图片描述 Agent 的思考级别，默认 off；端点不接受关闭思考时设为 minimal 等级别
}
```

长边与总像素两项上限取其中缩得更多的那一个，用 `vision_initial_quality` 重新编码；超过字节上限的图片再走字节上限的压缩流程。

## 技术栈

- **Bot**: TypeScript + OneBot V11 (ws) + better-sqlite3 + Drizzle ORM
- **LLM**: `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai` + Graphiti
- **Scheduling**: Croner
- **Web UI**: Astro 6.4 SSR (Node middleware)
