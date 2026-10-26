import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {runScenario} from '../runner/scenario-runner';
import {imageSegment, nowSeconds, textSegment} from '../runner/messages';
import {waitFor} from '../runner/wait-for';
import {fixtureBytes} from '../fakes/asset-server';

const visionRule = [{action: {type: 'text' as const, text: '一张测试图片'}}];

test('同群图片消息与随后的文本消息按到达顺序入库', {timeout: 90000}, async () => {
    await runScenario({
        name: 'ingress-order-image',
        groups: [1001, 1002],
        channels: {vision: visionRule}
    }, async env => {
        const url = env.assets.serveFixture('image-a.png', {delayMs: 400});
        const time = nowSeconds();
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [imageSegment(url), textSegment('图片消息')],
            time
        });
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [textSegment('文字消息')],
            time
        });
        env.oneBot.emitGroupMessage({
            groupId: 1002,
            segments: [textSegment('其它群消息')],
            time
        });

        await env.waitForGroupMessages(1002, 1);
        assert.equal(env.db.messages(1001).length, 0,
            '群1001的图片下载不应阻塞其它群消息入库');

        await env.waitForGroupMessages(1001, 2);
        const rows = env.db.messages(1001);
        assert.deepEqual(rows.map(row => row.id), [2, 3]);
        assert.equal(rows[0].id < rows[1].id, true);
        assert.match(JSON.stringify(rows[0].segments), /"type":"image"/);
        assert.match(JSON.stringify(rows[1].segments), /文字消息/);

        const sha256 = createHash('sha256').update(fixtureBytes('image-a.png'))
            .digest('hex');
        assert.deepEqual(rows[0].segments[0], {type: 'image', sha256});
        assert.equal(env.db.imageCount(), 1);
        assert.equal(env.assets.requestCount('image-a.png'), 1);
        await waitFor(() => env.db.imageDescription(sha256) !== undefined, {
            description: '图片描述写入数据库'
        });
        assert.equal(env.openAI.requestCount(), 1);
        assert.equal(env.openAI.requests[0].model, 'vision');
    });
});

test('引用消息与合并转发嵌套解析时的入库顺序', {timeout: 90000}, async () => {
    await runScenario({
        name: 'ingress-order-nested',
        groups: [1001]
    }, async env => {
        const time = nowSeconds();
        env.oneBot.registerMessage({
            messageId: 501,
            groupId: 1001,
            time,
            sender: {user_id: 1002, nickname: '群友乙'},
            message: [textSegment('被引用的消息')],
            delayMs: 300
        });
        env.oneBot.registerMessage({
            messageId: 601,
            groupId: 1001,
            time,
            sender: {user_id: 1002, nickname: '群友乙'},
            message: [textSegment('转发内容')],
            delayMs: 300
        });

        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [{type: 'reply', data: {id: 501}}, textSegment('引用回复')],
            time
        });
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [{type: 'forward', data: {id: 601}}],
            time
        });
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [textSegment('最后一条')],
            time
        });

        await env.waitForGroupMessages(1001, 3);
        const rows = env.db.messages(1001);
        assert.deepEqual(rows.map(row => row.id), [1, 2, 3]);

        const replySegmentData = rows[0].segments[0] as {
            type: string;
            id: number;
            message?: {segments: Array<{type: string; text?: string}>};
        };
        assert.equal(replySegmentData.type, 'reply');
        assert.equal(replySegmentData.id, 501);
        assert.equal(replySegmentData.message?.segments[0].text, '被引用的消息');

        const forwardSegmentData = rows[1].segments[0] as {
            type: string;
            id: number;
            messages?: Array<{segments: Array<{type: string; text?: string}>}>;
        };
        assert.equal(forwardSegmentData.type, 'forward');
        assert.equal(forwardSegmentData.messages?.[0].segments[0].text, '转发内容');

        assert.equal(env.openAI.requestCount(), 0);
    });
});

test('引用与转发 API 失败时仍按到达顺序入库', {timeout: 90000}, async () => {
    await runScenario({
        name: 'ingress-order-nested-failure',
        groups: [1001]
    }, async env => {
        env.oneBot.setFailure('get_msg', {status: 'failed', retcode: 1404, message: 'not found'});
        env.oneBot.setFailure('get_forward_msg', {status: 'failed', retcode: 1404, message: 'not found'});

        const time = nowSeconds();
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [{type: 'reply', data: {id: 7001}}, textSegment('引用失败的消息')],
            time
        });
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [{type: 'forward', data: {id: 8001}}],
            time
        });
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [textSegment('失败后的消息')],
            time
        });

        await env.waitForGroupMessages(1001, 3);
        const rows = env.db.messages(1001);
        assert.deepEqual(rows.map(row => row.id), [1, 2, 3]);

        const replySegmentData = rows[0].segments[0];
        assert.equal(replySegmentData.type, 'reply');
        assert.equal(replySegmentData.id, 7001);
        assert.equal('message' in replySegmentData, false, 'API 失败时不保存嵌套引用消息');

        const forwardSegmentData = rows[1].segments[0];
        assert.equal(forwardSegmentData.type, 'forward');
        assert.equal('messages' in forwardSegmentData, false, 'API 失败时不保存嵌套转发消息');

        assert.equal(rows[2].segments[0].text, '失败后的消息');
        assert.equal(env.openAI.requestCount(), 0);
    });
});
