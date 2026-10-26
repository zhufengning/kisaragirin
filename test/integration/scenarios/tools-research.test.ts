import test from 'node:test';
import assert from 'node:assert/strict';
import {runScenario} from '../runner/scenario-runner';
import {atSegment, lastUserText, nowSeconds, textSegment} from '../runner/messages';
import {waitFor} from '../runner/wait-for';
import type {ModelResponseRule} from '../fakes/openai-completions-server';

function toolRule (name: string, args: unknown): ModelResponseRule {
    return {action: {type: 'toolCall', name, arguments: args}};
}

function replyRule (
    messages: Array<{text: string; ref?: number}>,
    requiresDeepResearch = false,
    topic?: string
): ModelResponseRule {
    return {
        action: {
            type: 'replyTool',
            params: {
                messages,
                requires_deep_research: requiresDeepResearch,
                ...(topic ? {deep_research_topic: topic} : {})
            }
        }
    };
}

function textRule (text: string): ModelResponseRule {
    return {action: {type: 'text', text}};
}

function errorRule (): ModelResponseRule {
    return {action: {type: 'httpError', status: 400, body: {error: {message: 'bad request'}}}};
}

test('模型多次调用search_memory后回复，多消息逐条发送并解析引用', {timeout: 150000}, async () => {
    await runScenario({
        name: 'tools-memory-loop',
        groups: [1001],
        channels: {
            primary: [
                toolRule('search_memory', {query: '小明喜欢什么'}),
                toolRule('search_memory', {query: '小明的偏好'}),
                replyRule([{text: '第一条回复', ref: 1}, {text: '第二条回复'}])
            ]
        },
        graphiti: {
            searchFacts: [
                {fact: '小明喜欢蓝色', valid_at: '2024-01-01T00:00:00Z', uuid: 'edge-1'}
            ]
        }
    }, async env => {
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('触发记忆检索')],
            time: nowSeconds()
        });

        await env.openAI.waitForRequestCount(3);
        await env.oneBot.waitForGroupSendCount(1001, 2);

        const secondRequestText = lastUserText(env.openAI.requests[1].body);
        assert.match(env.openAI.requests[1].serialized, /小明喜欢蓝色/);
        assert.match(env.openAI.requests[2].serialized, /小明喜欢蓝色/);
        assert.match(secondRequestText, /触发记忆检索/);

        const sent = env.oneBot.sentMessagesFor(1001);
        assert.equal(sent.length, 2);
        assert.deepEqual(sent[0].message, [
            {type: 'reply', data: {id: 1}},
            {type: 'text', data: {text: '第一条回复'}}
        ]);
        assert.deepEqual(sent[1].message, [
            {type: 'text', data: {text: '第二条回复'}}
        ]);

        await env.waitForGraphitiCall('search');
        const searchCalls = env.graphitiCalls()
            .filter(call => call.method === 'search' && call.phase === 'start');
        assert.equal(searchCalls.length, 2);
        assert.equal(searchCalls[0].params.group_id, 'group-1001');
    });
});

test('reply返回空消息数组时不发送消息但推进水位线', {timeout: 120000}, async () => {
    await runScenario({
        name: 'tools-empty-reply',
        groups: [1001],
        channels: {primary: [replyRule([])]}
    }, async env => {
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('无需回复')],
            time: nowSeconds()
        });
        await env.openAI.waitForRequestCount(1);
        await env.waitForLastTriggerId(1001, 1);
        await env.expectNoActivity({windowMs: 500, description: '空消息数组不应发送'});
        assert.equal(env.oneBot.sentMessages.length, 0);
    });
});

test('非reply工具超过轮数上限后阻止并进入reminder失败处理', {timeout: 150000}, async () => {
    await runScenario({
        name: 'tools-round-limit',
        groups: [1001],
        maxToolCallRounds: 1,
        channels: {
            primary: [
                toolRule('search_memory', {query: '第一次'}),
                toolRule('search_memory', {query: '第二次'}),
                textRule('不使用reply'),
                textRule('仍然不使用reply'),
                textRule('最后一次也不使用reply')
            ]
        },
        graphiti: {searchFacts: []}
    }, async env => {
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('触发轮数限制')],
            time: nowSeconds()
        });

        await env.oneBot.waitForGroupSendCount(1001, 1);
        await env.openAI.waitForRequestCount(5);

        const blockedRequest = env.openAI.requests[2];
        assert.match(blockedRequest.serialized, /tool call round limit exceeded/);
        assert.match(env.openAI.requests[3].serialized, /未检测到有效reply工具调用/);

        const sent = env.oneBot.sentMessagesFor(1001);
        assert.equal(sent.length, 1);
        assert.deepEqual(sent[0].message, [{type: 'text', data: {text: '@响应失败'}}]);
    });
});

