import {config, models} from '@/config';
import {createApplication} from './app';

const app = createApplication({config, models});
await app.start();

let shuttingDown = false;
async function shutdown (signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`[Shutdown] received ${signal}, starting graceful shutdown...\n`);
    await app.stop();
    process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
