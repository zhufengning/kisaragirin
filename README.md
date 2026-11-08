# Kisaragirin OneBot

基于 OneBot V11 的 QQ 机器人。

## 功能

- 接收并存储群消息
- 下载、去重并 AI 描述消息中的图片；消息文本以 `[image#12: 描述]` 形式展示图片，模型可用 `ask_image` 工具按图片 id 向视觉模型追问细节
- 回复工具可按图片 id 发送已有图片；模型可将图片收藏为表情包（分类与备注），所有群共享同一个表情包库，收藏列表在每次压缩后注入会话头部
- 自动回复：@触发、闲时触发
- 按群定时任务触发
- 支持深度研究多轮回复（研究轮可链式再次请求研究，轮数上限可配置）
- 群总体记忆压缩：每日04:00、上下文达到设定比例或手动触发；压缩后创建新 session，并在开头插入总体记忆
- 新群 session 默认不自动导入历史消息，可在 Web 面板按日期范围手动导入（忽略旧版压缩消息）
- 回复前自动检索 Graphiti 相关记忆注入上下文
- Web 面板：群消息浏览、Prompt 预览、图片管理、Graphiti 记忆管理、总体记忆查看与删除、手动压缩、历史消息导入
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
- 新群的会话创建时不自动导入数据库历史消息，`lastTriggerId` 直接推进到该群最新消息；数据库已有总体记忆时，会将其作为新会话的第一条消息；如需其他历史上下文，可在 Web 面板的群消息页按日期范围手动导入（导入会忽略旧版压缩消息）
- 每日04:00整理群总体记忆；每个回复任务前后检查上下文占用，达到 `input.compact_context_ratio`（默认0.8）时也触发整理。总体记忆包含群总体印象、群内重要事件、群友印象与仍未结束的话题，字数上限由 `input.compact_max_chars` 控制（默认3000），超出时要求模型缩减至符合上限
- 总体记忆保存在 SQLite 的 `kv_store` 中。每次整理成功后创建独立的新 session 文件，并将总体记忆放在会话顶部；删除 session 文件后仍可从数据库恢复。Web 面板可查看或删除总体记忆，删除后立即更换为不含总体记忆的新会话
- 启用 Graphiti 时，可在回复中通过 `search_memory` 工具搜索记忆；记忆自动创建（触发回复时合并消息，内容与模型看到的 user message 一致；bot 回复发送后、深度研究结果产生时）；通过覆写 graphiti-core 官方语言扩展点强制事实与摘要以简体中文生成（专有名词/昵称/引用原文保留）；服务端在传输层用 jsonrepair 修复模型返回的非法 JSON（markdown 围栏、被截断、根值之后的尾随内容）
- 图片描述不足以判断图片内容时，模型可调用 `ask_image`（参数为图片 id 与具体问题）向 vision 模型追问，追问使用独立的问答 prompt，回答只作为工具结果返回，不改写已保存的图片描述
- 回复消息中的每条可以是文字或图片（`image_id`），文字与图片不能同时出现在一条消息；未请求深度研究时不得设置 `deep_research_topic`。图片默认按表情（`sub_type=1`）发送，消息中设置 `not_sticker: true` 时按普通图片发送。校验不通过时 reply 工具返回失败提示且不发送，模型可修正后重新调用
- 模型可通过 `add_sticker`（图片 id、分类、备注）收藏表情包，通过 `remove_sticker` 按图片 id 取消收藏；表情包库由所有群共享，收藏数量上限由 `input.sticker_max_count` 控制（默认50）。首次读取时自动合并旧版按群收藏并删除旧键。收藏列表在每次压缩创建新会话时写入会话头部，列表为空时保留结构并标注内容为空；当前对话中新收藏的表情不会立即写入该列表
- 可通过 `ai.graphiti.llm.headers` 为 Graphiti 的 LLM 请求附加自定义头部；值为 null 表示删除 SDK 默认头部（如 `X-Stainless-*`）。该配置只作用于生成型 LLM，嵌入与重排请求由 graphiti-core 内部各自创建客户端，不受其影响
- `ai.graphiti.llm.structured_output_mode` 指定 Graphiti 抽取等结构化输出的请求方式，默认 `json_schema`（`response_format` 携带 pydantic schema）。端点按严格模式校验 schema（要求每个 object 显式给出 `additionalProperties: false`）时设为 `json_object`：`response_format` 为 `json_object`，schema 拼入 prompt 末尾。端点完全不提供 `response_format` 时设为 `none`：请求不带该字段，schema 只拼入 prompt 末尾；返回内容由 jsonrepair 清洗后再解析
- 配置 `ai.assignments.memory_keyword` 后，每次回复前自动从最新消息生成搜索关键词（自然语言查询 + 实体名称）检索 Graphiti，将相关记忆按「事实」与「相关实体」两节注入上下文；实体搜索由 `ai.memoryKeyword.enable_entity_search` 控制（默认关闭，关闭时仅注入事实列表）
- 可通过 `ai.memoryKeyword.disable_thinking` 关闭记忆关键词生成模型的深度思考（`openai-completions` 协议注入 `thinking=disabled`）；`openai-responses` 协议用 `ai.memoryKeyword.reasoning_effort` 指定 `reasoning.effort`，不设置则不注入
- 记忆关键词生成的请求协议按所配模型 `model.api` 区分：`openai-responses` 走 `/responses`（JSON 输出用 `text: {format: {type: 'json_object'}}`），其余走 OpenAI 兼容的 chat completions（JSON 输出用 `response_format: {type: 'json_object'}`）；端点不支持时可将 `ai.memoryKeyword.response_format` 设为 false，此时返回内容由 jsonrepair 修复后再解析

