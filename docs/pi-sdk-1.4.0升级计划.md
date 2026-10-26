# pi SDK 1.4.0升级计划

## 版本基线

| 组件 | 当前版本 | 目标版本 |
|---|---:|---:|
| `@earendil-works/pi-ai` | `0.80.2` | `1.4.0` |
| `@earendil-works/pi-agent-core` | `0.80.2` | `1.4.0` |
| `@earendil-works/pi-coding-agent` | 未直接依赖 | `1.4.0` |
| 深度研究使用的pi CLI | `1.4.0` | `1.4.0` |

`package.json`中的依赖范围为`^0.80.2`，`pnpm-lock.yaml`锁定的版本同样为`0.80.2`。

两个SDK在当前版本和目标版本中都要求Node.js`>=22.19.0`。

## 当前SDK调用范围

### pi-agent-core

- `src/util/desc-queue.ts`
  - 使用`Agent`调用图片描述模型。
  - 使用`initialState`、`getApiKey()`、`reset()`、`prompt()`、`waitForIdle()`和`abort()`。
- `src/util/reply-agent.ts`
  - 使用`AgentHarness`执行回复对话、工具循环、模型切换和compact。
  - 使用`appendMessage()`导入历史消息和写入bot回复。
  - 使用`tool_call`事件限制工具调用次数。
- `src/util/harness-factory.ts`
  - 使用`JsonlSessionRepo`、`Session`和`NodeExecutionEnv`管理每群一个JSONL会话。
- `src/util/memory-context.ts`和Web会话日志页面
  - 使用`Session.getBranch()`及`SessionTreeEntry`读取会话历史。

### pi-ai

- `config.ts`
  - 使用`createModels()`建立模型集合。
  - 注册`minimax-cn`、`xiaomi`、`xiaomi-token-plan-cn`、`opencode-go`和`kimi-coding` provider。
- `src/util/models-factory.ts`
  - 使用`createProvider()`注册自定义OpenAI兼容provider。
  - 使用`openAICompletionsApi()`和`openAIResponsesApi()`。
- `src/util/credential-store.ts`
  - 使用项目自己的内存`CredentialStore`实现。
- `src/util/deep-research.ts`
  - 使用`Models.completeSimple()`执行单次研究。
- 多个业务文件使用`Model`、`Api`、`AssistantMessage`、`Context`、`Type`和消息内容类型。

### pi CLI RPC

`src/util/pi-rpc-client.ts`使用：

- `prompt`
- `agent_settled`
- `message_end`
- `get_last_assistant_text`
- `extension_ui_request`和`extension_ui_response`

## SDK差别

### AgentHarness及旧会话API已经移除

从`pi-agent-core`的`1.0.0`变更记录开始，以下导出已经移除：

- `AgentHarness`
- `Session`、`JsonlSessionRepo`及其他旧会话存储API
- `NodeExecutionEnv`所在的`./node`入口
- compact、skills、prompt templates等旧harness功能
- `SessionTreeEntry`

`pi-agent-core@1.4.0`保留`Agent`、agent loop、proxy stream及相关类型。只修改依赖版本会产生无法解析的导入，回复会话需要迁移到`@earendil-works/pi-coding-agent`提供的以下API：

- `AgentSession`
- `SessionManager`
- `ModelRuntime`
- `SettingsManager`
- `ResourceLoader`
- `ToolDefinition`

这些API覆盖当前使用的持久会话、工具循环、compact、模型切换、事件订阅和会话历史读取。

### 图片描述Agent需要显式提供streamFn

`AgentOptions.streamFn`在目标版本中是必需字段。`DescQueue.createAgent()`需要增加：

```ts
streamFn: models.streamSimple.bind(models)
```

现有`initialState`、`prompt()`、`reset()`、`waitForIdle()`和`abort()`调用方式可以继续使用。

`Agent.reset()`要求Agent处于空闲状态。当前描述队列在每次新描述前调用`reset()`，符合这个要求。

### CredentialStore接口扩展

目标版本的`CredentialStore`增加：

```ts
list(options?): Promise<readonly CredentialInfo[]>
```

`modify()`和`delete()`还需要按provider串行执行，并支持可选的取消信号。

使用SDK提供的`InMemoryCredentialStore`即可满足完整接口。现有`populateCredentialStore()`逻辑可以保留，启动时应当等待其完成，确保`AgentSession`进行模型认证检查前凭据已经写入。

### ModelRuntime与现有Models的关系

`ModelRuntime`实现`Models`，可以直接用于：

