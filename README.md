# Kisaragirin OneBot

基于 OneBot V11 的 QQ 机器人，用大模型自动参与群聊、检索资料并维护长期记忆。

## 功能

- 群消息与图片存档：图片下载去重后由视觉模型生成描述，模型可在回复中按图片追问细节
- 自动回复：被 @ 时触发，长时间无人说话时按概率触发
- 多轮回复与深度研究：模型可先检索资料再回复，也可在回复后连续追加研究轮次
- 按群定时任务：crontab 表达式触发，可在回复前先完成一次研究
- 长期记忆：Graphiti 事实在回复前自动检索；群总体记忆每日压缩，上下文过长时也会压缩，压缩后带着总体印象继续对话
- 历史消息导入：新群的会话从最新消息开始，需要更早的上下文时在面板按日期范围导入
- 表情包：模型可收藏图片表情，也可按图片 id 发送已有图片
- Web 面板：群消息浏览、Prompt 预览、图片与表情包管理、记忆管理、会话日志

## 准备

- Node.js 与 pnpm
- OneBot V11 实现的 QQ 客户端（例如 NapCat），与 bot 通过 WebSocket 通信
- 启用 Graphiti 记忆时需要 uv 与 Neo4j

## 启动

```bash
pnpm install
cp config.example.ts config.ts   # 填写 OneBot 连接、模型与 Web 面板配置
pnpm web:build && pnpm start
```

数据库表在首次启动时自动创建，日志写入 `config.log.file`。

## 配置

所有配置都在 `config.ts`，`config.example.ts` 对每一项都有注释。常用部分：

- `onebot`：OneBot 实现的地址与 access token；`mode` 为 `ws`（bot 主动连接）或 `ws-reverse`（由 OneBot 实现连接 bot）
- `input.group_whitelist`：生效的群号列表，列表以外的群不处理
- `input.bot_name` / `input.bot_persona`：机器人名称与人设
- `input.prompts` / `input.group_custom_prompts`：覆盖默认提示词、为单个群追加指令；方法类型的成员需提供同签名函数
- `input.scheduled_tasks`：按群的定时任务
- `web`：面板监听地址、账号与密码
- `ai.models` / `ai.assignments`：模型定义与用途分配；assignment 可以写成单个模型 key、失败时依次尝试的模型数组，或按时间段选择模型的 `slots`
- `ai.assignments.deep_research`：字符串表示用 bot 自己的模型完成研究；对象形式交给 pi CLI 子进程，使用该子进程自己的模型与联网工具
- `ai.assignments.memory_keyword` / `ai.memoryKeyword` / `ai.graphiti`：记忆检索与 Graphiti 服务连接；未配置 `ai.graphiti` 时不启用长期记忆
- 图片预处理、思考级别、记忆压缩比例与字数上限、表情包数量上限、深度研究轮数、闲时触发检查、调试导出等开关同样在 `input` 中，默认值见 `config.example.ts`

## Web 面板

访问 `http://<host>:<port>`，账号与密码由 `config.web` 配置。

| 页面 | 功能 |
|------|------|
| `/` | 群列表 |
| `/group/{id}` | 群消息浏览与搜索、删除、清空全部、查看详情（含图片描述）、手动压缩总体记忆、按日期范围导入历史消息 |
| `/group/{id}/memory` | 群总体记忆查看与删除 |
| `/group/{id}/preview` | Prompt 预览 |
| `/group/{id}/harness` | 会话日志：角色筛选、错误高亮、条目原文查看 |
| `/images` | 图片描述搜索、编辑与删除 |
| `/stickers` | 表情包收藏的新增、分类备注与删除 |
| `/memories` | Graphiti 记忆搜索、删除与实体关系图 |

## 开发

```bash
pnpm run type:check
pnpm run lint
pnpm run web:check
pnpm run web:lint
pnpm run test:integration
```
