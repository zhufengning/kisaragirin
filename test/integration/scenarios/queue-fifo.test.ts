import test from 'node:test';
import assert from 'node:assert/strict';
import {runScenario} from '../runner/scenario-runner';
import {atSegment, lastUserText, nowSeconds, textSegment} from '../runner/messages';
import {sleep} from '../runner/wait-for';
import type {ModelResponseRule} from '../fakes/openai-completions-server';

function replyRule (text: string, gate?: string): ModelResponseRule {
    return {
        action: {type: 'replyTool', params: {messages: [{text}], requires_deep_research: false}},
        ...(gate ? {gate} : {})
    };
}

test('每群回复FIFO执行，跨群可以并行', {timeout: 120000}, async () => {
    await runScenario({
        name: 'queue-fifo',
        groups: [1001, 1002],
        mergeWindowSeconds: 0.02,
        channels: {
            'primary/group-1001': [
                replyRule('A一回复', 'a-first'),
                replyRule('A二回复'),
                replyRule('A三回复')
            ],
            'primary/group-1002': [
                replyRule('B回复', 'b-gate')
            ]
        }
    }, async env => {
        const time = nowSeconds();
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('A一')],
            time
        });
        await env.openAI.waitForGate('a-first');

        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('A二')],
            time
        });
        await env.waitForGroupMessages(1001, 2);
        await sleep(60);
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('A三')],
            time
        });
        await env.waitForGroupMessages(1001, 3);
        await sleep(80);

        assert.equal(env.openAI.activeOnChannel('primary/group-1001'), 1,
            '群A同时只应有一个活跃模型请求');
        assert.equal(env.openAI.requestCount(), 1);

        env.oneBot.emitGroupMessage({
            groupId: 1002,
            segments: [atSegment(10000), textSegment('B一')],
            time
        });
        await env.openAI.waitForGate('b-gate');

        assert.equal(env.openAI.activeCount(), 2, '跨群模型请求应能并行');
        assert.equal(env.openAI.activeOnChannel('primary/group-1002'), 1);
        assert.equal(env.openAI.activeOnChannel('primary/group-1001'), 1);

        env.openAI.releaseGate('b-gate');
        await env.oneBot.waitForGroupSendCount(1002, 1);

        env.oneBot.gateNextSend('a-send');
        env.openAI.releaseGate('a-first');
        await env.oneBot.waitForGate('a-send');
        assert.equal(env.db.botMessages(1001).length, 0, '发送响应未返回前不应写入回复行');
        assert.equal(env.openAI.requestCount(), 2, '发送未完成时不应开始下一个任务');
        env.oneBot.releaseGate('a-send');
        await env.oneBot.waitForGroupSendCount(1001, 2);

        assert.equal(env.openAI.requestCount(), 3);
        const groupARequests = env.openAI.requests.filter(
            request => request.channel === 'primary/group-1001'
        );
        for (const request of groupARequests) {
            assert.ok(request.channelActiveAtStart <= 1,
                `群A同时活跃请求数不应超过 1，实际 ${request.channelActiveAtStart}`);
        }
        assert.match(lastUserText(groupARequests[1].body), /A二/);
        assert.match(lastUserText(groupARequests[1].body), /A三/);

        const sentA = env.oneBot.sentMessagesFor(1001);
        assert.deepEqual(sentA.map(item => item.message[item.message.length - 1]), [
            {type: 'text', data: {text: 'A一回复'}},
            {type: 'text', data: {text: 'A二回复'}}
        ]);
        const sentB = env.oneBot.sentMessagesFor(1002);
        assert.deepEqual(sentB.map(item => item.message[item.message.length - 1]), [
            {type: 'text', data: {text: 'B回复'}}
        ]);
    });
});
