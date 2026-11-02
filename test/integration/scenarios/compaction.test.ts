import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, rmSync} from 'node:fs';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {runScenario} from '../runner/scenario-runner';
import {atSegment, nowSeconds, textSegment} from '../runner/messages';
import {waitFor} from '../runner/wait-for';
import type {ModelResponseRule} from '../fakes/openai-completions-server';

function replyRule (text: string): ModelResponseRule {
    return {
        action: {type: 'replyTool', params: {messages: [{text}], requires_deep_research: false}}
    };
}

function firstSessionText (path: string): string {
    const branch = SessionManager.open(path).getBranch();
    const first = branch[0];
    assert.ok(first?.type === 'message');
    assert.equal(first.message.role, 'user');
    const content = first.message.content;
    if (typeof content === 'string') return content;
    return content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');
}

test('上下文比例触发总体记忆压缩并在新会话及文件重建后注入', {timeout: 180000}, async () => {
    const longMemory = '群总体印象：这段总体记忆 deliberately 超过测试设置的二十字符上限';
    const memory = '群总体印象：技术交流群';
    await runScenario({
        name: 'compaction-overall-memory',
        groups: [1001],
        contextWindow: 150,
        compactContextRatio: 0.8,
        compactMaxChars: 20,
        channels: {
            primary: [
                replyRule('第一次回复'),
                {action: {type: 'text', text: longMemory}},
                {action: {type: 'text', text: memory}},
                replyRule('第二次回复'),
                {action: {type: 'text', text: memory}}
            ]
        }
    }, async env => {
        const initialMetadata = env.db.harnessMetadata(1001);
        assert.ok(initialMetadata);

        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('第一次消息')],
            time: nowSeconds()
        });
        await env.oneBot.waitForGroupSendCount(1001, 1);
        await waitFor(() => env.db.overallMemory(1001) === memory, {
            description: '生成符合字数上限的总体记忆',
            timeoutMs: 20000
        });

        assert.equal(env.openAI.requestCount(), 3, '回复、超长摘要与缩减摘要各调用一次');
        const compactionRequest = env.openAI.requests[1];
        assert.match(compactionRequest.serialized, /群总体印象/);
        assert.match(compactionRequest.serialized, /群内重要事件/);
        assert.match(compactionRequest.serialized, /群友印象/);
        assert.match(compactionRequest.serialized, /仍未结束的话题/);
        assert.match(compactionRequest.serialized, /长期记忆/);
        const reductionRequest = env.openAI.requests[2];
        assert.match(reductionRequest.serialized, /超过20字上限/);
        assert.match(reductionRequest.serialized, /deliberately/);

        const compactedMetadata = env.db.harnessMetadata(1001);
        assert.ok(compactedMetadata);
        assert.notEqual(compactedMetadata.path, initialMetadata.path);
        assert.notEqual(compactedMetadata.id, initialMetadata.id);
        assert.ok(existsSync(initialMetadata.path), '旧会话文件应保留');
        assert.match(firstSessionText(compactedMetadata.path), new RegExp(memory));
        assert.doesNotMatch(firstSessionText(compactedMetadata.path), /第一次消息/);

        await env.stopApp();
        rmSync(compactedMetadata.path);
        await env.restartApp();

        const restoredMetadata = env.db.harnessMetadata(1001);
        assert.ok(restoredMetadata);
        assert.notEqual(restoredMetadata.path, compactedMetadata.path);
        assert.match(firstSessionText(restoredMetadata.path), new RegExp(memory));

        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('第二次消息')],
            time: nowSeconds()
        });
        await env.oneBot.waitForGroupSendCount(1001, 2);
        const secondReplyRequest = env.openAI.requests[3];
        assert.match(secondReplyRequest.serialized, new RegExp(memory));
        assert.match(secondReplyRequest.serialized, /第二次消息/);
        assert.ok(secondReplyRequest.serialized.indexOf(memory) <
            secondReplyRequest.serialized.indexOf('第二次消息'), '总体记忆应位于新消息之前');

        await waitFor(() => {
            const current = env.db.harnessMetadata(1001);
            return current !== undefined && current.path !== restoredMetadata.path;
        }, {
            description: '第二次回复后再次按上下文比例更换会话',
            timeoutMs: 20000
        });
        assert.equal(env.openAI.requestCount(), 5);
        assert.equal(env.openAI.remainingRules('primary'), 0);
    });
});
