import test from 'node:test';
import assert from 'node:assert/strict';
import {runScenario} from '../runner/scenario-runner';
import {atSegment, lastUserText, nowSeconds, textSegment} from '../runner/messages';
import {waitFor} from '../runner/wait-for';
import type {ModelResponseRule} from '../fakes/openai-completions-server';

function replyRule (text: string, gate?: string): ModelResponseRule {
    return {
        action: {type: 'replyTool', params: {messages: [{text}], requires_deep_research: false}},
        ...(gate ? {gate} : {})
    };
}

test('水位线只推进到实际读入边界，乱序消息带时序提示', {timeout: 150000}, async () => {
    await runScenario({
        name: 'watermark',
        groups: [1001],
        mergeWindowSeconds: 0.02,
        channels: {
            primary: [
                replyRule('A回复', 'a-gate'),
                replyRule('B回复', 'b-gate')
            ]
        },
        graphiti: {}
    }, async env => {
        const time = nowSeconds();
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('消息A')],
            time
        });
        await env.openAI.waitForGate('a-gate');

        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('消息B')],
            time
        });
        await env.waitForGroupMessages(1001, 2);

        env.openAI.releaseGate('a-gate');
        await env.openAI.waitForGate('b-gate');

        const messages = env.db.messages(1001);
        const messageA = messages[0];
        const messageB = messages[1];
        const replyRow = messages[2];
        assert.equal(replyRow.isBot, true);
        assert.ok(replyRow.id > messageB.id);

        assert.equal(env.db.lastTriggerId(1001), messageA.id,
            '水位线应停留在消息A的读入边界，而不是bot回复行');

        const secondRequestText = lastUserText(env.openAI.requests[1].body);
        assert.match(secondRequestText, /时序提示/);
        assert.match(secondRequestText, new RegExp(`#${messageB.id}`));

        env.openAI.releaseGate('b-gate');
        await env.oneBot.waitForGroupSendCount(1001, 2);
        await env.waitForLastTriggerId(1001, messageB.id);

        assert.equal(env.openAI.requestCount(), 2);
        const sent = env.oneBot.sentMessagesFor(1001);
        assert.deepEqual(sent.map(item => item.message[item.message.length - 1]), [
            {type: 'text', data: {text: 'A回复'}},
            {type: 'text', data: {text: 'B回复'}}
        ]);

        await env.waitForGraphitiCall('add_episode', call =>
            String(call.params.name).startsWith('group_merged_')
        );
        await waitFor(() => env.graphitiCalls().filter(call =>
            call.phase === 'start' && call.method === 'add_episode' &&
            String(call.params.name).startsWith('group_merged_')
        ).length >= 2, {description: '两次合并消息 episode 写入'});

        const mergedEpisodes = env.graphitiCalls().filter(call =>
            call.phase === 'start' && call.method === 'add_episode' &&
            String(call.params.name).startsWith('group_merged_')
        );
        const contentFor = (needle: string): string => {
            const call = mergedEpisodes.find(entry => String(entry.params.content).includes(needle));
            assert.ok(call, `未找到包含 ${needle} 的合并 episode`);
            return String(call.params.content);
        };

        const mergedA = contentFor('消息A');
        const mergedB = contentFor('消息B');
        assert.match(mergedA, /消息A/);
        assert.doesNotMatch(mergedB, /时序提示/);
        assert.doesNotMatch(mergedB, /记忆自动检索/);
    });
});
