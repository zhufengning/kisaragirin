export interface RetryOptions {
    /** 最大重试次数（默认 3） */
    maxRetries?: number;
    /** 首次退避基数 ms（默认 2000） */
    baseDelayMs?: number;
    /** 判断错误是否可重试（默认使用内置规则） */
    isRetryable?: (error: unknown) => boolean;
    /** 每次重试前回调 */
    onRetry?: (attempt: number, maxRetries: number, delayMs: number, error: unknown) => void;
}

const RETRYABLE_PATTERN =
    /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

/** 判断错误消息/对象是否属于可重试的网络/服务端错误 */
export function isRetryableError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return RETRYABLE_PATTERN.test(msg);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error('Aborted'));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('Aborted'));
        }, { once: true });
    });
}

/**
 * 对异步函数进行指数退避重试封装。
 * 适合包装 Agent.prompt() 等可能因网络/限流失败的调用。
 */
export async function withRetry<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    options: RetryOptions = {},
    signal?: AbortSignal,
): Promise<T> {
    const maxRetries = options.maxRetries ?? 3;
    const baseDelayMs = options.baseDelayMs ?? 2000;
    const shouldRetry = options.isRetryable ?? isRetryableError;
    const onRetry = options.onRetry;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (signal?.aborted) {
            throw new Error('Aborted');
        }
        try {
            return await fn(signal ?? new AbortController().signal);
        } catch (err) {
            if (signal?.aborted) {
                throw err;
            }
            if (attempt >= maxRetries || !shouldRetry(err)) {
                throw err;
            }
            const delayMs = baseDelayMs * 2 ** attempt;
            onRetry?.(attempt + 1, maxRetries, delayMs, err);
            await sleep(delayMs, signal);
        }
    }

    throw new Error('withRetry unreachable');
}
