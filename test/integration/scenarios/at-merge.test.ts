import test from 'node:test';
import assert from 'node:assert/strict';
import {runScenario} from '../runner/scenario-runner';
import {atSegment, lastUserText, nowSeconds, textSegment} from '../runner/messages';
import type {ReplyToolParams} from '../fakes/openai-completions-server';

function replyAction (text: string): {type: 'replyTool'; params: ReplyToolParams} {
    return {
        type: 'replyTool',
        params: {messages: [{text}], requires_deep_research: false}
    };
}

test('合并窗口内的多条消息合并为一次回复', {timeout: 60000}, async () => {
    await runScenario({
        name: 'at-merge-window',
        groups: [1001],
        mergeWindowSeconds: 0.03,
        channels: {primary: [{action: replyAction('合并回复')}]}
    }, async env => {
        const time = nowSeconds();
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('第一条')],
            time
        });
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [textSegment('第二条')],
            time
        });
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [textSegment('第三条')],
            time
        });

        await env.oneBot.waitForGroupSendCount(1001, 1);
        await env.expectNoActivity({windowMs: 300, description: '合并窗口结束后不应再触发'});

        assert.equal(env.openAI.requestCount(), 1);
        assert.equal(env.openAI.remainingRules('primary'), 0, '所有响应规则应已被消费');
        const request = env.openAI.requests[0];
        assert.match(request.serialized, /第一条/);
        assert.match(request.serialized, /第二条/);
        assert.match(request.serialized, /第三条/);

        const sent = env.oneBot.sentMessagesFor(1001);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].message[0].type, 'reply');
        assert.deepEqual(sent[0].message[1], {type: 'text', data: {text: '合并回复'}});

        const messages = env.db.messages(1001);
        assert.deepEqual(messages.map(row => row.id), [1, 2, 3, 4]);
        assert.equal(messages[3].isBot, true);
        assert.equal(env.db.lastTriggerId(1001), 3);
    });
});

test('窗口内出现新@消息时立即触发等待中的旧@任务', {timeout: 60000}, async () => {
    await runScenario({
        name: 'at-merge-immediate',
        groups: [1001],
        mergeWindowSeconds: 2.5,
        channels: {
            primary: [
                {action: replyAction('旧任务回复')},
                {action: replyAction('新任务回复')}
            ]
        }
    }, async env => {
        const time = nowSeconds();
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('旧消息')],
            time
        });

        const emittedAt = Date.now();
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('新消息')],
            time
        });

        await env.openAI.waitForRequestCount(1);
        const firstRequestDelay = Date.now() - emittedAt;
        assert.ok(firstRequestDelay < 2000,
            `旧任务应在合并窗口到期前触发，实际等待 ${firstRequestDelay}ms`);
        assert.match(lastUserText(env.openAI.requests[0].body), /旧消息/);

        await env.oneBot.waitForGroupSendCount(1001, 1);
        await env.waitForGroupMessages(1001, 3);
        await env.expectNoActivity({windowMs: 3000, description: '新@消息已被首个任务吸收'});
        assert.equal(env.openAI.requestCount(), 1);
        assert.equal(env.db.lastTriggerId(1001), 2);
    });
});

test('窗口之后的消息进入后续任务', {timeout: 60000}, async () => {
    await runScenario({
        name: 'at-merge-followup',
        groups: [1001],
        mergeWindowSeconds: 0.02,
        channels: {
            primary: [
                {action: replyAction('第一次回复')},
                {action: replyAction('第二次回复')}
            ]
        }
    }, async env => {
        const time = nowSeconds();
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('第一次@')],
            time
        });
        await env.oneBot.waitForGroupSendCount(1001, 1);

        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('第二次@')],
            time
        });
        await env.oneBot.waitForGroupSendCount(1001, 2);

        assert.equal(env.openAI.requestCount(), 2);
        assert.match(lastUserText(env.openAI.requests[1].body), /第二次@/);
        assert.doesNotMatch(lastUserText(env.openAI.requests[1].body), /第一次@/);

        const sent = env.oneBot.sentMessagesFor(1001);
        assert.deepEqual(sent[1].message[1], {type: 'text', data: {text: '第二次回复'}});
    });
});

test('前序任务吸收后续触发消息时后续任务静默结束', {timeout: 60000}, async () => {
    await runScenario({
        name: 'at-merge-noop',
        groups: [1001],
        mergeWindowSeconds: 0.02,
        channels: {
            primary: [
                {action: replyAction('首任务回复'), gate: 'first-reply'},
                {action: replyAction('次任务回复')}
            ]
        }
    }, async env => {
        const time = nowSeconds();
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('任务一')],
            time
        });
        await env.openAI.waitForGate('first-reply');

        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('任务二')],
            time
        });
        await env.waitForGroupMessages(1001, 2);

        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('任务三')],
            time
        });
        await env.waitForGroupMessages(1001, 3);
        await new Promise(resolve => setTimeout(resolve, 100));

        env.openAI.releaseGate('first-reply');
        await env.oneBot.waitForGroupSendCount(1001, 2);
        await env.waitForGroupMessages(1001, 5);
        await env.expectNoActivity({windowMs: 600, description: '第三个任务应静默结束'});

        assert.equal(env.openAI.requestCount(), 2);
        assert.match(lastUserText(env.openAI.requests[1].body), /任务二/);
        assert.match(lastUserText(env.openAI.requests[1].body), /任务三/);

        const sent = env.oneBot.sentMessagesFor(1001);
        assert.equal(sent.length, 2);
        assert.equal(env.db.lastTriggerId(1001), 3);
        for (const message of sent) {
            assert.notDeepEqual(message.message[1], {type: 'text', data: {text: '@响应失败'}});
        }
    });
});