## 总体记忆压缩配置

```typescript
input: {
    // 上下文占用达到80%时压缩；0表示禁用比例触发
    compact_context_ratio: 0.8,
    // 总体记忆最多3000字，超出时持续要求模型缩减
    compact_max_chars: 3000,
}
```

每日04:00的压缩始终注册到所有白名单群，不依赖 `input.scheduled_tasks`。压缩与回复在同一群队列中串行执行，压缩不会向群内发送消息。

## 表情包收藏配置

```typescript
input: {
    // 表情包收藏数量上限，默认50
    sticker_max_count: 50,
}
```

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
- 会话回复中模型回退不消耗 reminder 额度；回退链全部失败后才进入原有 reminder 重试（最多 2 次）
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
| `/group/{id}` | 群消息 CRUD 浏览：分页表格、按发送者/内容搜索、单条/批量删除、详情弹窗（带图片的消息同时展示图片描述，含 reply/forward 嵌套图片）、手动压缩、按日期范围导入历史消息 |
| `/group/{id}/memory` | 群总体记忆查看与删除 |
| `/group/{id}/preview` | Prompt 预览 |
| `/group/{id}/harness` | 会话日志查看：新在前排序、前端分页、角色筛选、错误/中止高亮、条目 JSON 原文切换 |
| `/images` | 图片管理：分页展示（固定卡片高度，卡片显示图片 id）、描述搜索与编辑、删除描述 |
| `/stickers` | 表情包收藏管理：添加 / 编辑分类与备注 / 删除 |
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
- 表情包使用与收藏规则写在 `input.prompts.rules` 中
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

图片描述与图片追问共用上述预处理参数与 vision 模型 assignment；追问任务插到描述队列队头，同样计入 `vision_concurrency` 的并发上限。

## 集成测试

`test/integration/` 提供完整的消息回复调度集成测试，覆盖消息入库顺序、@合并窗口、闲时触发、定时任务、每群 FIFO 与跨群并行、水位线与乱序提示、工具循环、图片追问、图片发送与表情包收藏、深度研究回合链、模型回退与 reminder、Graphiti 检索与 episode、图片描述队列以及进程重启恢复。

```bash
pnpm run test:integration
```

测试只替换外部服务，项目内部组件全部运行真实代码：OneBot WebSocket 客户端与消息转换、SQLite 与迁移、`GroupReplyManager`、`ScheduledTaskManager`、`ReplyAgent`、`DescQueue` 与图片预处理、`GraphitiClient` 的 stdio JSON-RPC 通信、Croner 定时器。总体记忆场景覆盖上下文比例触发、超长摘要缩减、新会话注入与会话文件删除后的恢复。

- 每个场景通过 `src/app.ts` 组合入口启动一个独立的应用子进程，使用场景目录自己的 SQLite、会话文件与端口
- 假 OneBot server 注入真实格式的群消息事件；假 OpenAI Completions server 按 channel 返回流式工具调用、文本、非流式 JSON 或 HTTP 错误，并用闸门控制并发时序；假图片资源 server 提供真实图片字节；假 Graphiti server 用 Python 标准库实现，通过控制文件与记录文件与测试父进程交换状态
- 并发时序由闸门与事件等待控制，时间相关场景使用缩短后的合并窗口与闲时等待，`reply_probability` 固定为 0 或 1
- 场景产物保存在 `data/test-runs/<scenario>-<uuid>/`（`config.json`、`app.log`、`app.out.log`、`onebot-events.jsonl`、`openai-requests.jsonl`、`graphiti-calls.jsonl`、`messages.db`、`data/`），成功场景自动删除，失败场景保留用于诊断

完整验证命令：

```bash
pnpm run type:check
pnpm run lint
pnpm run web:check
pnpm run web:lint
pnpm run test:integration
```

## 技术栈

- **Bot**: TypeScript + OneBot V11 (ws) + better-sqlite3 + Drizzle ORM
- **LLM**: `@earendil-works/pi-coding-agent` + `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai` + Graphiti
- **Scheduling**: Croner
- **Web UI**: Astro 6.4 SSR (Node middleware)
