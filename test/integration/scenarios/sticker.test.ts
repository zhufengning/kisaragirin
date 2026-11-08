import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {runScenario} from '../runner/scenario-runner';
import {atSegment, imageSegment, nowSeconds, textSegment} from '../runner/messages';
import {fixtureBytes} from '../fakes/asset-server';
import {waitFor} from '../runner/wait-for';
import {prompts} from '../../../src/prompts';
import type {Message} from '@lib/types/messages';

function stickerList (env: {db: {kvValue: (key: string) => string | undefined}}): unknown {
    const raw = env.db.kvValue('stickers');
    return raw === undefined ? [] : JSON.parse(raw);
}

function sessionHeaderText (path: string): string {
    const branch = SessionManager.open(path).getBranch();
    const texts: string[] = [];
    for (const entry of branch) {
        if (entry.type !== 'message' || entry.message.role !== 'user') continue;
        const content = entry.message.content;
        const text = typeof content === 'string' ? content : content
            .filter(block => block.type === 'text')
            .map(block => block.text)
            .join('');
        if (!text.startsWith(prompts.groupMemoryContextPrefix) &&
            !text.startsWith(prompts.stickerListPrefix)) {
            break;
        }
        texts.push(text);
    }
    return texts.join('\n');
}

function imageData (segments: Message[]): {file: string; sub_type?: number} {
    const image = segments.find(segment => segment.type === 'image');
    assert.ok(image && image.type === 'image');
    return image.data;
}

function imageBytes (segments: Message[]): Buffer {
    const data = imageData(segments);
    assert.ok(data.file.startsWith('base64://'));
    return Buffer.from(data.file.slice('base64://'.length), 'base64');
}

test('reply 校验、收藏表情并用图片ID发送、按图片ID取消收藏', {timeout: 150000}, async () => {
    await runScenario({
        name: 'sticker-save-send',
        groups: [1001],
        channels: {
            vision: [{action: {type: 'text', text: '一只带问号的小狗表情包'}}],
            primary: [
                {
                    action: {
                        type: 'replyTool',
                        params: {messages: [{text: '文字', image_id: 1}], requires_deep_research: false}
                    }
                },
                {
                    action: {
                        type: 'replyTool',
                        params: {
                            messages: [{text: '占位'}],
                            requires_deep_research: false,
                            deep_research_topic: '测试主题'
                        }
                    }
                },
                {
                    action: {
                        type: 'toolCall',
                        name: 'add_sticker',
                        arguments: {image_id: 1, category: '疑惑', note: '带问号的小狗'}
                    }
                },
                {
                    action: {
                        type: 'replyTool',
                        params: {messages: [{image_id: 1}], requires_deep_research: false}
                    }
                },
                {
                    action: {
                        type: 'toolCall',
                        name: 'remove_sticker',
                        arguments: {image_id: 1}
                    }
                },
                {
                    action: {
                        type: 'replyTool',
                        params: {messages: [{text: '已取消收藏'}], requires_deep_research: false}
                    }
                },
                {
                    action: {
                        type: 'replyTool',
                        params: {
                            messages: [{image_id: 1, not_sticker: true}],
                            requires_deep_research: false
                        }
                    }
                }
            ]
        }
    }, async env => {
        const url = env.assets.serveFixture('image-a.png');
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), imageSegment(url), textSegment('发个表情')],
            time: nowSeconds()
        });
        await env.oneBot.waitForGroupSendCount(1001, 1);

        const requests = env.openAI.requests.filter(request => request.model === 'primary');
        assert.match(requests[1].serialized, /第1条消息同时包含文字和图片/);
        assert.match(requests[2].serialized, /未请求深度研究/);
        assert.match(
            requests[3].serialized,
            /已收藏表情：图片ID 1，分类：疑惑，备注：带问号的小狗/);

        const sent = env.oneBot.sentMessagesFor(1001);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].message[0].type, 'reply');
        assert.equal(imageData(sent[0].message).sub_type, 1);

        const sha256 = createHash('sha256').update(fixtureBytes('image-a.png'))
            .digest('hex');
        const sentImage = imageBytes(sent[0].message);
        const sentSha256 = createHash('sha256')
            .update(sentImage)
            .digest('hex');
        assert.equal(sentSha256, sha256);

        const botMessages = env.db.botMessages(1001);
        const lastBotMessage = botMessages[botMessages.length - 1];
        assert.deepEqual(lastBotMessage.segments[1], {type: 'image', sha256});
        assert.deepEqual(stickerList(env), [
            {imageId: 1, category: '疑惑', note: '带问号的小狗'}
        ]);

        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('不要这个表情了')],
            time: nowSeconds()
        });
        await env.oneBot.waitForGroupSendCount(1001, 2);
        const removeRequest = env.openAI.requests.find(request =>
            request.serialized.includes('已取消收藏图片ID 1'));
        assert.ok(removeRequest, 'remove_sticker 应返回取消收藏结果');
        assert.deepEqual(stickerList(env), []);

        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('用普通图片发一次')],
            time: nowSeconds()
        });
        await env.oneBot.waitForGroupSendCount(1001, 3);
        const plainImage = imageData(env.oneBot.sentMessagesFor(1001)[2].message);
        assert.equal(plainImage.sub_type, undefined);
    });
});

