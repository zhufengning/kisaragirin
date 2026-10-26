import test from 'node:test';
import assert from 'node:assert/strict';
import {runScenario} from '../runner/scenario-runner';
import {lastUserText} from '../runner/messages';
import {sleep, waitFor} from '../runner/wait-for';
import type {ModelResponseRule} from '../fakes/openai-completions-server';

function replyRule (text: string, gate?: string): ModelResponseRule {
    return {
        action: {type: 'replyTool', params: {messages: [{text}], requires_deep_research: false}},
        ...(gate ? {gate} : {})
    };
}

function everySecondCron (): string {
    return '*/1 * * * * *';
}

test('定时任务每秒触发并写入系统消息', {timeout: 120000}, async () => {
    await runScenario({
        name: 'scheduled-basic',
        groups: [1001],
        scheduledTasks: {
            1001: [{name: '每秒任务', cron: everySecondCron(), prompt: '定时提示内容'}]
        },
        channels: {primary: [
            replyRule('定时回复'),
            replyRule('第二次定时回复'),
            replyRule('第三次定时回复'),
            replyRule('第四次定时回复'),
            replyRule('第五次定时回复')
        ]}
    }, async env => {
        await env.oneBot.waitForGroupSendCount(1001, 1);
        await env.waitForGroupMessages(1001, 2);

        const systemMessages = env.db.systemMessages(1001);
        assert.ok(systemMessages.length >= 1);
        assert.deepEqual(systemMessages[0].segments, [{type: 'system', text: '定时提示内容'}]);

        const sent = env.oneBot.sentMessagesFor(1001);
        assert.equal(sent[0].message[0].type, 'text', '定时任务回复不应自动引用');

        await env.stopApp();
        const systemCount = env.db.systemMessages(1001).length;
        const sendCount = env.oneBot.sentMessages.length;
        const requestCount = env.openAI.requestCount();
        await sleep(1500);
        assert.equal(env.db.systemMessages(1001).length, systemCount, '停止后不应再产生任务');
        assert.equal(env.oneBot.sentMessages.length, sendCount);
        assert.equal(env.openAI.requestCount(), requestCount);
    });
});

test('deep_research_topic 先产生研究系统消息再执行消息轮', {timeout: 150000}, async () => {
    await runScenario({
        name: 'scheduled-research',
        groups: [1001],
        scheduledTasks: {
            1001: [{
                name: '研究任务',
                cron: everySecondCron(),
                prompt: '请汇报研究主题',
                deep_research_topic: '定时研究主题'
            }]
        },
        channels: {
            research: [
                {action: {type: 'text', text: '研究报告正文'}},
                {action: {type: 'text', text: '研究报告正文'}},
                {action: {type: 'text', text: '研究报告正文'}},
                {action: {type: 'text', text: '研究报告正文'}}
            ],
            primary: [
                replyRule('研究后的定时回复'),
                replyRule('研究后的定时回复'),
                replyRule('研究后的定时回复'),
                replyRule('研究后的定时回复')
            ]
        }
    }, async env => {
        await env.oneBot.waitForGroupSendCount(1001, 1);
        await env.stopApp();

        const rows = env.db.messages(1001);
        const systemTexts = rows
            .filter(row => row.specialType === 'system')
            .map(row => (row.segments[0] as {text: string}).text);
        const startIndex = systemTexts.findIndex(text => text.startsWith('开始深度研究：定时研究主题'));
        const resultIndex = systemTexts.findIndex(text => text.startsWith('深度研究结果：定时研究主题'));
        const endIndex = systemTexts.findIndex(text => text.startsWith('深度研究结束：定时研究主题'));
        assert.ok(startIndex >= 0, '应写入研究开始系统消息');
        assert.ok(resultIndex > startIndex, '研究结果应在开始之后');
        assert.ok(endIndex > resultIndex, '研究结束应在结果之后');
        assert.match(systemTexts[resultIndex], /研究报告正文/);

        const researchRequest = env.openAI.requests.find(request => request.model === 'research');
        assert.ok(researchRequest, '应发起深度研究请求');
        assert.match(researchRequest.serialized, /定时研究主题/);

        const replyRow = env.db.botMessages(1001)[0];
        assert.ok(replyRow, '应产生定时任务回复');
        assert.equal(replyRow.segments[0].type, 'text');

        const promptText = env.openAI.requests
            .filter(request => request.model === 'primary')
            .map(request => lastUserText(request.body))
            .join('\n');
        assert.match(promptText, /深度研究结果：定时研究主题/);
        assert.match(promptText, /定时提示内容|请汇报研究主题/);
    });
});

