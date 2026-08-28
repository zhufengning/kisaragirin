import {createProvider, type MutableModels} from '@earendil-works/pi-ai';
import {openAICompletionsApi} from '@earendil-works/pi-ai/api/openai-completions.lazy';
import {openAIResponsesApi} from '@earendil-works/pi-ai/api/openai-responses.lazy';
import type {AppConfig, ModelEntry, ScheduledModelAssignment} from '../config';
import {models, credentialStore} from '../../config';

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

export function createBotModels (config: AppConfig): MutableModels {
    registerCustomProviders(models, config);
    return models;
}

export function resolveModelEntry (config: AppConfig, assignment: string): ModelEntry {
    const entry = config.ai.models[assignment];
    if (!entry) {
        throw new Error(`Unknown model assignment: ${assignment}`);
    }
    return entry;
}

/**
 * 解析 assignment：如果是字符串直接查表；如果是 ScheduledModelAssignment，
 * 根据当前时间匹配 slot（支持跨日），命中用 slot.model，否则用 default。
 */
export function resolveAssignmentModel (
    config: AppConfig,
    assignment: string | ScheduledModelAssignment
): ModelEntry {
    if (typeof assignment === 'string') {
        return resolveModelEntry(config, assignment);
    }

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
                return resolveModelEntry(config, slot.model);
            }
        } else if (nowMinutes >= startMin || nowMinutes < endMin) {
            // 跨日时段：[start, 24:00) ∪ [00:00, end)
            return resolveModelEntry(config, slot.model);
        }
    }

    return resolveModelEntry(config, assignment.default);
}

export {models, credentialStore};