- `AgentSession`
- `DescQueue`的`streamFn`
- `DeepResearchRunner.models`
- 其他只依赖`Models`的业务代码

它不提供`MutableModels.setProvider()`，provider注册改为：

```ts
modelRuntime.registerNativeProvider(provider)
```

现有`createProvider()`生成的自定义provider仍然可用。回复会话、图片描述和深度研究应共用同一个`ModelRuntime`，保证provider和凭据状态一致。

### AgentSession.prompt()的返回值不同

当前代码依赖：

```ts
const assistant = await harness.prompt(text)
```

`AgentSession.prompt()`返回`Promise<void>`。最终`AssistantMessage`需要通过`session.subscribe()`监听`message_end`事件取得。每次prompt或reminder开始前清空上一轮记录，工具循环中的最后一次assistant事件就是本次需要检查的消息。

以下现有判断仍可保留：

- `stopReason === 'error'`
- `stopReason === 'aborted'`
- `errorMessage`
- `usage`

目标版本还增加了`durationMs`、`thinkingLevel`、`deferred`等字段或状态，不影响现有字段读取。

### 工具定义和工具限制迁移

`reply`和`search_memory`可以作为`customTools`传给`createAgentSession()`，并使用`ToolDefinition`和`defineTool()`保留参数类型推导。

工具调用限制通过内联extension注册`tool_call`处理器：

- `reply`直接放行。
- 其他工具增加计数。
- 超过`max_tool_call_rounds`时返回`{block: true, reason: ...}`。

目标版本继续支持`terminate: true`，`reply`提前结束工具循环的行为可以保留。

创建会话时使用`noTools: 'builtin'`，这样只禁用编码工具，保留自定义的`reply`和`search_memory`。`noTools: 'all'`也会禁用自定义工具，不适用于当前回复会话。

### 会话运行策略

`AgentSession`默认启用了一些当前回复流程没有使用的功能。为保持现有编排行为，`SettingsManager.inMemory()`应设置：

```ts
{
    retry: {enabled: false},
    compaction: {enabled: false},
    cacheWarming: 'off'
}
```

对应关系：

- `retry.enabled: false`：继续由`promptWithReminders()`控制模型回退和reminder次数。
- `compaction.enabled: false`：保留当前手动compact入口，避免新增自动compact时序。
- `cacheWarming: 'off'`：避免产生额外的缓存预热请求和费用。

这些设置只关闭对应自动功能，手动`session.compact()`仍可使用。

### system prompt构建

`AgentSession`默认会构造编码助手提示词，并追加工作目录、技能和项目资源。当前机器人需要继续使用`buildSystemPrompt()`生成的人设、群专属指令和工具说明。

升级时应提供自定义`ResourceLoader`：

- 不加载项目extensions、skills、prompt templates、themes和项目上下文文件。
- 通过内联extension的`before_agent_start`返回当前`systemPrompt`，使实际发送内容继续由`src/util/reply-prompt.ts`控制。
- 调用`session.prompt()`时设置`expandPromptTemplates: false`，避免把群消息前缀当作命令或模板处理。

这样`buildPreviewPrompt()`和实际prompt仍可共用现有构建逻辑。

### 会话文件兼容性

旧`AgentHarness`和新`SessionManager`都使用version 3 JSONL头，主要条目一致：

- `message`
- `compaction`
- `model_change`
- `thinking_level_change`
- `branch_summary`
- `custom`
- `custom_message`
- `label`
- `session_info`

现有`data/harness/`中的文件可以通过`SessionManager.open(fixedPath)`打开。

旧文件中的`active_tools_change`会被新运行时的上下文投影忽略；新会话会根据当前注册的`reply`和`search_memory`建立工具体系，不影响回复功能。Web日志仍应保留对这些旧条目的兼容显示。

`SessionManager`还新增了`usage`和`context_edit`条目，Web类型和渲染器需要同步更新。

### provider相关变化

与项目实际使用直接相关的变化包括：

- `kimi-coding`
  - 从Anthropic Messages改为OpenAI Chat Completions。
  - 默认base URL改为`https://api.kimi.com/coding/v1`。
  - 当前配置直接从`kimiCodingProvider()`取得模型，升级provider后会自动使用新协议和地址。
  - 如果其他模型配置覆盖了该provider的base URL，覆盖值需要包含`/v1`。
- `opencode-go`
  - provider已迁移到新的`opencode.ai/inference`端点，并增加更多协议适配。
  - 当前自定义OpenCode模型已经使用`https://opencode.ai/inference/go/v1`。