test('定时触发失败时静默处理，不发送@失败兜底', {timeout: 120000}, async () => {
    await runScenario({
        name: 'scheduled-failure',
        groups: [1001],
        scheduledTasks: {
            1001: [{name: '失败任务', cron: everySecondCron(), prompt: '会失败的任务'}]
        },
        channels: {
            primary: [
                {action: {type: 'httpError', status: 400, body: {error: {message: 'bad request'}}}},
                {action: {type: 'httpError', status: 400, body: {error: {message: 'bad request'}}}},
                {action: {type: 'httpError', status: 400, body: {error: {message: 'bad request'}}}},
                {action: {type: 'httpError', status: 400, body: {error: {message: 'bad request'}}}},
                {action: {type: 'httpError', status: 400, body: {error: {message: 'bad request'}}}},
                {action: {type: 'httpError', status: 400, body: {error: {message: 'bad request'}}}},
                {action: {type: 'httpError', status: 400, body: {error: {message: 'bad request'}}}},
                {action: {type: 'httpError', status: 400, body: {error: {message: 'bad request'}}}},
                {action: {type: 'httpError', status: 400, body: {error: {message: 'bad request'}}}},
                {action: {type: 'httpError', status: 400, body: {error: {message: 'bad request'}}}},
                {action: {type: 'httpError', status: 400, body: {error: {message: 'bad request'}}}},
                {action: {type: 'httpError', status: 400, body: {error: {message: 'bad request'}}}}
            ]
        }
    }, async env => {
        await env.openAI.waitForRequestCount(3, 20000);
        await env.stopApp();
        assert.equal(env.oneBot.sentMessages.length, 0, '定时任务失败应静默');
    });
});

test('enabled为false、非白名单群与空配置的任务不会注册', {timeout: 120000}, async () => {
    await runScenario({
        name: 'scheduled-invalid',
        groups: [1001],
        scheduledTasks: {
            1001: [
                {name: '禁用任务', cron: everySecondCron(), prompt: '禁用任务提示', enabled: false},
                {name: '空cron', cron: '  ', prompt: '空cron提示'},
                {name: '空prompt', cron: everySecondCron(), prompt: '   '}
            ],
            1002: [{name: '非白名单任务', cron: everySecondCron(), prompt: '不应执行'}]
        },
        channels: {}
    }, async env => {
        await sleep(2500);
        assert.equal(env.db.systemMessages(1001).length, 0);
        assert.equal(env.db.systemMessages(1002).length, 0);
        assert.equal(env.openAI.requestCount(), 0);
        assert.equal(env.oneBot.sentMessages.length, 0);
    });
});

test('高频定时触发与慢回复并存时保持顺序与单群串行', {timeout: 150000}, async () => {
    await runScenario({
        name: 'scheduled-order',
        groups: [1001],
        scheduledTasks: {
            1001: [{name: '顺序任务', cron: everySecondCron(), prompt: '顺序任务提示'}]
        },
        channels: {
            primary: [
                replyRule('第一条回复', 'slow-reply'),
                replyRule('第二条回复'),
                replyRule('第三条回复'),
                replyRule('第四条回复'),
                replyRule('第五条回复'),
                replyRule('第六条回复')
            ]
        }
    }, async env => {
        await env.openAI.waitForGate('slow-reply');
        await waitFor(() => env.db.systemMessages(1001).length >= 3, {
            description: '积累三条定时系统消息',
            timeoutMs: 10000
        });

        assert.equal(env.openAI.activeOnChannel('primary/group-1001'), 1);
        assert.equal(env.openAI.requestCount(), 1);

        env.openAI.releaseGate('slow-reply');
        await env.stopApp();

        const systemCount = env.db.systemMessages(1001).length;
        const sends = env.oneBot.sentMessagesFor(1001);
        assert.ok(systemCount >= 3);
        assert.ok(sends.length >= 2, '已入队的定时任务应全部得到回复');
        assert.ok(sends.length <= systemCount, '不应产生多于定时任务的回复');

        const systemIds = env.db.systemMessages(1001).map(row => row.id);
        const sortedIds = [...systemIds].sort((left, right) => left - right);
        assert.deepEqual(systemIds, sortedIds);

        const replyTexts = sends.map(item =>
            (item.message[item.message.length - 1] as {data: {text: string}}).data.text);
        const expectedTexts = [
            '第一条回复', '第二条回复', '第三条回复', '第四条回复', '第五条回复', '第六条回复'
        ];
        assert.deepEqual(replyTexts, expectedTexts.slice(0, replyTexts.length));

        const channelRequests = env.openAI.requests.filter(
            request => request.channel === 'primary/group-1001'
        );
        for (const request of channelRequests) {
            assert.ok(request.channelActiveAtStart <= 1, '单群回复应由 FIFO 串行执行');
        }
    });
});
