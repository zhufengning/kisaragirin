import {startScenario, type ScenarioEnvironment, type ScenarioOptions} from './scenario';

export async function runScenario (
    options: ScenarioOptions,
    body: (env: ScenarioEnvironment) => Promise<void>
): Promise<void> {
    const env = await startScenario(options);
    let bodyError: unknown;
    try {
        await body(env);
    } catch (err) {
        bodyError = err;
    }

    let closeErrors: Error[] = [];
    try {
        closeErrors = await env.close();
    } catch (err) {
        closeErrors = [err instanceof Error ? err : new Error(String(err))];
    }

    if (bodyError) {
        for (const error of closeErrors) {
            console.error(`[scenario ${options.name}] cleanup error: ${error.message}`);
        }
        console.error(`[scenario ${options.name}] 产物保留在 ${env.dir}`);
        throw bodyError;
    }

    if (closeErrors.length > 0) {
        console.error(`[scenario ${options.name}] 产物保留在 ${env.dir}`);
        throw closeErrors[0];
    }

    env.discardArtifacts();
}
