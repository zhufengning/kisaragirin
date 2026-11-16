import test from 'node:test';
import assert from 'node:assert/strict';
import {runScenario} from '../runner/scenario-runner';
import {atSegment, nowSeconds, textSegment} from '../runner/messages';
import type {ModelResponseRule} from '../fakes/openai-completions-server';

function toolRule (name: string, args: unknown): ModelResponseRule {
    return {action: {type: 'toolCall', name, arguments: args}};
}

function replyRule (messages: Array<{text: string}>): ModelResponseRule {
    return {
        action: {
            type: 'replyTool',
            params: {messages, requires_deep_research: false}
        }
    };
}

test('bot 是群管理员时注册禁言与撤回工具并调用 OneBot 接口', {timeout: 150000}, async () => {
    await runScenario({
        name: 'admin-tools-enabled',
        groups: [1001],
        botRole: 'admin',
        channels: {
            primary: [
                toolRule('set_group_ban', {user_name: '群友乙', duration: 60}),
                toolRule('set_group_ban', {user_name: '查无此人', duration: 60}),
                toolRule('set_group_ban', {user_id: 1001, duration: 0}),
                toolRule('delete_msg', {message_id: 1}),
                toolRule('delete_msg', {message_id: 999}),
                replyRule([{text: '已处理'}])
            ]
        }
    }, async env => {
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            messageId: 9000,
            segments: [atSegment(10000), textSegment('违规发言')],
            time: nowSeconds()
        });

        await env.openAI.waitForRequestCount(6);
        await env.oneBot.waitForGroupSendCount(1001, 1);

        const systemPrompt = env.openAI.requests[0].serialized;
        assert.match(systemPrompt, /set_group_ban/);
        assert.match(systemPrompt, /delete_msg/);

        const bans = env.oneBot.apiCallsFor('set_group_ban');
        assert.equal(bans.length, 2);
        assert.deepEqual(bans[0].params, {group_id: 1001, user_id: 1002, duration: 60});
        assert.deepEqual(bans[1].params, {group_id: 1001, user_id: 1001, duration: 0});

        // 数据库消息 id 1 对应的 OneBot 消息 id 是 9000
        const recalls = env.oneBot.apiCallsFor('delete_msg');
        assert.equal(recalls.length, 1);
        assert.deepEqual(recalls[0].params, {message_id: 9000});

        assert.match(env.openAI.requests[1].serialized, /已禁言 1002/);
        assert.match(env.openAI.requests[2].serialized, /未找到群名片或昵称为「查无此人」/);
        assert.match(env.openAI.requests[3].serialized, /已解除 1001 的禁言/);
        assert.match(env.openAI.requests[4].serialized, /已撤回消息 #1/);
        assert.match(env.openAI.requests[5].serialized, /消息 #999 不存在或不属于本群/);
    });
});

test('消息库中的历史群名片可解析禁言目标，无需成员列表缓存', {timeout: 120000}, async () => {
    await runScenario({
        name: 'admin-tools-db-name',
        groups: [1001],
        botRole: 'admin',
        groupMembers: [],
        channels: {
            primary: [
                toolRule('set_group_ban', {user_name: '群炫压抑最严重', duration: 600}),
                replyRule([{text: '已处理'}])
            ]
        }
    }, async env => {
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            messageId: 8000,
            userId: 1002,
            senderName: 'LoongMorty',
            senderCard: '群炫压抑最严重（备考研升专中）',
            segments: [textSegment('旧消息')],
            time: nowSeconds()
        });
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            messageId: 9000,
            segments: [atSegment(10000), textSegment('禁言他')],
            time: nowSeconds()
        });

        await env.openAI.waitForRequestCount(2);
        await env.oneBot.waitForGroupSendCount(1001, 1);

        const bans = env.oneBot.apiCallsFor('set_group_ban');
        assert.equal(bans.length, 1);
        assert.deepEqual(bans[0].params, {group_id: 1001, user_id: 1002, duration: 600});
        assert.match(env.openAI.requests[1].serialized, /已禁言 1002/);
    });
});

test('bot 不是群管理员时不注册禁言与撤回工具', {timeout: 120000}, async () => {
    await runScenario({
        name: 'admin-tools-disabled',
        groups: [1001],
        botRole: 'member',
        channels: {
            primary: [replyRule([{text: '正常回复'}])]
        }
    }, async env => {
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('普通聊天')],
            time: nowSeconds()
        });

        await env.openAI.waitForRequestCount(1);
        await env.oneBot.waitForGroupSendCount(1001, 1);

        const systemPrompt = env.openAI.requests[0].serialized;
        assert.doesNotMatch(systemPrompt, /set_group_ban/);
        assert.doesNotMatch(systemPrompt, /delete_msg/);
        assert.equal(env.oneBot.apiCallsFor('set_group_ban').length, 0);
        assert.equal(env.oneBot.apiCallsFor('delete_msg').length, 0);
    });
});
