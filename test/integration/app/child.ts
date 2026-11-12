import type {AppConfig} from '../../../src/config';
import type {Application} from '../../../src/app';

interface StartMessage {
    type: 'start';
    config: AppConfig;
    dbPath: string;
    graphitiServerPath?: string;
}

interface StopMessage {
    type: 'stop';
}

interface UpdateOverallMemoryMessage {
    type: 'update-overall-memory';
    groupId: number;
    content: string;
}

type ChildMessage = StartMessage | StopMessage | UpdateOverallMemoryMessage;

let app: Application | null = null;

function reply (message: Record<string, unknown>): void {
    process.send?.(message);
}

async function handleStart (message: StartMessage): Promise<void> {
    const {ModelRuntime} = await import('@earendil-works/pi-coding-agent');
    const {createApplication} = await import('../../../src/app');
    const models = await ModelRuntime.create({modelsPath: null, refreshOnCreate: false});
    app = createApplication({
        config: message.config,
        models,
        graphitiServerPath: message.graphitiServerPath,
        enableWebPanel: false,
        dbPath: message.dbPath
    });
    await app.start();
    await app.ready();
    reply({type: 'ready'});
}

async function handleMessage (message: ChildMessage): Promise<void> {
    try {
        if (message.type === 'start') {
            await handleStart(message);
            return;
        }
        if (message.type === 'update-overall-memory') {
            const manager = globalThis.__replyManagers__?.get(message.groupId);
            if (!manager) throw new Error(`group ${message.groupId} has no reply manager`);
            await manager.updateOverallMemory(message.content);
            reply({type: 'updated-overall-memory'});
            return;
        }
        if (message.type === 'stop') {
            const current = app;
            app = null;
            await current?.stop();
            reply({type: 'stopped'});
            setTimeout(() => process.exit(0), 10);
        }
    } catch (err) {
        const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
        reply({type: 'error', detail});
    }
}

process.on('message', (message: ChildMessage) => {
    void handleMessage(message);
});

reply({type: 'alive'});
