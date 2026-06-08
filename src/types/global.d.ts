/* eslint-disable no-var */
import type {Db} from '~/db';
import type {DescQueue} from '~/util/desc-queue';
import type {GroupReplyManager} from '~/util/reply-manager';
import {Memory} from 'mem0ai/oss';
import type {AppConfig} from '~/config';

declare global {
    var __db__: Db | undefined;
    var __queue__: DescQueue | undefined;
    var __config__: AppConfig | undefined;
    var __memory__: Memory | undefined;
    var __replyManagers__: Map<number, GroupReplyManager> | undefined;
}

export {};
