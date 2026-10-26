export interface WaitOptions {
    description: string;
    timeoutMs?: number;
    intervalMs?: number;
}

function timeoutMessage (options: WaitOptions, lastError: unknown): string {
    const parts = [`waitFor timed out after ${options.timeoutMs ?? 5000}ms: ${options.description}`];
    if (lastError instanceof Error) {
        parts.push(`last error: ${lastError.message}`);
    } else if (lastError !== undefined) {
        parts.push(`last error: ${String(lastError)}`);
    }
    return parts.join(' | ');
}

export async function waitFor (
    condition: () => boolean | Promise<boolean>,
    options: WaitOptions
): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 5000;
    const intervalMs = options.intervalMs ?? 10;
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;

    for (;;) {
        try {
            if (await condition()) return;
        } catch (err) {
            lastError = err;
        }
        if (Date.now() >= deadline) {
            throw new Error(timeoutMessage(options, lastError));
        }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
}

export async function waitForValue<T> (
    read: () => T | undefined | Promise<T | undefined>,
    options: WaitOptions
): Promise<T> {
    let value: T | undefined;
    await waitFor(async () => {
        value = await read();
        return value !== undefined;
    }, options);
    return value as T;
}

export function sleep (ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
