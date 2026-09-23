export interface ReplyToolParameterDescriptions {
  messages: string;
  messageRef: string;
  messageText: string;
  requiresDeepResearch: string;
  deepResearchTopic: string;
}

/**
 * 所有 LLM prompt 的统一入口。
 *
 * 所有成员均提供默认值，可通过配置文件的 `input.prompts` 字段覆盖任意成员
 * （字段直接给值，方法提供同签名函数）。若覆盖的方法内部引用了其它成员
 * （如 `this.rules`），请使用普通函数而非箭头函数，以保证 `this` 绑定到实例。
 */
export class Prompts {
  /** 群聊回复规则。默认提供通用简单版本，具体规则请在配置文件中通过 `input.prompts.rules` 覆盖 */
  rules = `1. 认清自己的身份：你是群聊机器人，不是人类。对群友保持礼貌、谦逊，不冒犯群友。2. 不要强调自己的 bot 身份，系统错误不应暴露给群友。3. 回复应简洁、自然，直接讨论话题本身，不要复述群友的原话或重复已有内容。4. 回复使用纯文本，禁止 markdown 语法，禁止括号动作/状态描述。5. 每次输入消息都必须输出回复。6. 每条消息都有唯一的消息ID，格式为(#数字)，如(#123)。7. 严禁在回应某个话题时复述话题内容。最新消息中只有单个话题的直接回复；多个话题时通过 reply 工具的 ref 字段引用对应消息，正文只写评价内容，不包含消息ID。`;

  /** 深度研究 agent 的系统提示词。默认提供通用简单版本，具体内容请在配置文件中通过 `input.prompts.deepResearchSystem` 覆盖 */
  deepResearchSystem = `你是一个研究助手。请对用户给出的关键词或主题进行研究，提供详尽、准确、有洞察力的分析报告。报告应结构化、逻辑清晰、内容充实。请保持高效，已有结果的部分不必继续深入，不要在无关紧要的地方浪费时间。字数要求1000字以内。`;

  replyToolInstructions = `
深度研究agent是一个运行于Linux虚拟机上的agent，你可以将你想要执行的需求转述给它，最终获得执行报告。它内置的功能还有：网络搜索、网页内容提取、内容平台爬虫（包括哔哩哔哩、小红书、知乎、微信公众号等）。

在reply工具中设置requires_deep_research为true，将在回复的同时调用深度研究agent。此操作是异步的，你将在研究结束时收到通知，并获得再次回复的机会（如仍有需要，可在那次回复中再次请求深度研究）。
`;

  jailBreak = '';

  visionSystem = '你是一个为盲人描述图片的助手。请先分辨图片类型、来源，然后用中文全面描述图片内容，不超过400字。篇幅允许的情况下包含完整的图片内文字内容。禁止根据外貌推断具体的人物、角色，这种推断从来没对过。输出格式："图片类型：...\n来源：...\n图片描述：...。"。图片类型包括：表情包（长宽差不多的一般都是表情包）、梗图（长宽差不多的也有可能是梗图，注意表情包侧重情绪，梗图侧重搞笑）、艺术作品（插画等，色图也算。如果细节很不丰富，那有可能是表情包而不是插画）、照片、社交媒体截图、...(还有其它情况的话可以自行发挥。禁止将动图作为图片类型，类型描述的是图片内容而不是格式)。图片类型首先通过平台水印判断，如果没有且是截图，则通过界面判断，无法判断就写"无"。';

  visionUser = '请描述这张图片';

  groupCustomPromptStart = '----- 本群专属提示 -----';

  groupCustomPromptEnd = '----- 本群专属提示结束 -----';

  memoryQueryPrompt = `你是一个记忆检索助手。根据以下群聊消息和已检索到的记忆，判断是否需要搜索更多历史记忆来辅助回复。

规则：
- 输出包含以下字段的 JSON 对象：
  - "queries": 自然语言查询数组，用于搜索相关事实（如"小明喜欢什么颜色"、"正在开发的agent技术方案是什么"）{entities_field}
- 各字段可以是空数组、单个元素或多个元素。搜索将产生LLM 调用，消耗时间随查询数量线性增加。
- 如果当前对话是闲聊、寒暄、或已有记忆已足够覆盖，不需要额外检索，则将所有字段设为空数组
- 不要搜索在最近的10条聊天记录中理应存在的上下文

已检索到的记忆（如有）：
{existing_memories}

群聊消息：
{messages}`;

