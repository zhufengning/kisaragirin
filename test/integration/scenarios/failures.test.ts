import test from 'node:test';
import assert from 'node:assert/strict';
import {runScenario} from '../runner/scenario-runner';
import {atSegment, lastUserText, nowSeconds, textSegment} from '../runner/messages';
import type {ModelResponseRule} from '../fakes/openai-completions-server';

function errorRule (): ModelResponseRule {
    return {action: {type: 'httpError', status: 400, body: {error: {message: 'bad request'}}}};
}

function replyRule (text: string): ModelResponseRule {
    return {
        action: {type: 'replyTool', params: {messages: [{text}], requires_deep_research: false}}
    };
}

const REMINDER_TEXT = /未检测到有效reply工具调用/;
const ERROR_REMINDER_TEXT = /服务端出现未知错误/;

test('首选模型400后立即回退到回退链下一个模型且不消耗reminder', {timeout: 120000}, async () => {
    await runScenario({
        name: 'failures-fallback',
        groups: [1001],
        agentHarness: ['primary', 'secondary'],
        channels: {
            primary: [errorRule()],
            secondary: [replyRule('回退回复')]
        }
    }, async env => {
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('触发回退')],
            time: nowSeconds()
        });
        await env.oneBot.waitForGroupSendCount(1001, 1);

        assert.equal(env.openAI.requestCount(), 2);
        assert.equal(env.openAI.requests[0].model, 'primary');
        assert.equal(env.openAI.requests[1].model, 'secondary');

        const retryText = lastUserText(env.openAI.requests[1].body);
        assert.match(retryText, /触发回退/);
        assert.doesNotMatch(retryText, REMINDER_TEXT);
        assert.doesNotMatch(retryText, ERROR_REMINDER_TEXT);

        const sent = env.oneBot.sentMessagesFor(1001);
        assert.deepEqual(sent[0].message[1], {type: 'text', data: {text: '回退回复'}});
    });
});

test('回退链耗尽后最多重试两次reminder，@触发最终发送兜底', {timeout: 150000}, async () => {
    await runScenario({
        name: 'failures-reminder-exhausted',
        groups: [1001],
        agentHarness: ['primary', 'secondary'],
        channels: {
            primary: [errorRule(), errorRule(), errorRule()],
            secondary: [errorRule(), errorRule(), errorRule()]
        }
    }, async env => {
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('回退链耗尽')],
            time: nowSeconds()
        });
        await env.oneBot.waitForGroupSendCount(1001, 1);
        await env.openAI.waitForRequestCount(4);

        assert.deepEqual(env.openAI.requests.map(request => request.model), [
            'primary', 'secondary', 'secondary', 'secondary'
        ]);
        assert.doesNotMatch(lastUserText(env.openAI.requests[1].body), ERROR_REMINDER_TEXT);
        assert.match(lastUserText(env.openAI.requests[2].body), ERROR_REMINDER_TEXT);
        assert.match(lastUserText(env.openAI.requests[3].body), ERROR_REMINDER_TEXT);

        const sent = env.oneBot.sentMessagesFor(1001);
        assert.equal(sent.length, 1);
        assert.deepEqual(sent[0].message, [{type: 'text', data: {text: '@响应失败'}}]);
    });
});

test('闲时触发失败时静默处理', {timeout: 150000}, async () => {
    await runScenario({
        name: 'failures-silence-silent',
        groups: [1001],
        silenceWaitTimeMinutes: 0.008,
        replyProbability: 1,
        channels: {
            primary: [errorRule(), errorRule(), errorRule()]
        }
    }, async env => {
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [textSegment('闲时失败消息')],
            time: nowSeconds()
        });
        await env.openAI.waitForRequestCount(3);
        await env.expectNoActivity({windowMs: 1500, description: '闲时触发失败应静默'});
        assert.equal(env.oneBot.sentMessages.length, 0);
    });
});

test('非法reply工具参数不会被视为有效回复', {timeout: 150000}, async () => {
    await runScenario({
        name: 'failures-invalid-tool-args',
        groups: [1001],
        channels: {
            primary: [
                {action: {type: 'rawToolCall', name: 'reply', argumentsText: '{"messages":"oops"}'}},
                {action: {type: 'text', text: '参数错误后先不回复'}},
                {action: {type: 'text', text: 'reminder后仍不回复'}},
                {action: {type: 'text', text: '最后一次仍不回复'}}
            ]
        }
    }, async env => {
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('非法参数测试')],
            time: nowSeconds()
        });
        await env.oneBot.waitForGroupSendCount(1001, 1);

        assert.equal(env.openAI.requestCount(), 4);
        assert.match(lastUserText(env.openAI.requests[2].body), REMINDER_TEXT);
        assert.match(lastUserText(env.openAI.requests[3].body), REMINDER_TEXT);

        const sent = env.oneBot.sentMessagesFor(1001);
        assert.deepEqual(sent[0].message, [{type: 'text', data: {text: '@响应失败'}}]);
    });
});
