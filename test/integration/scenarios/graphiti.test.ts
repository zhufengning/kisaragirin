import test from 'node:test';
import assert from 'node:assert/strict';
import {runScenario} from '../runner/scenario-runner';
import {atSegment, lastUserText, nowSeconds, textSegment} from '../runner/messages';
import type {ModelResponseRule} from '../fakes/openai-completions-server';

function replyRule (text: string): ModelResponseRule {
    return {
        action: {type: 'replyTool', params: {messages: [{text}], requires_deep_research: false}}
    };
}

function keywordRule (queries: string[], entities: string[]): ModelResponseRule {
    return {action: {type: 'json', value: {queries, entities}}};
}

const FACT = '小明喜欢蓝色';
const ENTITY_SUMMARY = '一个喜欢蓝色的群友';

test('自动记忆关键词生成后检索事实与实体并注入prompt', {timeout: 150000}, async () => {
    await runScenario({
        name: 'graphiti-memory-inject',
        groups: [1001],
        memoryKeyword: 'memory',
        enableEntitySearch: true,
        channels: {
            memory: [keywordRule(['小明喜欢什么'], ['小明'])],
            primary: [replyRule('记忆回复')]
        },
        graphiti: {
            searchFacts: [{fact: FACT, valid_at: '2024-01-01T00:00:00Z'}],
            searchNodes: [{name: '小明', summary: ENTITY_SUMMARY}]
        }
    }, async env => {
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('小明喜欢什么颜色')],
            time: nowSeconds()
        });
        await env.oneBot.waitForGroupSendCount(1001, 1);

        assert.equal(env.openAI.requestCount(), 2);
        const keywordRequest = env.openAI.requests[0];
        assert.equal(keywordRequest.model, 'memory');
        assert.equal(keywordRequest.stream, false);

        const promptText = lastUserText(env.openAI.requests[1].body);
        assert.match(promptText, /--- 记忆自动检索 ---/);
        assert.match(promptText, /事实：/);
        assert.match(promptText, new RegExp(FACT));
        assert.match(promptText, /相关实体：/);
        assert.match(promptText, new RegExp(ENTITY_SUMMARY));

        const searchCalls = env.graphitiCalls()
            .filter(call => call.phase === 'start');
        assert.ok(searchCalls.some(call => call.method === 'search'));
        assert.ok(searchCalls.some(call => call.method === 'search_nodes'));
    });
});

test('已注入事实在下一轮作为已有记忆交给关键词模型，不重复注入', {timeout: 150000}, async () => {
    await runScenario({
        name: 'graphiti-memory-dedup',
        groups: [1001],
        memoryKeyword: 'memory',
        channels: {
            memory: [
                keywordRule(['小明喜欢什么'], []),
                keywordRule([], [])
            ],
            primary: [
                replyRule('第一轮回复'),
                replyRule('第二轮回复')
            ]
        },
        graphiti: {
            searchFacts: [{fact: FACT, valid_at: '2024-01-01T00:00:00Z'}]
        }
    }, async env => {
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('第一轮消息')],
            time: nowSeconds()
        });
        await env.oneBot.waitForGroupSendCount(1001, 1);

        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('第二轮消息')],
            time: nowSeconds()
        });
        await env.oneBot.waitForGroupSendCount(1001, 2);

        assert.equal(env.openAI.requestCount(), 4);
        const secondKeywordPrompt = lastUserText(env.openAI.requests[2].body);
        assert.match(secondKeywordPrompt, new RegExp(FACT));
        assert.match(env.openAI.requests[2].serialized, /已检索到的记忆/);

        const secondPrimaryPrompt = lastUserText(env.openAI.requests[3].body);
        assert.doesNotMatch(secondPrimaryPrompt, /记忆自动检索/);
    });
});

test('memory search失败时工具返回错误且回复继续', {timeout: 150000}, async () => {
    await runScenario({
        name: 'graphiti-search-error',
        groups: [1001],
        channels: {
            primary: [
                {action: {type: 'toolCall', name: 'search_memory', arguments: {query: '会失败'}}},
                replyRule('错误后仍然回复')
            ]
        },
        graphiti: {
            searchError: {code: -32000, message: 'neo4j unavailable'}
        }
    }, async env => {
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('搜索失败测试')],
            time: nowSeconds()
        });
        await env.oneBot.waitForGroupSendCount(1001, 1);

        assert.equal(env.openAI.requestCount(), 2);
        assert.match(env.openAI.requests[1].serialized, /搜索记忆失败/);
        const sent = env.oneBot.sentMessagesFor(1001);
        assert.deepEqual(sent[0].message[1],
            {type: 'text', data: {text: '错误后仍然回复'}});
    });
});

test('合并episode与模型user message一致，bot回复产生独立episode', {timeout: 150000}, async () => {
    await runScenario({
        name: 'graphiti-episodes',
        groups: [1001],
        memoryKeyword: 'memory',
        channels: {
            memory: [keywordRule(['小明喜欢什么'], [])],
            primary: [replyRule('带记忆的回复')]
        },
        graphiti: {
            searchFacts: [{fact: FACT, valid_at: '2024-01-01T00:00:00Z'}]
        }
    }, async env => {
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('episode 测试消息')],
            time: nowSeconds()
        });
        await env.oneBot.waitForGroupSendCount(1001, 1);
        await env.waitForGraphitiCall('add_episode');

        const primaryPrompt = lastUserText(env.openAI.requests[1].body);
        const calls = env.graphitiCalls()
            .filter(call => call.phase === 'start' && call.method === 'add_episode');

        const mergedCall = calls.find(call =>
            String(call.params.name).startsWith('group_merged_'));
        assert.ok(mergedCall, '应写入合并消息 episode');
        const merged = JSON.parse(String(mergedCall.params.content)) as {
            content: string;
            message_count: number;
            message_ids: number[];
        };
        assert.ok(primaryPrompt.startsWith(merged.content),
            '合并 episode 内容应与模型原始 user message 一致');
        assert.doesNotMatch(merged.content, /记忆自动检索/);
        assert.doesNotMatch(merged.content, /时序提示/);
        assert.deepEqual(merged.message_ids, [1]);
        assert.equal(merged.message_count, 1);

        const botCall = calls.find(call =>
            String(call.params.name).startsWith('group_chat_msg_'));
        assert.ok(botCall, '应写入 bot 回复 episode');
        assert.match(String(botCall.params.content), /带记忆的回复/);
        assert.equal(String(botCall.params.source_description), '群聊 1001');
    });
});

test('add_episode被闸门暂停时OneBot回复仍然先完成', {timeout: 150000}, async () => {
    await runScenario({
        name: 'graphiti-async-episode',
        groups: [1001],
        channels: {primary: [replyRule('异步写入回复')]},
        graphiti: {addEpisodeGate: 'episode-gate'}
    }, async env => {
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('异步写入测试')],
            time: nowSeconds()
        });

        await env.waitForGraphitiGate('episode-gate');
        await env.oneBot.waitForGroupSendCount(1001, 1);
        assert.equal(env.oneBot.sentMessagesFor(1001).length, 1);
        assert.ok(env.db.botMessages(1001).length >= 1);

        env.releaseGraphitiGate('episode-gate');
        await env.waitForGraphitiCall('add_episode', call =>
            String(call.params.name).startsWith('group_chat_msg_'));
    });
});
