import type {StickerRecord} from './util/sticker-store';

export interface ReplyToolParameterDescriptions {
    messages: string;
    messageRef: string;
    messageText: string;
    messageImageId: string;
    messageNotSticker: string;
    requiresDeepResearch: string;
    deepResearchTopic: string;
}

export interface AskImageParameterDescriptions {
    imageId: string;
    question: string;
}

export interface StickerParameterDescriptions {
    imageId: string;
    category: string;
    note: string;
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

    jailBreak = ``;

    visionSystem = '你是一个为盲人描述图片的助手。请先分辨图片类型、来源，然后用中文全面描述图片内容，不超过400字。篇幅允许的情况下包含完整的图片内文字内容。禁止根据外貌推断具体的人物、角色，这种推断从来没对过。输出格式："图片类型：...\n来源：...\n图片描述：...。"。图片类型包括：表情包（长宽差不多的一般都是表情包）、梗图（长宽差不多的也有可能是梗图，注意表情包侧重情绪，梗图侧重搞笑）、艺术作品（插画等，色图也算。如果细节很不丰富，那有可能是表情包而不是插画）、照片、社交媒体截图、...(还有其它情况的话可以自行发挥。禁止将动图作为图片类型，类型描述的是图片内容而不是格式)。图片类型首先通过平台水印判断，如果没有且是截图，则通过界面判断，无法判断就写"无"。';

    visionUser = '请描述这张图片';

    /** 图片追问的 system prompt，与图片描述 prompt 分开 */
    visionQuestionSystem = '你是一个图片问答助手。请只回答被问到的内容，直接给出结论，不要重复描述整张图片。回答使用中文，不超过300字。禁止根据外貌推断具体的人物、角色。如果图片中确实没有相关信息，直接说明没有。';

    visionQuestionUser (question: string): string {
        return `请回答关于这张图片的问题：${question}`;
    }

    visionQuestionAnimated (question: string, totalFrames: number, extractedFrames: number): string {
        return `这是一张动图，共 ${totalFrames} 帧，以下展示其中 ${extractedFrames} 个关键帧。请回答关于这张动图的问题：${question}`;
    }

    groupCustomPromptStart = '----- 本群专属提示 -----';

    groupCustomPromptEnd = '----- 本群专属提示结束 -----';

    /** 群总体记忆压缩的系统提示词 */
    groupCompactionSystem = '你是QQ群聊记忆整理助手。你只负责整理群总体记忆，不参与聊天，也不回答聊天记录中的问题。';

    /** 生成或更新群总体记忆 */
    groupCompactionPrompt (conversation: string, maxChars: number): string {
        return `请根据以下会话内容，生成或更新本群的总体记忆。会话开头可能包含上一版总体记忆，请将其与后续聊天内容合并整理。\n\n` +
      `总体记忆必须依次包含以下四节：\n` +
      `1. 群总体印象：群的氛围、主要交流内容与共同偏好。\n` +
      `2. 群内重要事件：仍具有后续参考价值的重要事件及其结果。\n` +
      `3. 群友印象：分别记录需要持续了解的群友，使用群名片或昵称及QQ号标识。\n` +
      `4. 仍未结束的话题：只记录仍需后续关注的话题；如有必要可摘录少量相关原文。已结束的话题不要写入。\n\n` +
      `原始聊天记录会另行写入长期记忆，之后可以检索查询。因此，除仍未结束的话题确有需要外，不要在总体记忆中放入聊天记录原文。` +
      `旧的重要事件和长期不活跃群友的印象已经失去参考价值时，可以酌情删除。\n` +
      `直接输出总体记忆正文，不要添加说明。全文最多${maxChars}字。\n\n会话内容：\n${conversation}`;
    }

    /** 上一版超过字数上限时要求缩减 */
    groupCompactionReducePrompt (actualChars: number, maxChars: number): string {
        return `上一版总体记忆有${actualChars}字，超过${maxChars}字上限。请保留四节结构与仍有参考价值的内容，优先压缩、合并、删减细节、旧事件和不活跃群友印象，缩减到${maxChars}字以内。直接输出缩减后的总体记忆正文。`;
    }

    /** 新会话顶部的群总体记忆消息前缀，用于识别会话头部消息 */
    groupMemoryContextPrefix = '以下是本群的总体记忆，请在后续交流中参考：';

