/* eslint-disable no-var */
import type {Db} from '~/db';
import type {DescQueue} from '~/util/desc-queue';
import type {GroupReplyManager} from '~/util/reply-manager';
import type {GraphitiClient} from '~/util/graphiti-client';
import type {AppConfig} from '~/config';
import type {MutableModels} from '@earendil-works/pi-ai';

declare global {
    var __db__: Db | undefined;
    var __queue__: DescQueue | undefined;
    var __config__: AppConfig | undefined;
    var __graphiti__: GraphitiClient | undefined;
    var __replyManagers__: Map<number, GroupReplyManager> | undefined;
    var __models__: MutableModels | undefined;
}

export {};