- `minimax-cn`
  - `MiniMax-M3`仍保留，目标版本另增了`MiniMax-M3.1-Flash`。
- `xiaomi`
  - 内置模型的thinking能力元数据有调整。
  - 项目手工声明的模型不会自动获得内置目录的元数据变化，应继续以项目中的模型定义为准进行验证。

`createProvider()`、`openAICompletionsApi()`、`openAIResponsesApi()`、`Model`、`Api`、`Context`和基础TypeBox用法仍然可用。当前代码没有使用已经移除的TypeBox API。

### RPC协议兼容性

目标版本仍保留当前使用的命令和事件。`prompt`响应现在包含`disposition`，当前客户端已经要求其为`started`，与单次新进程研究的使用方式一致。

以下行为保持兼容：

- 严格JSONL分帧。
- 等待`agent_settled`。
- 检查assistant的`error`和`aborted`。
- 调用`get_last_assistant_text`。
- 取消无人值守的扩展对话框。
- 关闭stdin后有序退出。

`src/util/pi-rpc-client.ts`不需要因`1.4.0`修改。

## API迁移对应关系

| 当前API | 目标API |
|---|---|
| `AgentHarness` | `AgentSession` |
| `JsonlSessionRepo` | `SessionManager` |
| `Session` | `AgentSession`和`SessionManager` |
| `SessionTreeEntry` | `SessionEntry` |
| `harness.appendMessage()` | `sessionManager.appendMessage()`和`session.refreshContext()` |
| `harness.prompt()` | `session.prompt()`和`message_end`事件 |
| `harness.on('tool_call')` | 内联extension的`tool_call` |
| `harness.getModel()` | `session.model` |
| `harness.setModel()` | `session.setModel()` |
| `harness.compact()` | `session.compact()` |
| `harness.waitForIdle()` | `session.waitForIdle()` |
| `session.getBranch()` | `sessionManager.getBranch()` |
| 自定义`CredentialStore` | SDK `InMemoryCredentialStore` |
| `MutableModels.setProvider()` | `ModelRuntime.registerNativeProvider()` |
| `AgentTool[]`配置 | `ToolDefinition[]`和`customTools` |

## 执行计划

### 阶段一：统一依赖和模型运行时

- [ ] 在`package.json`中将三个pi包统一固定为`1.4.0`：
  - `@earendil-works/pi-ai`
  - `@earendil-works/pi-agent-core`
  - 新增`@earendil-works/pi-coding-agent`
- [ ] 通过pnpm更新`package.json`和`pnpm-lock.yaml`，确保没有同时保留多个pi-ai或pi-agent-core版本。
- [ ] 在`config.ts`中使用`ModelRuntime.create()`：
  - 传入现有`credentialStore`。
  - 设置`modelsPath: null`，避免读取另一份模型配置。
  - 设置`refreshOnCreate: false`，避免启动时刷新模型目录。
- [ ] 将内置provider和自定义provider注册迁移到`registerNativeProvider()`。
- [ ] 使用SDK的`InMemoryCredentialStore`替换项目自己的内存实现。
- [ ] 启动时等待`populateCredentialStore()`完成。
- [ ] 将`src/types/global.d.ts`和`web/src/types/global.d.ts`中的`MutableModels`调整为`Models`或`ModelRuntime`。
- [ ] 在`DescQueue.createAgent()`中补充`streamFn`。
- [ ] 执行`pnpm run type:check`和`pnpm run lint`。

涉及文件：

- `package.json`
- `pnpm-lock.yaml`
- `config.ts`
- `src/util/models-factory.ts`
- `src/util/credential-store.ts`
- `src/util/desc-queue.ts`
- `src/types/global.d.ts`
- `web/src/types/global.d.ts`

### 阶段二：迁移持久会话和回复Agent

- [ ] 重写`src/util/harness-factory.ts`，用`SessionManager`管理固定文件和缓存，保留现有KV元数据及`group-{id}.jsonl`文件位置。
- [ ] 在`ReplyAgent.create()`中使用`createAgentSession()`：
  - 传入`ModelRuntime`。
  - 传入当前assignment的首个模型。
  - 设置`thinkingLevel: 'high'`。
  - 使用`noTools: 'builtin'`。
  - 注册`reply`和Graphiti自定义工具。
  - 使用内存SettingsManager应用既定运行策略。
  - 使用空资源加载及当前system prompt。
  - 调用`bindExtensions({})`。