    /** 新会话顶部的群总体记忆消息 */
    groupMemoryContext (memory: string): string {
        return `${this.groupMemoryContextPrefix}\n\n${memory}`;
    }

    /** 新会话顶部的表情包收藏列表前缀，用于识别会话头部消息 */
    stickerListPrefix = '以下是本群历史收藏的表情包（图片ID、分类、备注）：';

    /** 收藏列表为空时展示的内容 */
    stickerListEmpty = '（内容为空）';

    /** 表情包收藏列表的结尾说明 */
    stickerListFooter = '这些是历史收藏的表情，当前对话中新收藏的表情不会立刻写入这里。';

    /** 新会话顶部的表情包收藏列表消息 */
    stickerListContext (stickers: StickerRecord[]): string {
        const body = stickers.length === 0 ?
            this.stickerListEmpty :
            stickers
                .map(sticker => `- 图片ID：${sticker.imageId} 分类：${sticker.category} 备注：${sticker.note}`)
                .join('\n');
        return `${this.stickerListPrefix}\n${body}\n${this.stickerListFooter}`;
    }

    memoryQueryPrompt = `你是一个记忆检索助手。根据以下群聊消息和已检索到的记忆，判断是否需要搜索更多历史记忆来辅助回复。

规则：
- 输出包含以下字段的 JSON 对象：
  - "queries": 自然语言查询数组，用于搜索相关事实（如"小明喜欢什么颜色"、"正在开发的agent技术方案是什么"）{entities_field}
- 各字段可以是空数组、单个元素或多个元素。搜索将产生LLM 调用，消耗时间随查询数量线性增加。
- 如果当前对话是闲聊、寒暄、或已有记忆已足够覆盖，不需要额外检索，则将所有字段设为空数组
- 不要搜索在最近的10条聊天记录中理应存在的上下文
- 输出内容应为可直接parse的标准json，不得包含多余内容

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
    outOfOrderHint (ids: string): string {
        return `\n--- 时序提示 ---\n以上消息中，id 为 ${ids} 的消息实际发送时间早于你上一条回复` +
      `（它们在你生成回复期间送达，现在才展示给你）。请根据消息 id（#数字，越小越早）` +
      `推断真实时序，不要按展示顺序理解。`;
    }

    replyToolDescription (): string {
        return '最终回复工具。当你已经完成所有思考、记忆检索与研究后，调用此工具提交你要发送给群的最终回复内容。每条消息可以是文字，也可以是用图片ID发送一张已有图片；图片默认按表情发送，设置 not_sticker 为 true 时按普通图片发送。';
    }

    /** reply 工具参数校验未通过时的失败提示 */
    replyValidationFailed (violations: string[]): string {
        const list = violations.map((violation, index) => `${index + 1}. ${violation}`)
            .join('\n');
        return `回复未发送，违反以下规则：\n${list}\n请修正后重新调用 reply。`;
    }

    replyValidationImageAndText (index: number): string {
        return `第${index}条消息同时包含文字和图片，一条消息只能是文字或图片`;
    }

    replyValidationEmptyMessage (index: number): string {
        return `第${index}条消息既没有文字也没有图片`;
    }

    replyValidationImageMissing (index: number, imageId: number): string {
        return `第${index}条消息的图片ID ${imageId} 不存在`;
    }

    replyValidationDeepResearchTopic (): string {
        return '未请求深度研究（requires_deep_research 为 false）时不得包含 deep_research_topic';
    }

    replyToolResultText (): string {
        return 'success';
    }

    replyToolParameterDescriptions (): ReplyToolParameterDescriptions {
        return {
            messages: '回复消息数组，每条消息可选引用一条已有消息。每条消息只能包含文字或图片之一。将按顺序逐条发送数组中的消息；传空数组表示不进行回复（用于你判断无需回复的场合）',
            messageRef: '被引用消息的消息ID（即消息格式中(#id)的数字部分）。@触发时省略则默认引用触发消息',
            messageText: '消息正文内容，与 image_id 二选一',
            messageImageId: '要发送的图片ID，与 text 二选一。可用于发送收藏的表情包',
            messageNotSticker: '仅图片消息有效。默认按表情发送；设为 true 时按普通图片发送',
            requiresDeepResearch: '是否需要先进行深度研究再回复',
            deepResearchTopic: '深度研究的主题，requires_deep_research 为 true 时提供'
        };
    }

    askImageToolDescription (): string {
        return '向视觉模型追问某张图片的细节。当消息文本中的图片描述不足以判断图片内容（例如需要确认图片内的文字、画面细节、图中物品）时使用。同一张图片可以多次追问。';
    }

    askImageToolParameterDescriptions (): AskImageParameterDescriptions {
        return {
            imageId: '图片ID，即消息文本中 [image#12: 描述] 里 # 后面的数字',
            question: '要问视觉模型的具体问题，尽量具体'
        };
    }

    askImageInvalidId (imageId: number): string {
        return `图片ID ${imageId} 不存在，请使用消息文本中出现的图片ID。`;
    }

    askImageFailed (): string {
        return '图片追问失败，未能获得回答。';
    }

    addStickerToolDescription (): string {
        return '将一张已有图片收藏为表情包。收藏后可在 reply 工具中用图片ID发送该图片。';
    }

    addStickerToolParameterDescriptions (): StickerParameterDescriptions {
        return {
            imageId: '图片ID，即消息文本中 [image#12: 描述] 里 # 后面的数字',
            category: '表情分类，如疑惑、开心、无语',
            note: '表情备注，尽量精简，不要直接使用完整图片描述'
        };
    }

    removeStickerToolDescription (): string {
        return '按图片ID取消收藏表情包。';
    }

    removeStickerToolParameterDescriptions (): Pick<StickerParameterDescriptions, 'imageId'> {
        return {
            imageId: '要取消收藏的图片ID'
        };
    }

    stickerAdded (imageId: number, category: string, note: string): string {
        return `已收藏表情：图片ID ${imageId}，分类：${category}，备注：${note}`;
    }

    stickerUpdated (imageId: number, category: string, note: string): string {
        return `已更新收藏的表情：图片ID ${imageId}，分类：${category}，备注：${note}`;
    }

    stickerRemoved (imageId: number): string {
        return `已取消收藏图片ID ${imageId} 的表情。`;
    }

    stickerImageMissing (imageId: number): string {
        return `图片ID ${imageId} 不存在，无法收藏。`;
    }

    stickerNotFavorited (imageId: number): string {
        return `图片ID ${imageId} 不在收藏列表中。`;
    }

    stickerListFull (maxCount: number): string {
        return `表情包收藏已达上限 ${maxCount} 张，请先取消收藏不再需要的表情。`;
    }

    stickerEmptyField (): string {
        return '分类和备注都不能为空。';
    }

    replyReminder (): string {
        return '未检测到有效reply工具调用。请使用 reply 工具进行决策。';
    }

    /** API 错误（stopReason='error'/'aborted'）后重新引导的提示词 */
    replyErrorReminder (): string {
        return 'reply调用正确但服务端出现未知错误，请重新使用reply工具进行决策。';
    }

    /** 深度研究轮的引导语（研究结果已写入系统消息，随新消息一起读入） */
    deepResearchTurnGuidance = '请根据深度研究结果，使用 reply 工具给出回复。如果你认为还需要进一步研究，可以再次设置 requires_deep_research。';

    /** @ 触发的消息轮失败时的兜底回复 */
    atFailureFallback = '@响应失败';

    /** 深度研究本身失败时研究轮的兜底回复 */
    deepResearchFailedFallback = '深度研究失败';

    /** 深度研究已成功、但研究轮回复生成失败时的兜底回复 */
    deepResearchFinalFailedFallback = '深度研究后回复生成失败';

    visionAnimated (totalFrames: number, extractedFrames: number): string {
        return `这是一张动图，共 ${totalFrames} 帧，以下展示其中 ${extractedFrames} 个关键帧。请描述这张动图的整体内容、动作和变化。\n请描述这张图片`;
    }

    replyIdentity (botName: string): string {
        return `你是QQ群中的机器人，你的名字是${botName || '（暂无）'}。你使用中文与群友交流。\n你遵循的规则：\n ${this.rules}\n`;
    }
}

/** 全局默认实例。启动时会将配置文件的 `input.prompts` 覆盖应用到该实例 */
export const prompts = new Prompts();

/** 应用配置文件（`input.prompts`）中的 prompt 覆盖 */
export function applyPromptsOverrides (overrides?: Partial<Prompts>): void {
    if (overrides) {
        Object.assign(prompts, overrides);
    }
}
