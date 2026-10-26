import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {createModels} from '@earendil-works/pi-ai';
import {eq} from 'drizzle-orm';
import {createDb, closeDb, runMigrations, schema, type Db} from '../../../src/db';
import {DescQueue} from '../../../src/util/desc-queue';
import {downloadAndStoreImage} from '../../../src/util/image-store';
import {registerCustomProviders} from '../../../src/util/models-factory';
import {ScenarioArtifacts} from '../runner/artifacts';
import {FakeAssetServer} from '../fakes/asset-server';
import {FakeOpenAIServer, type ModelResponseRule} from '../fakes/openai-completions-server';
import {createTestConfig, type TestConfigOverrides} from '../app/create-test-config';
import {waitFor} from '../runner/wait-for';

const originalCwd = process.cwd();

after(() => {
    process.chdir(originalCwd);
});

interface QueueTestEnvironment {
    artifacts: ScenarioArtifacts;
    assets: FakeAssetServer;
    openAI: FakeOpenAIServer;
    db: Db;
    queue: DescQueue;
    close: () => Promise<void>;
}

async function createQueueEnvironment (
    name: string,
    channels: Record<string, ModelResponseRule[]>,
    overrides: TestConfigOverrides & {describeTimeoutMs?: number; abortSettleGraceMs?: number} = {}
): Promise<QueueTestEnvironment> {
    const artifacts = new ScenarioArtifacts(name);
    process.chdir(artifacts.dir);
    const assets = await FakeAssetServer.start();
    const openAI = await FakeOpenAIServer.start(artifacts, channels);

    const config = createTestConfig({
        onebotHost: '127.0.0.1',
        onebotPort: 1,
        openAiBaseUrl: openAI.baseUrl,
        groups: [1001],
        logFile: artifacts.path('app.log'),
        logLevel: 'warn',
        ...overrides
    });
    const models = createModels();
    registerCustomProviders(models, config);

    const db = createDb(artifacts.path('messages.db'));
    await runMigrations(db);
    const queue = new DescQueue({
        db,
        config,
        models,
        describeTimeoutMs: overrides.describeTimeoutMs,
        abortSettleGraceMs: overrides.abortSettleGraceMs
    });
    queue.start();

    return {
        artifacts,
        assets,
        openAI,
        db,
        queue,
        close: async () => {
            await queue.stop();
            closeDb(db);
            await openAI.close();
            await assets.close();
            process.chdir(originalCwd);
            artifacts.discard();
        }
    };
}

async function downloadFixture (
    env: QueueTestEnvironment,
    fixtureName: string,
    options: {delayMs?: number} = {}
): Promise<string> {
    const url = env.assets.serveFixture(fixtureName, options);
    const stored = await downloadAndStoreImage(url);
    return stored.sha256;
}

async function generatePng (color: {r: number; g: number; b: number}): Promise<Buffer> {
    return sharp({create: {width: 8, height: 8, channels: 3, background: color}})
        .png()
        .toBuffer();
}

async function descriptionOf (db: Db, sha256: string): Promise<string | undefined> {
    const rows = await db.select()
        .from(schema.images)
        .where(eq(schema.images.sha256, sha256));
    return rows[0]?.description ?? undefined;
}

test('相同图片只产生一次描述请求，所有等待者获得同一结果', {timeout: 60000}, async () => {
    const env = await createQueueEnvironment('desc-queue-dedup', {
        vision: [{action: {type: 'text', text: '统一的图片描述'}}]
    });
    try {
        const sha256 = await downloadFixture(env, 'image-a.png');
        const results = await Promise.all([
            env.queue.resolve(sha256),
            env.queue.resolve(sha256),
            env.queue.resolve(sha256)
        ]);

        assert.deepEqual(results, ['统一的图片描述', '统一的图片描述', '统一的图片描述']);
        assert.equal(env.openAI.requestCount(), 1);
        assert.equal(await descriptionOf(env.db, sha256), '统一的图片描述');

        const again = await env.queue.resolve(sha256);
        assert.equal(again, '统一的图片描述');
        assert.equal(env.openAI.requestCount(), 1, '已保存的描述不应再次请求模型');
    } finally {
        await env.close();
    }
});

