import {createProvider, type MutableModels} from '@earendil-works/pi-ai';
import {openAICompletionsApi} from '@earendil-works/pi-ai/api/openai-completions.lazy';
import {openAIResponsesApi} from '@earendil-works/pi-ai/api/openai-responses.lazy';
import type {AppConfig, ModelAssignmentKey, ModelEntry, ScheduledModelAssignment} from '../config';

function apiStreamsFor (modelApi: string) {
    if (modelApi === 'openai-completions') {
        return openAICompletionsApi();
    }
    if (modelApi === 'openai-responses') {
        return openAIResponsesApi();
    }
    throw new Error(`Unsupported custom model API: ${modelApi}`);
}

export function registerCustomProviders (modelsInstance: MutableModels, config: AppConfig): void {
    for (const entry of Object.values(config.ai.models)) {
        const providerId = entry.model.provider;

        if (modelsInstance.getProvider(providerId) !== undefined) {
            continue;
        }

        modelsInstance.setProvider(
            createProvider({
                id: providerId,
                name: providerId,
                baseUrl: entry.model.baseUrl,
                auth: {
                    apiKey: {
                        name: `${providerId} API key`,
                        resolve: async () => ({auth: {apiKey: entry.apiKey}})
                    }
                },
                models: [entry.model],
                api: apiStreamsFor(entry.model.api)
            }),
        );
    }
}

export function resolveModelEntry (config: AppConfig, assignment: string): ModelEntry {
    const entry = config.ai.models[assignment];
    if (!entry) {
        throw new Error(`Unknown model assignment: ${assignment}`);
    }
    return entry;
}

/**
 * 解析 assignment 为按回退顺序排列的 ModelEntry 列表：
 * - 字符串：单元素列表
 * - 元组（数组）：按数组顺序展开为回退链，API 错误时依次回退
 * - ScheduledModelAssignment：先按当前时间匹配 slot（支持跨日），
 *   命中用 slot.model（本身也支持元组），否则用 default（同样支持元组）
 */
export function resolveAssignmentModels (
    config: AppConfig,
    assignment: ModelAssignmentKey | ScheduledModelAssignment
): ModelEntry[] {
    let key: ModelAssignmentKey;

    if (typeof assignment === 'string' || Array.isArray(assignment)) {
        key = assignment;
    } else {
        key = resolveScheduledKey(assignment);
    }

    const keys = Array.isArray(key) ? key : [key];
    if (keys.length === 0) {
        throw new Error('Model assignment fallback chain is empty');
    }
    return keys.map(k => resolveModelEntry(config, k));
}

/** 按当前时间匹配 slot（支持跨日），返回命中的 slot.model 或 default */
function resolveScheduledKey (assignment: ScheduledModelAssignment): ModelAssignmentKey {
    const now = new Date();
    const nowMinutes = (now.getHours() * 60) + now.getMinutes();

    for (const slot of assignment.slots) {
        const [sh, sm] = slot.start.split(':').map(Number);
        const [eh, em] = slot.end.split(':').map(Number);
        const startMin = (sh * 60) + sm;
        const endMin = (eh * 60) + em;

        if (startMin <= endMin) {
            // 同日时段：[start, end)
            if (nowMinutes >= startMin && nowMinutes < endMin) {
                return slot.model;
            }
        } else if (nowMinutes >= startMin || nowMinutes < endMin) {
            // 跨日时段：[start, 24:00) ∪ [00:00, end)
            return slot.model;
        }
    }

    return assignment.default;
}
