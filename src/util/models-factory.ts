import {createProvider, type MutableModels} from '@earendil-works/pi-ai';
import {openAICompletionsApi} from '@earendil-works/pi-ai/api/openai-completions.lazy';
import {openAIResponsesApi} from '@earendil-works/pi-ai/api/openai-responses.lazy';
import type {AppConfig, ModelEntry} from '../config';
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

export {models, credentialStore};
