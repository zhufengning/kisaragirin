export const prompts = {
    visionSystem: '你是一个图片描述助手。请用简洁的中文描述图片内容，不超过30字。',
    visionUser: '请描述这张图片',
    visionAnimated(totalFrames: number, extractedFrames: number) {
        return `这是一张动图，共 ${totalFrames} 帧，以下展示其中 ${extractedFrames} 个关键帧。请描述这张动图的整体内容、动作和变化。\n请描述这张图片`;
    },
    replyIdentity(botName: string) {
        return `你是QQ群中的${botName || '机器人'}。你使用自然、亲切的中文与群友交流。`;
    },
    replyHistoryStart: '===== 历史消息 =====',
    replyLatestStart: '===== 最新消息 =====',
    replyStart: '请根据上述上下文决定如何回复。先使用 reply_first_turn 工具给出你的回复策略。',
    replyReminderFirstTurn: '请使用 reply_first_turn 工具进行回复决策。',
    replyReminderSecondTurn: '请使用 reply_second_turn 工具给出最终回复。',
    deepResearchSystem: '你是一个深度研究助手。请对用户给出的关键词或主题进行深入研究，提供详尽、准确、有洞察力的分析报告。报告应结构化、逻辑清晰、内容充实。',
};