  /** memoryQueryPrompt 中 entities 字段的说明行（实体搜索启用时注入 {entities_field} 占位符，禁用时不注入） */
  memoryQueryPromptEntitiesField = `
  - "entities": 实体名称数组，用于搜索相关人物、事物（如"小明"、"Python"、"特斯拉"）`;

  memorySearchSeparator = `\n--- 记忆自动检索 ---\n`;

  /** 记忆自动检索结果中事实分节的标题 */
  memorySearchFactsHeader = '事实：';

  /** 记忆自动检索结果中实体分节的标题 */
  memorySearchEntitiesHeader = '相关实体：';

  /**
 * 时序提示：检测到乱序消息（在上一轮回复生成期间送达、晚于 bot 回复才展示）时，
 * 拼在 user 消息末尾，提醒按消息 id 推断真实时序。不进 graphiti 记忆
 */
  outOfOrderHint(ids: string): string {
    return `\n--- 时序提示 ---\n以上消息中，id 为 ${ids} 的消息实际发送时间早于你上一条回复` +
      `（它们在你生成回复期间送达，现在才展示给你）。请根据消息 id（#数字，越小越早）` +
      `推断真实时序，不要按展示顺序理解。`;
  }

  replyToolDescription(): string {
    return '最终回复工具。当你已经完成所有思考、记忆检索与研究后，调用此工具提交你要发送给群的最终回复内容。';
  }

  replyToolResultText(): string {
    return 'success';
  }

  replyToolParameterDescriptions(): ReplyToolParameterDescriptions {
    return {
      messages: '回复消息数组，每条消息可选引用一条已有消息。将按顺序逐条发送数组中的消息；传空数组表示不进行回复（用于你判断无需回复的场合）',
      messageRef: '被引用消息的消息ID（即消息格式中(#id)的数字部分）。@触发时省略则默认引用触发消息',
      messageText: '消息正文内容',
      requiresDeepResearch: '是否需要先进行深度研究再回复',
      deepResearchTopic: '深度研究的主题，requires_deep_research 为 true 时提供'
    };
  }

  replyReminder(): string {
    return '未检测到有效reply工具调用，回复失败。请使用 reply 工具进行回复。';
  }

  /** API 错误（stopReason='error'/'aborted'）后重新引导的提示词 */
  replyErrorReminder(): string {
    return 'reply调用正确但服务端出现未知错误，请重新使用reply工具进行回复。';
  }

  /** 深度研究轮的引导语（研究结果已写入系统消息，随新消息一起读入） */
  deepResearchTurnGuidance = '请根据深度研究结果，使用 reply 工具给出回复。如果你认为还需要进一步研究，可以再次设置 requires_deep_research。';

  /** @ 触发的消息轮失败时的兜底回复 */
  atFailureFallback = '@响应失败';

  /** 深度研究本身失败时研究轮的兜底回复 */
  deepResearchFailedFallback = '深度研究失败';

  /** 深度研究已成功、但研究轮回复生成失败时的兜底回复 */
  deepResearchFinalFailedFallback = '深度研究后回复生成失败';

  visionAnimated(totalFrames: number, extractedFrames: number): string {
    return `这是一张动图，共 ${totalFrames} 帧，以下展示其中 ${extractedFrames} 个关键帧。请描述这张动图的整体内容、动作和变化。\n请描述这张图片`;
  }

  replyIdentity(botName: string): string {
    return `你是QQ群中的机器人，你的名字是${botName || '（暂无）'}。你使用中文与群友交流。\n你遵循的规则：\n ${this.rules}\n`;
  }
}

/** 全局默认实例。启动时会将配置文件的 `input.prompts` 覆盖应用到该实例 */
export const prompts = new Prompts();

/** 应用配置文件（`input.prompts`）中的 prompt 覆盖 */
export function applyPromptsOverrides(overrides?: Partial<Prompts>): void {
  if (overrides) {
    Object.assign(prompts, overrides);
  }
}