test('深度研究回合链可链式请求研究并引用上一轮回复', {timeout: 180000}, async () => {
    await runScenario({
        name: 'tools-research-chain',
        groups: [1001],
        maxDeepResearchRounds: 3,
        channels: {
            research: [
                {action: {type: 'text', text: '第一份研究报告'}},
                {action: {type: 'text', text: '第二份研究报告'}}
            ],
            primary: [
                replyRule([{text: '初步回复'}], true, '主题一'),
                replyRule([{text: '第二轮回复'}], true, '主题二'),
                replyRule([{text: '最终回复'}])
            ]
        },
        graphiti: {}
    }, async env => {
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('请研究一下')],
            time: nowSeconds()
        });

        await env.oneBot.waitForGroupSendCount(1001, 3);

        const researchRequests = env.openAI.requests.filter(request => request.model === 'research');
        assert.equal(researchRequests.length, 2);
        assert.match(researchRequests[0].serialized, /主题一/);
        assert.match(researchRequests[1].serialized, /主题二/);

        const sent = env.oneBot.sentMessagesFor(1001);
        assert.equal(sent.length, 3);
        assert.equal(sent[0].message[0].type, 'reply');
        assert.equal(sent[1].message[0].type, 'reply');
        assert.deepEqual(sent[1].message[0], {type: 'reply', data: {id: sent[0].messageId}});
        assert.deepEqual(sent[2].message[0], {type: 'reply', data: {id: sent[1].messageId}});
        assert.deepEqual(sent[2].message[1], {type: 'text', data: {text: '最终回复'}});

        const systemTexts = env.db.systemMessages(1001)
            .map(row => row.segments[0].text ?? '');
        const startOne = systemTexts.findIndex(text => text.includes('开始深度研究：主题一'));
        const endOne = systemTexts.findIndex(text => text.includes('深度研究结束：主题一'));
        const startTwo = systemTexts.findIndex(text => text.includes('开始深度研究：主题二'));
        assert.ok(startOne >= 0 && endOne > startOne);
        assert.ok(startTwo > endOne);

        await env.waitForGraphitiCall('add_episode', call =>
            String(call.params.content).includes('第一份研究报告')
        );
    });
});

test('达到深度研究轮数上限后忽略后续研究请求', {timeout: 150000}, async () => {
    await runScenario({
        name: 'tools-research-limit',
        groups: [1001],
        maxDeepResearchRounds: 1,
        channels: {
            research: [{action: {type: 'text', text: '唯一一份研究报告'}}],
            primary: [
                replyRule([{text: '初步回复'}], true, '唯一主题'),
                replyRule([{text: '仍想研究'}], true, '第二个主题'),
                replyRule([{text: '不应出现'}])
            ]
        }
    }, async env => {
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('研究一次就够')],
            time: nowSeconds()
        });

        await env.oneBot.waitForGroupSendCount(1001, 2);
        await env.expectNoActivity({windowMs: 800, description: '超过上限后不应继续研究'});

        assert.equal(env.openAI.requests.filter(request => request.model === 'research').length, 1);
        assert.equal(env.oneBot.sentMessagesFor(1001).length, 2);
    });
});

test('深度研究失败与最终回复失败使用不同的兜底文案', {timeout: 180000}, async () => {
    await runScenario({
        name: 'tools-research-failed',
        groups: [1001],
        channels: {
            research: [errorRule()],
            primary: [
                replyRule([{text: '初步回复'}], true, '失败主题'),
                errorRule(),
                errorRule(),
                errorRule()
            ]
        }
    }, async env => {
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('研究失败测试')],
            time: nowSeconds()
        });
        await env.oneBot.waitForGroupSendCount(1001, 2);

        const sent = env.oneBot.sentMessagesFor(1001);
        assert.equal(sent.length, 2);
        assert.deepEqual(sent[1].message[0], {type: 'reply', data: {id: sent[0].messageId}});
        assert.deepEqual(sent[1].message[1], {type: 'text', data: {text: '深度研究失败'}});
        await waitFor(() => env.db.systemMessages(1001)
            .some(row => (row.segments[0].text ?? '').includes('状态：错误')),
        {description: '研究失败应写入错误状态系统消息'});
    });

    await runScenario({
        name: 'tools-research-final-failed',
        groups: [1001],
        channels: {
            research: [{action: {type: 'text', text: '成功的研究报告'}}],
            primary: [
                replyRule([{text: '初步回复'}], true, '成功主题'),
                errorRule(),
                errorRule(),
                errorRule()
            ]
        }
    }, async env => {
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('研究成功后回复失败')],
            time: nowSeconds()
        });
        await env.oneBot.waitForGroupSendCount(1001, 2);

        const sent = env.oneBot.sentMessagesFor(1001);
        assert.equal(sent.length, 2);
        assert.deepEqual(sent[1].message[1],
            {type: 'text', data: {text: '深度研究后回复生成失败'}});
    });
});
