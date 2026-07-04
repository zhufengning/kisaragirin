import type {ApiKeyCredential, Credential, CredentialStore} from '@earendil-works/pi-ai';
import type {ModelEntry} from '../config';
import {Logger} from '@lib/util/logger';

const logger = new Logger();

export function createInMemoryCredentialStore (): CredentialStore {
    const credentials = new Map<string, Credential>();

    return {
        async read (providerId: string): Promise<Credential | undefined> {
            return credentials.get(providerId);
        },

        async modify (
            providerId: string,
            fn: (current: Credential | undefined) => Promise<Credential | undefined>,
        ): Promise<Credential | undefined> {
            const current = credentials.get(providerId);
            const next = await fn(current);
            if (next !== undefined) {
                credentials.set(providerId, next);
            }
            return next ?? current;
        },

        async delete (providerId: string): Promise<void> {
            credentials.delete(providerId);
        }
    };
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
