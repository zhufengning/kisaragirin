import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {runScenario} from '../runner/scenario-runner';
import {atSegment, lastUserText, nowSeconds, textSegment} from '../runner/messages';
import {sleep} from '../runner/wait-for';
import type {ModelResponseRule} from '../fakes/openai-completions-server';

function replyRule (text: string): ModelResponseRule {
    return {
        action: {type: 'replyTool', params: {messages: [{text}], requires_deep_research: false}}
    };
}

test('进程重启后恢复会话与触发边界，不重复回复旧消息', {timeout: 180000}, async () => {
    await runScenario({
        name: 'restart',
        groups: [1001],
        channels: {
            primary: [
                replyRule('第一次回复'),
                replyRule('第二次回复')
            ]
        }
    }, async env => {
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('第一次消息')],
            time: nowSeconds()
        });
        await env.oneBot.waitForGroupSendCount(1001, 1);
        await env.waitForLastTriggerId(1001, 1);
        await env.waitForGroupMessages(1001, 2);

        const metadataBefore = env.db.harnessMetadata(1001);
        assert.ok(metadataBefore);
        assert.equal(metadataBefore.id, 'group-1001');

        await env.stopApp();
        const requestCountAfterStop = env.openAI.requestCount();
        const sendCountAfterStop = env.oneBot.sentMessages.length;
        await sleep(1200);
        assert.equal(env.openAI.requestCount(), requestCountAfterStop);
        assert.equal(env.oneBot.sentMessages.length, sendCountAfterStop);

        await sleep(100);
        await env.restartApp();

        assert.equal(env.db.lastTriggerId(1001), 1, 'restart 后应恢复水位线');
        const metadataAfter = env.db.harnessMetadata(1001);
        assert.ok(metadataAfter);
        assert.equal(metadataAfter.id, metadataBefore.id, 'restart 后应打开已有 session');

        await env.expectNoActivity({windowMs: 1500, description: 'restart 不应导入历史或重复回复'});

        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('第二次消息')],
            time: nowSeconds()
        });
        await env.oneBot.waitForGroupSendCount(1001, 2);

        assert.equal(env.openAI.requestCount(), 2);
        assert.equal(env.openAI.remainingRules('primary'), 0, '两条响应规则应全部消费');
        const secondRequest = env.openAI.requests[1];
        const lastText = lastUserText(secondRequest.body);
        assert.match(lastText, /第二次消息/);
        assert.doesNotMatch(lastText, /第一次消息/);
        assert.match(secondRequest.serialized, /第一次回复/);

        const sessionPath = join(env.dir, 'data', 'harness', 'group-1001.jsonl');
        const sessionContent = readFileSync(sessionPath, 'utf-8');
        assert.match(sessionContent, /第一次回复/);
        assert.match(sessionContent, /第二次回复/);

        const sent = env.oneBot.sentMessagesFor(1001);
        assert.deepEqual(sent.map(item => item.message[item.message.length - 1]), [
            {type: 'text', data: {text: '第一次回复'}},
            {type: 'text', data: {text: '第二次回复'}}
        ]);
    });
});
