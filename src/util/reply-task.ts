import type {StoredMessage} from '~/message-format';

export interface ReplyTask {
    type: 'at' | 'silence' | 'scheduled';
    triggerDbId: number;
    triggerMessageId: number;
    triggerMessage: StoredMessage;
    lastTriggerId: number;
    scheduledTaskName?: string;
    preResearchTopic?: string;
}

export interface ScheduledReplyTask {
    name: string;
    prompt: string;
    deepResearchTopic?: string;
}
