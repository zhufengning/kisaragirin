import type { APIRoute } from 'astro';
import { getQueue } from '@lib/queue';

export const GET: APIRoute = async () => {
    const queue = getQueue();
    const encoder = new TextEncoder();
    let interval: ReturnType<typeof setInterval>;

    const stream = new ReadableStream({
        start(controller) {
            const send = () => {
                try {
                    const status = queue.getStatus();
                    controller.enqueue(
                        encoder.encode(`data: ${JSON.stringify(status)}\n\n`)
                    );
                } catch {
                    clearInterval(interval);
                }
            };
            send();
            interval = setInterval(send, 600);
        },
        cancel() {
            clearInterval(interval);
        },
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        },
    });
};
