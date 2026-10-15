import {Cron, type CronOptions} from 'croner';
import type {AppConfig, ScheduledGroupTask} from '~/config';
import type {GroupReplyManager} from './reply-manager';
import type {ScheduledReplyTask} from './reply-task';
import {Logger} from '@lib/util/logger';

interface ScheduledJobRecord {
    groupId: number;
    taskName: string;
    job: Cron;
}

export class ScheduledTaskManager {
    private config: AppConfig;
    private getReplyManager: (groupId: number) => Promise<GroupReplyManager | undefined>;
    private logger: Logger;
    private jobs: ScheduledJobRecord[] = [];

    constructor (
        config: AppConfig,
        getReplyManager: (groupId: number) => Promise<GroupReplyManager | undefined>,
    ) {
        this.config = config;
        this.getReplyManager = getReplyManager;
        this.logger = new Logger();
    }

    start (): void {
        if (this.jobs.length > 0) {
            this.logger.warn('[ScheduledTasks] already started, skip duplicate start');
            return;
        }

        const tasksByGroup = this.config.input.scheduled_tasks;
        if (!tasksByGroup) {
            this.logger.debug('[ScheduledTasks] no scheduled tasks configured');
            return;
        }

        for (const [groupIdText, tasks] of Object.entries(tasksByGroup)) {
            const groupId = Number(groupIdText);
            if (!Number.isInteger(groupId)) {
                this.logger.warn(`[ScheduledTasks] invalid group id "${groupIdText}", skipped`);
                continue;
            }

            if (!this.config.input.group_whitelist.includes(groupId)) {
                this.logger.warn(
                    `[ScheduledTasks] group ${groupId} is not in group_whitelist, scheduled tasks skipped`);
                continue;
            }

            tasks.forEach((task, index) => this.scheduleTask(groupId, task, index));
        }

        this.logger.info(`[ScheduledTasks] started ${this.jobs.length} job(s)`);
    }

    stop (): void {
        for (const {job} of this.jobs) {
            job.stop();
        }
        this.logger.info(`[ScheduledTasks] stopped ${this.jobs.length} job(s)`);
        this.jobs = [];
    }

    private scheduleTask (groupId: number, task: ScheduledGroupTask, index: number): void {
        if (task.enabled === false) {
            this.logger.debug(`[ScheduledTasks] [${groupId}] task ${index + 1} disabled`);
            return;
        }

        const taskName = task.name || `task-${index + 1}`;
        const cron = task.cron.trim();
        const prompt = task.prompt.trim();
        if (!cron || !prompt) {
            this.logger.warn(
                `[ScheduledTasks] [${groupId}] task "${taskName}" skipped: empty cron or prompt`);
            return;
        }

        const replyTask: ScheduledReplyTask = {
            name: taskName,
            prompt,
            deepResearchTopic: task.deep_research_topic?.trim() || undefined
        };

        const options: CronOptions = {
            name: `group-${groupId}-${taskName}`,
            timezone: task.timezone,
            protect: () => {
                this.logger.warn(
                    `[ScheduledTasks] [${groupId}] task "${taskName}" skipped: previous run still active`);
            },
            catch: err => {
                this.logger.error(`[ScheduledTasks] [${groupId}] task "${taskName}" failed:`, err);
            }
        };

        try {
            const job = new Cron(cron, options, async () => {
                const manager = await this.getReplyManager(groupId);
                if (!manager) {
                    this.logger.warn(
                        `[ScheduledTasks] [${groupId}] task "${taskName}" skipped: reply manager unavailable`);
                    return;
                }
                await manager.triggerScheduledReply(replyTask);
            });

            this.jobs.push({groupId, taskName, job});
            const nextRun = job.nextRun();
            this.logger.info(
                `[ScheduledTasks] [${groupId}] task "${taskName}" scheduled, nextRun=` +
                `${nextRun ? nextRun.toISOString() : 'none'}`);
        } catch (err) {
            this.logger.error(`[ScheduledTasks] [${groupId}] task "${taskName}" schedule failed:`, err);
        }
    }
}