test('worker并发数不超过vision_concurrency，不同图片可以并行', {timeout: 60000}, async () => {
    const env = await createQueueEnvironment('desc-queue-concurrency', {
        vision: [
            {action: {type: 'text', text: '描述一'}, gate: 'g1'},
            {action: {type: 'text', text: '描述二'}, gate: 'g2'},
            {action: {type: 'text', text: '描述三'}, gate: 'g3'}
        ]
    }, {visionConcurrency: 2});
    try {
        const shas: string[] = [];
        const colors = [{r: 200, g: 10, b: 10}, {r: 10, g: 200, b: 10}, {r: 10, g: 10, b: 200}];
        for (let index = 0; index < colors.length; index++) {
            const name = `generated-${index}.png`;
            env.assets.register(name, await generatePng(colors[index]), {contentType: 'image/png'});
            const stored = await downloadAndStoreImage(`${env.assets.baseUrl}/assets/${name}`);
            shas.push(stored.sha256);
        }

        const pending = shas.map(sha => env.queue.resolve(sha));
        await env.openAI.waitForRequestCount(2);
        await waitFor(() => env.openAI.activeCount() === 2, {
            description: '两个 vision 请求应并行执行'
        });
        assert.equal(env.openAI.activeCount(), 2);
        assert.ok(env.queue.getStatus().processing <= 2);

        env.openAI.releaseGate('g1');
        await env.openAI.waitForRequestCount(3);
        assert.ok(env.openAI.activeCount() <= 2);

        env.openAI.releaseGate('g2');
        env.openAI.releaseGate('g3');
        const results = await Promise.all(pending);
        assert.equal(results.filter(result => result !== undefined).length, 3);
        assert.equal(env.openAI.requestCount(), 3);
        assert.equal(env.openAI.activeCount(), 0);
    } finally {
        await env.close();
    }
});

test('动图按vision_max_frames抽帧并交给模型', {timeout: 60000}, async () => {
    const env = await createQueueEnvironment('desc-queue-animation', {
        vision: [{action: {type: 'text', text: '动图描述'}}]
    }, {visionMaxFrames: 2});
    try {
        const sha256 = await downloadFixture(env, 'animated.gif');
        const result = await env.queue.resolve(sha256);
        assert.equal(result, '动图描述');
        assert.equal(env.openAI.requestCount(), 1);

        const body = env.openAI.requests[0].body as {
            messages: Array<{role: string; content: Array<{type: string; text?: string}>}>;
        };
        const userMessage = body.messages.find(message => message.role === 'user');
        assert.ok(userMessage);
        const images = userMessage.content.filter(block => block.type === 'image_url');
        assert.equal(images.length, 2);
        const text = userMessage.content
            .filter(block => block.type === 'text')
            .map(block => block.text ?? '')
            .join('');
        assert.match(text, /动图/);
        assert.match(text, /共 5 帧/);
    } finally {
        await env.close();
    }
});

test('超时中止后等待者收到结束通知，队列继续处理后续图片', {timeout: 60000}, async () => {
    const env = await createQueueEnvironment('desc-queue-timeout', {
        vision: [
            {action: {type: 'hang'}},
            {action: {type: 'hang'}},
            {action: {type: 'hang'}},
            {action: {type: 'text', text: '后续图片描述'}}
        ]
    }, {describeTimeoutMs: 150, abortSettleGraceMs: 100});
    try {
        const stuckSha = await downloadFixture(env, 'image-a.png');
        const nextSha = await downloadFixture(env, 'image-b.png');

        const stuckResult = await env.queue.resolve(stuckSha);
        assert.equal(stuckResult, undefined);
        assert.equal(await descriptionOf(env.db, stuckSha), undefined);

        const nextResult = await env.queue.resolve(nextSha);
        assert.equal(nextResult, '后续图片描述');
        await waitFor(() => env.openAI.activeCount() === 0, {
            description: '中止后的请求应全部结束'
        });
    } finally {
        await env.close();
    }
});

test('首选视觉模型失败后按回退链切换模型', {timeout: 60000}, async () => {
    const env = await createQueueEnvironment('desc-queue-fallback', {
        'vision-bad': [
            {action: {type: 'httpError', status: 400, body: {error: {message: 'bad request'}}}}
        ],
        'vision': [{action: {type: 'text', text: '回退模型描述'}}]
    }, {vision: ['vision-bad', 'vision']});
    try {
        const sha256 = await downloadFixture(env, 'image-a.png');
        const result = await env.queue.resolve(sha256);
        assert.equal(result, '回退模型描述');
        assert.deepEqual(env.openAI.requests.map(request => request.model), ['vision-bad', 'vision']);
        assert.equal(await descriptionOf(env.db, sha256), '回退模型描述');
    } finally {
        await env.close();
    }
});

test('停止队列后没有遗留等待者或活跃请求', {timeout: 60000}, async () => {
    const env = await createQueueEnvironment('desc-queue-stop', {
        vision: [{action: {type: 'hang'}}]
    });
    const sha256 = await downloadFixture(env, 'image-a.png');
    const pending = env.queue.resolve(sha256);
    await env.openAI.waitForRequestCount(1);

    await env.queue.stop();
    const result = await pending;
    assert.equal(result, undefined);
    assert.equal(env.queue.getStatus().pending, 0);
    assert.equal(env.queue.getStatus().processing, 0);
    await waitFor(() => env.openAI.activeCount() === 0, {
        description: '停止后不应有活跃请求'
    });
    await env.close();
});
