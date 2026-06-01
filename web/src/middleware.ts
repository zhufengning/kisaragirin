import { defineMiddleware } from 'astro:middleware';

const USERNAME = process.env.WEB_USERNAME ?? '';
const PASSWORD = process.env.WEB_PASSWORD ?? '';
const EXPECTED = 'Basic ' + Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');

export const onRequest = defineMiddleware(async (context, next) => {
    const url = new URL(context.request.url);
    if (url.pathname.startsWith('/_astro/')) {
        return next();
    }
    const auth = context.request.headers.get('authorization');
    if (auth !== EXPECTED) {
        return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="Web Panel"' },
        });
    }
    return next();
});
