import test from 'node:test';
import assert from 'node:assert/strict';
import {ScheduledTaskManager} from '../../../src/util/scheduled-tasks';
import type {GroupReplyManager} from '../../../src/util/reply-manager';
import {createTestConfig} from '../app/create-test-config';
import type {ScheduledGroupTask} from '../../../src/config';
import {sleep} from '../runner/wait-for';

interface JobHandle {
    nextRun: () => Date | null;
}

interface ManagerJobs {
    jobs: {job: JobHandle}[];
}

function makeManager (scheduledTasks?: Record<number, ScheduledGroupTask[]>) {
    const config = createTestConfig({
        onebotHost: '127.0.0.1',
        onebotPort: 0,
        openAiBaseUrl: 'http://127.0.0.1:1/v1',
        groups: [100],
        logFile: '',
        scheduledTasks
    });
    return new ScheduledTaskManager(config, async () => undefined);
}

function getJobs (manager: ScheduledTaskManager): JobHandle[] {
    return (manager as unknown as ManagerJobs).jobs.map(record => record.job);
}

test('每日04:00压缩任务按白名单群注册，nextRun为当天或次日04:00', () => {
    const manager = makeManager();
    manager.start();
    try {
        const jobs = getJobs(manager);
        assert.equal(jobs.length, 1);
        const nextRun = jobs[0].nextRun();
        assert.ok(nextRun, 'daily compaction should have a next run');
        const local = new Date(nextRun.getTime() - (nextRun.getTimezoneOffset() * 60000)).toISOString();
        assert.match(local, /T04:00:00/);
    } finally {
        manager.stop();
    }
});

test('带timezone的定时任务nextRun按该时区计算', () => {
    const manager = makeManager({
        100: [{name: 'noon', cron: '0 12 * * *', timezone: 'Asia/Shanghai', prompt: '测试'}]
    });
    manager.start();
    try {
        const jobs = getJobs(manager);
        assert.equal(jobs.length, 2);
        const noon = jobs.find(j => j.nextRun() !== null && j !== jobs[0]) ?? jobs[1];
        const nextRun = noon.nextRun();
        assert.ok(nextRun, 'task should have a next run');
        const shanghai = new Date(nextRun.toLocaleString('en-US', {timeZone: 'Asia/Shanghai'}));
        assert.equal(shanghai.getHours(), 12);
        assert.equal(shanghai.getMinutes(), 0);
    } finally {
        manager.stop();
    }
});

test('永远不会命中的cron表达式注册后nextRun为null且stop不抛出', () => {
    const manager = makeManager({
        100: [{name: 'impossible', cron: '0 0 30 2 *', prompt: '测试'}]
    });
    manager.start();
    try {
        const jobs = getJobs(manager);
        assert.equal(jobs.length, 2);
        const impossible = jobs[1];
        assert.equal(impossible.nextRun(), null);
    } finally {
        manager.stop();
    }
});

test('非法cron表达式不注册任务也不抛出', () => {
    const manager = makeManager({
        100: [{name: 'bad', cron: 'not a cron', prompt: '测试'}]
    });
    manager.start();
    try {
        assert.equal(getJobs(manager).length, 1);
    } finally {
        manager.stop();
    }
});

test('上一次执行未结束时protect跳过重入', async () => {
    let calls = 0;
    const blockingManager = {
        async triggerScheduledReply () {
            calls += 1;
            await sleep(3000);
        }
    } as unknown as GroupReplyManager;

    const config = createTestConfig({
        onebotHost: '127.0.0.1',
        onebotPort: 0,
        openAiBaseUrl: 'http://127.0.0.1:1/v1',
        groups: [100],
        logFile: '',
        scheduledTasks: {
            100: [{name: 'fast', cron: '* * * * * *', prompt: '测试'}]
        }
    });
    const manager = new ScheduledTaskManager(config, async () => blockingManager);
    manager.start();
    try {
        await sleep(3500);
        assert.equal(calls, 1);
    } finally {
        manager.stop();
    }
});
