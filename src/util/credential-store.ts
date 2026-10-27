import {InMemoryCredentialStore, type ApiKeyCredential, type CredentialStore} from '@earendil-works/pi-ai';
import type {ModelEntry} from '../config';
import {Logger} from '@lib/util/logger';

const logger = new Logger();

export function createCredentialStore (): InMemoryCredentialStore {
    return new InMemoryCredentialStore();
}

export async function populateCredentialStore (
    store: CredentialStore,
    models: Record<string, ModelEntry>,
): Promise<void> {
    for (const entry of Object.values(models)) {
        const providerId = entry.model.provider;
        const key = entry.apiKey;

        if (!key || key.trim().length === 0) {
            continue;
        }

        const credential: ApiKeyCredential = {type: 'api_key', key};
        try {
            await store.modify(providerId, async () => credential);
        } catch (error) {
            logger.error(`Failed to populate credential for provider ${providerId}:`, error);
        }
    }
}
