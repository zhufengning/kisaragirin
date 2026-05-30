import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { serve } from '@hono/node-server';
import { eq, desc, sql } from 'drizzle-orm';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, extname } from 'path';
import type { Db } from '../db';
import { schema } from '../db';
import type { StoredMessage } from '../message-format';
import { messagesToString } from '../message-format';
import type { DescQueue } from '../util/desc-queue';

export interface WebPanelConfig {
    host: string;
    port: number;
    username: string;
    password: string;
}

const IMAGE_DIR = './data/images';

function basicAuth(username: string, password: string) {
    const expected = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    return createMiddleware(async (c, next) => {
        const auth = c.req.header('authorization');
        if (auth !== expected) {
            c.header('WWW-Authenticate', 'Basic realm="Web Panel"');
            return c.text('Unauthorized', 401);
        }
        await next();
    });
}

function page(title: string, body: string): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:1200px;margin:40px auto;padding:0 16px;line-height:1.6;color:#333;background:#f8f9fa}
h1,h2{color:#1a1a1a;border-bottom:1px solid #ddd;padding-bottom:8px}
a{color:#0366d6;text-decoration:none}
a:hover{text-decoration:underline}
pre{background:#fff;border:1px solid #e1e4e8;border-radius:6px;padding:16px;overflow-x:auto;white-space:pre-wrap;word-wrap:break-word}
ul{list-style:none;padding:0}
li{background:#fff;border:1px solid #e1e4e8;border-radius:6px;margin:8px 0;padding:12px 16px}
li a{display:block}
.meta{color:#666;font-size:14px}
nav{background:#fff;border:1px solid #e1e4e8;border-radius:6px;padding:12px 16px;margin-bottom:20px;display:flex;gap:20px}
nav a{font-weight:500}
.btn{background:#d73a49;color:#fff;border:none;border-radius:6px;padding:8px 16px;cursor:pointer;font-size:14px}
.btn:hover{background:#b92534}
.btn-secondary{background:#6f42c1}
.btn-secondary:hover{background:#5a32a8}
.btn-sm{padding:4px 12px;font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}
.card{background:#fff;border:1px solid #e1e4e8;border-radius:6px;padding:12px;display:flex;flex-direction:column;gap:8px}
.card img{width:100%;height:160px;object-fit:cover;border-radius:4px;background:#f0f0f0}
.card .sha{font-family:monospace;font-size:12px;color:#666;word-break:break-all}
.card .desc{font-size:14px;color:#333;min-height:1.2em}
.card .desc-empty{color:#999;font-style:italic}
.toolbar{position:sticky;bottom:0;background:#fff;border-top:1px solid #ddd;padding:12px 16px;display:flex;gap:12px;align-items:center;justify-content:center;box-shadow:0 -2px 8px rgba(0,0,0,0.05)}
input[type=checkbox]{transform:scale(1.2)}
</style>
</head>
<body>${body}</body>
</html>`;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function extToMime(ext: string): string {
    const map: Record<string, string> = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.png': 'image/png', '.gif': 'image/gif',
        '.webp': 'image/webp', '.bmp': 'image/bmp',
        '.svg': 'image/svg+xml', '.bin': 'application/octet-stream',
    };
    return map[ext.toLowerCase()] || 'application/octet-stream';
}

function listImageFiles(): { name: string; sha256: string; ext: string }[] {
    if (!existsSync(IMAGE_DIR)) return [];
    return readdirSync(IMAGE_DIR)
        .filter(f => f.includes('.'))
        .map(name => {
            const ext = extname(name);
            const sha256 = name.slice(0, -ext.length);
            return { name, sha256, ext };
        });
}

export function createWebPanel(db: Db, config: WebPanelConfig, queue: DescQueue) {
    const app = new Hono();
    app.use(basicAuth(config.username, config.password));

    app.get('/', async c => {
        const rows = await db
            .select({
                groupId: schema.messages.groupId,
                count: sql<number>`count(*)`,
                lastTime: sql<number>`max(${schema.messages.time})`,
            })
            .from(schema.messages)
            .groupBy(schema.messages.groupId)
            .orderBy(desc(sql`max(${schema.messages.time})`));

        let list = '';
        for (const r of rows) {
            const d = new Date(r.lastTime * 1000);
            const ts = d.toLocaleString('zh-CN');
            list += `<li>
<a href="/group/${r.groupId}">
<strong>群 ${r.groupId}</strong>
<span class="meta"> — ${r.count} 条消息 · 最后更新 ${ts}</span>
</a>
</li>`;
        }

        const body = `
<nav><a href="/">📋 群消息</a><a href="/images">🖼️ 图片管理</a></nav>
<h1>📋 群消息浏览</h1>
<ul>${list || '<li>暂无消息</li>'}</ul>`;
        return c.html(page('群消息浏览', body));
    });

    app.get('/group/:id', async c => {
        const groupId = Number(c.req.param('id'));
        const rows = await db
            .select()
            .from(schema.messages)
            .where(eq(schema.messages.groupId, groupId))
            .orderBy(schema.messages.time);

        const storedMessages: StoredMessage[] = rows.map(r => ({
            time: r.time,
            messageId: r.messageId,
            senderId: r.userId,
            senderName: r.senderName,
            senderCard: r.senderCard ?? undefined,
            isBot: r.isBot,
            isAtBot: r.isAtBot,
            segments: r.segments as StoredMessage['segments'],
        }));

        const formatted = await messagesToString(
            storedMessages,
            (sha) => queue.resolve(sha)
        );
        const body = `
<nav><a href="/">📋 群消息</a><a href="/images">🖼️ 图片管理</a></nav>
<h1><a href="/">← 群列表</a></h1>
<h2>群 ${groupId} 的消息</h2>
<pre>${escapeHtml(formatted)}</pre>`;
        return c.html(page(`群 ${groupId} 消息`, body));
    });

    // 提供图片文件
    app.get('/images/file/:name', async c => {
        const name = c.req.param('name');
        const filePath = join(IMAGE_DIR, name);
        if (!existsSync(filePath)) return c.text('Not found', 404);
        const buf = readFileSync(filePath);
        const mime = extToMime(extname(name));
        c.header('Content-Type', mime);
        c.header('Cache-Control', 'public, max-age=86400');
        return c.body(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    });

    // 图片列表页
    app.get('/images', async c => {
        const files = listImageFiles();
        const descRows = await db.select().from(schema.images);
        const descMap = new Map(descRows.map(r => [r.sha256, r.description]));

        let cards = '';
        for (const f of files) {
            const desc = descMap.get(f.sha256);
            const descHtml = desc
                ? `<div class="desc">${escapeHtml(desc)}</div>`
                : '<div class="desc desc-empty">（无描述）</div>';
            cards += `
<div class="card">
<img src="/images/file/${f.name}" alt="${f.sha256}" loading="lazy">
<div class="sha">${escapeHtml(f.sha256)}</div>
${descHtml}
<label><input type="checkbox" name="sha256" value="${escapeHtml(f.sha256)}" form="batch-form"> 选择</label>
</div>`;
        }

        const body = `
<nav><a href="/">📋 群消息</a><a href="/images">🖼️ 图片管理</a></nav>
<h1>🖼️ 图片管理 <span class="meta">(${files.length} 张)</span></h1>
<form id="batch-form" method="POST" action="/images/delete-descriptions" style="margin-bottom:8px">
<div class="grid">${cards || '<p>暂无图片</p>'}</div>
<div class="toolbar">
<button type="submit" class="btn btn-sm">🗑️ 删除选中描述</button>
</div>
</form>
<form method="POST" action="/images/clear-all" style="text-align:center;margin-top:12px" onsubmit="return confirm('确定清空全部图片描述？')">
<button type="submit" class="btn btn-secondary btn-sm">⚠️ 全部清空描述</button>
</form>`;
        return c.html(page('图片管理', body));
    });

    // 批量删除描述
    app.post('/images/delete-descriptions', async c => {
        const body = await c.req.parseBody();
        let selected: string[] = [];
        const raw = body.sha256;
        if (raw) {
            selected = Array.isArray(raw) ? raw.map(String) : [String(raw)];
        }
        if (selected.length > 0) {
            for (const sha256 of selected) {
                await db.update(schema.images)
                    .set({ description: null })
                    .where(eq(schema.images.sha256, sha256));
            }
        }
        return c.html(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>操作结果</title>
<style>body{font-family:system-ui;max-width:600px;margin:60px auto;text-align:center}</style>
</head><body>
<h2>✅ 已删除 ${selected.length} 张图片的描述</h2>
<p><a href="/images">← 返回图片管理</a></p>
</body></html>`);
    });

    // 全部清空
    app.post('/images/clear-all', async c => {
        await db.update(schema.images).set({ description: null });
        return c.html(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>操作结果</title>
<style>body{font-family:system-ui;max-width:600px;margin:60px auto;text-align:center}</style>
</head><body>
<h2>✅ 已全部清空图片描述</h2>
<p><a href="/images">← 返回图片管理</a></p>
</body></html>`);
    });

    return {
        start() {
            serve({
                hostname: config.host,
                port: config.port,
                fetch: app.fetch,
            });
            console.log(`Web panel listening on http://${config.host}:${config.port}`);
        },
    };
}
