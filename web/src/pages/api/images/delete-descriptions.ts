import type { APIRoute } from 'astro';
import { db, schema } from '@lib/db';
import { eq } from 'drizzle-orm';

export const POST: APIRoute = async ({ request }) => {
    const form = await request.formData();
    const raw = form.getAll('sha256');
    const selected = raw.map(v => String(v));

    if (selected.length > 0) {
        for (const sha256 of selected) {
            await db.update(schema.images)
                .set({ description: null })
                .where(eq(schema.images.sha256, sha256));
        }
    }

    return new Response(null, {
        status: 302,
        headers: { Location: '/images' },
    });
};
