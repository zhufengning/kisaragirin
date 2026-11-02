import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {runScenario} from '../runner/scenario-runner';
import {atSegment, imageSegment, nowSeconds, textSegment} from '../runner/messages';
import {fixtureBytes} from '../fakes/asset-server';
import {prompts} from '../../../src/prompts';

test('模型通过ask_image追问图片细节后回复', {timeout: 150000}, async () => {
    await runScenario({
        name: 'image-ask-tool',
        groups: [1001],
        channels: {
            vision: [
                {action: {type: 'text', text: '一张报错截图'}},
                {action: {type: 'text', text: '报错文字是端口占用'}}
            ],
            primary: [
                {
                    action: {
                        type: 'toolCall',
                        name: 'ask_image',
                        arguments: {image_id: 1, question: '截图里的报错文字是什么？'}
                    }
                },
                {
                    action: {
                        type: 'replyTool',
                        params: {messages: [{text: '端口被占用了'}], requires_deep_research: false}
                    }
                }
            ]
        }
    }, async env => {
        const url = env.assets.serveFixture('image-a.png');
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), imageSegment(url), textSegment('看看这张图')],
            time: nowSeconds()
        });

        await env.oneBot.waitForGroupSendCount(1001, 1);

        const sha256 = createHash('sha256').update(fixtureBytes('image-a.png'))
            .digest('hex');
        assert.equal(env.db.imageId(sha256), 1);

        const visionRequests = env.openAI.requests.filter(request => request.model === 'vision');
        assert.equal(visionRequests.length, 2);
        const askBody = visionRequests[1].body as {
            messages: Array<{role: string; content: unknown}>;
        };
        const askSystemMessage = askBody.messages.find(message => message.role === 'system');
        assert.equal(askSystemMessage?.content, prompts.visionQuestionSystem);
        assert.match(visionRequests[1].serialized, /截图里的报错文字是什么？/);

        const primaryRequests = env.openAI.requests.filter(request => request.model === 'primary');
        assert.match(primaryRequests[0].serialized, /\[image#1: 一张报错截图\]/);
        assert.match(primaryRequests[1].serialized, /报错文字是端口占用/);

        const sent = env.oneBot.sentMessagesFor(1001);
        assert.deepEqual(sent[0].message, [
            {type: 'reply', data: {id: 1}},
            {type: 'text', data: {text: '端口被占用了'}}
        ]);
        assert.equal(env.db.imageDescription(sha256), '一张报错截图',
            '追问不应改写已保存的描述');
    });
});