test('表情包收藏达到上限时返回失败提示', {timeout: 150000}, async () => {
    await runScenario({
        name: 'sticker-list-full',
        groups: [1001],
        stickerMaxCount: 0,
        channels: {
            vision: [{action: {type: 'text', text: '一只带问号的小狗表情包'}}],
            primary: [
                {
                    action: {
                        type: 'toolCall',
                        name: 'add_sticker',
                        arguments: {image_id: 1, category: '疑惑', note: '带问号的小狗'}
                    }
                },
                {
                    action: {
                        type: 'replyTool',
                        params: {messages: [{text: '收藏失败'}], requires_deep_research: false}
                    }
                }
            ]
        }
    }, async env => {
        const url = env.assets.serveFixture('image-a.png');
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), imageSegment(url), textSegment('收藏这个')],
            time: nowSeconds()
        });
        await env.oneBot.waitForGroupSendCount(1001, 1);

        const request = env.openAI.requests.find(item =>
            item.serialized.includes('表情包收藏已达上限 0 张'));
        assert.ok(request, '收藏数量达到上限时应返回失败提示');
        assert.deepEqual(stickerList(env), []);
    });
});

test('压缩后在会话头部注入表情包收藏列表', {timeout: 180000}, async () => {
    const summary = '群总体印象：测试群';
    await runScenario({
        name: 'sticker-session-header',
        groups: [1001],
        contextWindow: 150,
        compactContextRatio: 0.8,
        compactMaxChars: 100,
        channels: {
            vision: [{action: {type: 'text', text: '一只带问号的小狗表情包'}}],
            primary: [
                {
                    action: {
                        type: 'toolCall',
                        name: 'add_sticker',
                        arguments: {image_id: 1, category: '疑惑', note: '带问号的小狗'}
                    }
                },
                {
                    action: {
                        type: 'replyTool',
                        params: {messages: [{text: '第一轮回复'}], requires_deep_research: false}
                    }
                },
                {action: {type: 'text', text: summary}},
                {
                    action: {
                        type: 'replyTool',
                        params: {messages: [{text: '第二轮回复'}], requires_deep_research: false}
                    }
                },
                {action: {type: 'text', text: summary}}
            ]
        }
    }, async env => {
        const url = env.assets.serveFixture('image-a.png');
        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), imageSegment(url), textSegment('收藏这个')],
            time: nowSeconds()
        });
        await env.oneBot.waitForGroupSendCount(1001, 1);

        const firstRequest = env.openAI.requests.filter(request => request.model === 'primary')[0];
        assert.match(firstRequest.serialized, /以下是本群历史收藏的表情包/);
        assert.match(firstRequest.serialized, /（内容为空）/);

        const initialMetadata = env.db.harnessMetadata(1001);
        assert.ok(initialMetadata);
        await waitFor(() => {
            const current = env.db.harnessMetadata(1001);
            return current !== undefined && current.path !== initialMetadata.path;
        }, {
            description: '压缩后更换会话',
            timeoutMs: 20000
        });

        const compactedMetadata = env.db.harnessMetadata(1001);
        assert.ok(compactedMetadata);
        const header = sessionHeaderText(compactedMetadata.path);
        assert.match(header, /以下是本群历史收藏的表情包/);
        assert.match(header, /带问号的小狗/);
        assert.match(header, /当前对话中新收藏的表情不会立刻写入这里/);

        env.oneBot.emitGroupMessage({
            groupId: 1001,
            segments: [atSegment(10000), textSegment('第二轮消息')],
            time: nowSeconds()
        });
        await env.oneBot.waitForGroupSendCount(1001, 2);

        const secondRequest = env.openAI.requests.find(request =>
            request.serialized.includes('第二轮消息'));
        assert.ok(secondRequest);
        assert.match(secondRequest.serialized, /带问号的小狗/);
    });
});