- [ ] 将`ReplyAgent`中的`session`和`harness`字段迁移为`AgentSession`及其`SessionManager`。
- [ ] 将历史导入和`appendBotMessage()`改为`appendMessage()`后调用`refreshContext()`。
- [ ] 使用`message_end`事件实现`promptWithReminders()`的assistant结果采集。
- [ ] 将模型同步逻辑迁移到`session.model`和`session.setModel()`。
- [ ] 将工具次数限制迁移到内联extension。
- [ ] 保留现有`TurnOutcome`、reminder、模型回退、空回复和`processedUpToId`逻辑。
- [ ] 将`closeAllSessions()`改为逐个`dispose()`并清空缓存。
- [ ] 执行`pnpm run type:check`和`pnpm run lint`。

涉及文件：

- `src/util/harness-factory.ts`
- `src/util/reply-agent.ts`
- `src/util/reply-tool.ts`
- `src/util/graphiti-tool.ts`
- `src/util/reply-prompt.ts`
- `src/util/memory-context.ts`

### 阶段三：迁移Web会话日志

- [ ] 将`SessionTreeEntry`导入替换为`@earendil-works/pi-coding-agent`的`SessionEntry`。
- [ ] 将`getBranch()`返回类型改为同步的`SessionEntry[]`。
- [ ] 保留旧`active_tools_change`等历史条目的显示能力。
- [ ] 为`usage`和`context_edit`增加明确渲染；未知条目继续显示JSON。
- [ ] 确认system message、compact和工具结果的筛选及错误高亮仍然有效。
- [ ] 执行`pnpm run web:check`和`pnpm run web:lint`。

涉及文件：

- `web/src/pages/api/harness.ts`
- `web/src/lib/harness-client.ts`
- `web/src/lib/harness-entry.ts`

### 阶段四：文档和完整检查

- [ ] 更新`README.md`和`AGENTS.md`中的AgentSession、SessionManager、ModelRuntime及包依赖说明。
- [ ] 保留`config.example.ts`现有配置结构；本次不需要新增配置项。
- [ ] 执行完整静态检查：

```bash
pnpm run type:check
pnpm run lint
pnpm run web:check
pnpm run web:lint
```

### 阶段五：使用真实配置验证运行行为

- [ ] 打开已有群会话，确认历史消息、compact摘要和模型记录可读取，`lastTriggerId`没有变化。
- [ ] 验证新session仍跳过已有历史，手动日期范围导入仍按原顺序写入。
- [ ] 验证`reply`正常结束对话、空消息数组不回复、引用参数正常传递。
- [ ] 验证`search_memory`可连续调用，超过工具次数上限后会被阻止。
- [ ] 验证API错误时按照assignment回退链切换模型，链耗尽后执行现有reminder次数。
- [ ] 验证手动compact可用，运行期间不会出现自动compact和缓存预热请求。
- [ ] 验证图片描述可以通过新的`streamFn`完成，并保留现有超时和模型回退。
- [ ] 分别验证深度研究的模型调用方式和pi RPC方式。
- [ ] 验证Web Prompt预览与真实发送内容一致，会话日志可以显示新旧条目。

## 测试要求

调度与并发回归使用[消息回复调度测试系统设计](消息回复调度测试系统设计.md)中的集成测试系统。测试只替换OneBot、OpenAI Completions和Graphiti外部服务，项目内部的消息转换、数据库、队列、Agent、定时任务和RPC客户端均运行真实代码。

pi SDK升级至少需要通过以下回归场景：

- 同群消息入库顺序。
- 每群回复FIFO和跨群并行。
- 回复期间新消息的水位线推进及乱序提示。
- @合并窗口、闲时触发和定时任务。
- 工具循环、模型回退、reminder和空回复。
- 深度研究回合链。
- 会话恢复、历史导入和手动compact。
- Graphiti episode及自动记忆检索。

## 数据与恢复方案

升级前在`data/`下建立受gitignore覆盖的备份目录，保存：

- `data/harness/`中的JSONL文件。
- 当前`package.json`和`pnpm-lock.yaml`副本。
- 与harness metadata相关的KV数据备份。

如果迁移后发现会话读取或上下文构造异常：

1. 停止向原会话文件追加内容。
2. 使用文件编辑工具恢复依赖清单和业务代码。
3. 恢复备份的JSONL及KV数据。
4. 执行`pnpm install`恢复锁定依赖。
5. 重新执行全部静态检查和调度集成测试。

重点检查旧`active_tools_change`条目、历史compact条目，以及新版system message进入现有会话后的上下文顺序。
