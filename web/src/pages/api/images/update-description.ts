import type { APIRoute } from 'astro';
import { db, schema } from '@lib/db';
import { eq } from 'drizzle-orm';

export const POST: APIRoute = async ({ request }) => {
    const form = await request.formData();
    const sha256 = form.get('sha256');
    const description = form.get('description');

    if (typeof sha256 !== 'string' || !sha256) {
        return new Response('Missing sha256', { status: 400 });
    }

    const value = typeof description === 'string' ? description.trim() : '';
    await db.update(schema.images)
        .set({ description: value || null })
        .where(eq(schema.images.sha256, sha256));

    return new Response(null, { status: 204 });
};
