export const prompts = {
    visionSystem: '你是一个图片描述助手。请用简洁的中文描述图片内容，不超过30字。',
    visionUser: '请描述这张图片',
    visionAnimated(totalFrames: number, extractedFrames: number) {
        return `这是一张动图，共 ${totalFrames} 帧，以下展示其中 ${extractedFrames} 个关键帧。请描述这张动图的整体内容、动作和变化。\n请描述这张图片`;
    },
};
