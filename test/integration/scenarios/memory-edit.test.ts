import test from 'node:test';
import assert from 'node:assert/strict';
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

function firstMessageText (path: string): string {
    const messages = SessionManager.open(path).buildSessionProjection().messages;
    const first = messages[0];
    assert.ok(first);
    assert.equal(first.role, 'user');
    const content = first.content;
    if (typeof content === 'string') return content;
    return content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');
}

test('编辑总体记忆后会话头部的总体记忆消息被替换', {timeout: 180000}, async () => {
    const memory = '旧总体记忆：技术交流群';
    const edited = '新总体记忆：编辑后的群印象';
    await runScenario({
        name: 'memory-edit',
        groups: [1001],
        contextWindow: 150,
        compactContextRatio: 0.8,
        channels: {
            primary: [
                replyRule('第一次回复'),
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
            description: '生成总体记忆',
            timeoutMs: 20000
        });
        await waitFor(() => {
            const current = env.db.harnessMetadata(1001);
            return current !== undefined && current.path !== initialMetadata.path;
        }, {
            description: '压缩后更换会话',
            timeoutMs: 20000
        });
        const compactedMetadata = env.db.harnessMetadata(1001);
        assert.ok(compactedMetadata);
        assert.match(firstMessageText(compactedMetadata.path), new RegExp(memory));

        await env.updateOverallMemory(1001, `  ${edited}  `);
        assert.equal(env.db.overallMemory(1001), edited, '编辑时去掉首尾空白');
        const editedHeader = firstMessageText(compactedMetadata.path);
        assert.match(editedHeader, new RegExp(edited));
        assert.doesNotMatch(editedHeader, /旧总体记忆/);

        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('第二次消息')],
            time: nowSeconds()
        });
        await env.oneBot.waitForGroupSendCount(1001, 2);
        const secondReplyRequest = env.openAI.requests[2];
        assert.match(secondReplyRequest.serialized, new RegExp(edited));
        assert.doesNotMatch(secondReplyRequest.serialized, /旧总体记忆/);
        assert.ok(secondReplyRequest.serialized.indexOf(edited) <
            secondReplyRequest.serialized.indexOf('第二次消息'), '编辑后的总体记忆应位于新消息之前');

        await waitFor(() => env.openAI.remainingRules('primary') === 0, {
            description: '第二次回复后再次按上下文比例压缩',
            timeoutMs: 20000
        });
        assert.equal(env.openAI.requestCount(), 4);
    });
});
