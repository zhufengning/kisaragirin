import test from 'node:test';
import assert from 'node:assert/strict';
import {runScenario} from '../runner/scenario-runner';
import {atSegment, lastUserText, nowSeconds, textSegment} from '../runner/messages';
import {sleep} from '../runner/wait-for';
import type {ModelResponseRule, ReplyToolParams} from '../fakes/openai-completions-server';

function replyAction (text: string, gate?: string): ModelResponseRule {
    const params: ReplyToolParams = {messages: [{text}], requires_deep_research: false};
    return {
        action: {type: 'replyTool', params},
        ...(gate ? {gate} : {})
    };
}

test('新消息重新计算沉默定时器，多条消息只触发一次闲时回复', {timeout: 120000}, async () => {
    await runScenario({
        name: 'silence-reset',
        groups: [1001],
        silenceWaitTimeMinutes: 0.01,
        replyProbability: 1,
        channels: {primary: [replyAction('闲时回复')]}
    }, async env => {
        const time = nowSeconds();
        env.oneBot.emitGroupMessage({groupId: 1001, segments: [textSegment('沉默消息一')], time});
        await sleep(200);
        env.oneBot.emitGroupMessage({groupId: 1001, segments: [textSegment('沉默消息二')], time});
        await sleep(200);
        env.oneBot.emitGroupMessage({groupId: 1001, segments: [textSegment('沉默消息三')], time});

        await env.oneBot.waitForGroupSendCount(1001, 1);
        await env.waitForGroupMessages(1001, 4);
        await env.expectNoActivity({windowMs: 900, description: '闲时任务只应触发一次'});

        assert.equal(env.openAI.requestCount(), 1);
        const text = lastUserText(env.openAI.requests[0].body);
        assert.match(text, /沉默消息一/);
        assert.match(text, /沉默消息二/);
        assert.match(text, /沉默消息三/);

        const sent = env.oneBot.sentMessagesFor(1001);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].message[0].type, 'text');
    });
});

test('bot回复取消沉默定时器，bot消息不启动新定时器', {timeout: 120000}, async () => {
    await runScenario({
        name: 'silence-bot-cancel',
        groups: [1001],
        silenceWaitTimeMinutes: 0.008,
        replyProbability: 1,
        channels: {primary: [replyAction('@回复')]}
    }, async env => {
        const time = nowSeconds();
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('触发回复')],
            time
        });
        await env.oneBot.waitForGroupSendCount(1001, 1);
        await env.waitForGroupMessages(1001, 2);

        await env.expectNoActivity({windowMs: 1200, description: 'bot 回复后不应再触发闲时回复'});
        assert.equal(env.openAI.requestCount(), 1);
        assert.equal(env.db.botMessages(1001).length, 1);
    });
});

test('reply_probability 为 0 时不触发闲时回复', {timeout: 120000}, async () => {
    await runScenario({
        name: 'silence-probability-zero',
        groups: [1001],
        silenceWaitTimeMinutes: 0.008,
        replyProbability: 0,
        channels: {}
    }, async env => {
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [textSegment('不会触发')],
            time: nowSeconds()
        });
        await env.waitForGroupMessages(1001, 1);
        await env.expectNoActivity({windowMs: 1200, description: '概率为 0 时不应触发'});
        assert.equal(env.openAI.requestCount(), 0);
    });
});

test('正在回复时到期的闲时检查被跳过', {timeout: 120000}, async () => {
    await runScenario({
        name: 'silence-replying',
        groups: [1001],
        silenceWaitTimeMinutes: 0.008,
        replyProbability: 1,
        channels: {primary: [replyAction('@回复', 'reply-gate')]}
    }, async env => {
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('触发回复')],
            time: nowSeconds()
        });
        await env.openAI.waitForGate('reply-gate');

        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [textSegment('回复期间的沉默消息')],
            time: nowSeconds()
        });
        await env.waitForGroupMessages(1001, 2);
        await sleep(900);

        env.openAI.releaseGate('reply-gate');
        await env.oneBot.waitForGroupSendCount(1001, 1);
        await env.waitForGroupMessages(1001, 3);
        await env.expectNoActivity({windowMs: 1200, description: '回复期间到期的闲时检查应被跳过'});

        assert.equal(env.openAI.requestCount(), 1);
    });
});

test('最近窗口内bot消息达到阈值时延长闲时等待时间', {timeout: 120000}, async () => {
    await runScenario({
        name: 'silence-bot-window',
        groups: [1001],
        silenceWaitTimeMinutes: 0.005,
        replyProbability: 1,
        silenceRecentWindow: 2,
        silenceRecentBotThreshold: 1,
        silenceRecentBotMultiplier: 3,
        channels: {
            primary: [
                replyAction('@回复'),
                replyAction('延长后的闲时回复')
            ]
        }
    }, async env => {
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('预热消息')],
            time: nowSeconds()
        });
        await env.oneBot.waitForGroupSendCount(1001, 1);
        await env.waitForGroupMessages(1001, 2);

        const emittedAt = Date.now();
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [textSegment('窗口内有bot消息')],
            time: nowSeconds()
        });
        await env.waitForGroupMessages(1001, 3);

        await sleep(500);
        assert.equal(env.openAI.requestCount(), 1, '等待时间应被放大到 900ms 以上');

        await env.openAI.waitForRequestCount(2, 3000);
        const delay = env.openAI.requests[1].startedAt - emittedAt;
        assert.ok(delay >= 700, `闲时等待时间应被延长，实际 ${delay}ms`);
    });
});

test('新消息改变窗口构成后下一次定时器使用新的倍率', {timeout: 120000}, async () => {
    await runScenario({
        name: 'silence-window-shift',
        groups: [1001],
        silenceWaitTimeMinutes: 0.005,
        replyProbability: 1,
        silenceRecentWindow: 2,
        silenceRecentBotThreshold: 1,
        silenceRecentBotMultiplier: 3,
        channels: {
            primary: [
                replyAction('@回复'),
                replyAction('新的闲时回复')
            ]
        }
    }, async env => {
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('预热消息')],
            time: nowSeconds()
        });
        await env.oneBot.waitForGroupSendCount(1001, 1);
        await env.waitForGroupMessages(1001, 2);

        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [textSegment('第一条沉默消息')],
            time: nowSeconds()
        });
        await env.waitForGroupMessages(1001, 3);
        await sleep(200);
        const emittedAt = Date.now();
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [textSegment('第二条沉默消息')],
            time: nowSeconds()
        });
        await env.waitForGroupMessages(1001, 4);

        await env.openAI.waitForRequestCount(2, 2000);
        const delay = env.openAI.requests[1].startedAt - emittedAt;
        assert.ok(delay < 700, `窗口构成改变后应使用 1 倍等待时间，实际 ${delay}ms`);
    });
});
