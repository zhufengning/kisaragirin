import type {Session} from '@earendil-works/pi-agent-core';
import type {JsonlSessionMetadata} from '~/db';
import type {AppConfig, ModelEntry} from '~/config';
import type {Logger} from '@lib/util/logger';
import type {ReplyDebugDumper} from './reply-debug';
import type {GraphitiClient} from './graphiti-client';
import {resolveAssignmentModels} from './models-factory';
import {prompts} from '~/prompts';
import OpenAI from 'openai';
import {JSONRepairError, jsonrepair} from 'jsonrepair';

interface MemoryQueryParams {
    queries: string[];
    entities: string[];
}

/** 从消息文本生成检索关键词并查询 Graphiti，产出注入 prompt 的记忆文本 */
export class MemoryContextBuilder {
    private readonly config: AppConfig;
    private readonly groupId: number;
    private readonly logger: Logger;
    private readonly graphiti: GraphitiClient | null;
    private readonly session: Session<JsonlSessionMetadata>;
    private readonly debug: ReplyDebugDumper;

    constructor (options: {
        config: AppConfig;
        groupId: number;
        logger: Logger;
        graphiti: GraphitiClient | null;
        session: Session<JsonlSessionMetadata>;
        debug: ReplyDebugDumper;
    }) {
        this.config = options.config;
        this.groupId = options.groupId;
        this.logger = options.logger;
        this.graphiti = options.graphiti;
        this.session = options.session;
        this.debug = options.debug;
    }

    /** 记忆自动检索总入口；返回空字符串表示没有可注入的内容 */
    async build (messagesText: string): Promise<string> {
        const existingMemories = await this.extractExistingFacts();
        const queryParams = await this.generateQuery(messagesText, existingMemories);
        if (!queryParams) return '';
        return this.search(queryParams);
    }

    private async generateQuery (
        messagesText: string,
        existingMemories: string[]
    ): Promise<MemoryQueryParams | null> {
        if (!this.config.ai.assignments.memory_keyword) return null;

        const modelEntries = resolveAssignmentModels(this.config, this.config.ai.assignments.memory_keyword);
        const enableEntitySearch = this.config.ai.memoryKeyword?.enable_entity_search ?? false;
        const prompt = this.buildQueryPrompt(messagesText, existingMemories, enableEntitySearch);

        this.debug.dumpMemoryQueryPrompt(prompt);

        const disableThinking = this.config.ai.memoryKeyword?.disable_thinking ?? false;
        if (disableThinking) {
            this.logger.debug(`[ReplyAgent] [${this.groupId}] memory query: disable thinking`);
        }

        // 按回退链依次尝试：API 错误时切换下一个模型
        for (const [index, modelEntry] of modelEntries.entries()) {
            try {
                const response = await this.callKeywordModel(modelEntry, prompt, disableThinking);
                this.debug.dumpMemoryQueryResponse(response);

                const text = response.choices[0]?.message?.content?.trim();
                if (!text) {
                    this.logger.debug(`[ReplyAgent] [${this.groupId}] memory query: empty response`);
                    return null;
                }

                const parsed = this.parseQueryResponse(text, enableEntitySearch);
                if (!parsed) return null;

                this.logger.debug(
                    `[ReplyAgent] [${this.groupId}] memory query: ` +
                    `${parsed.queries.length} queries, ${parsed.entities.length} entities`);
                return parsed;
            } catch (err) {
                this.logger.error(
                    `[ReplyAgent] [${this.groupId}] memory query generation error ` +
                    `(model=${modelEntry.model.id}): ` +
                    `${err instanceof Error ? err.message : String(err)}`);
                if (index < modelEntries.length - 1) {
                    this.logger.warn(
                        `[ReplyAgent] [${this.groupId}] memory query falling back to model ${
                            modelEntries[index + 1].model.id}`);
                }
            }
        }

        return null;
    }

    private buildQueryPrompt (
        messagesText: string,
        existingMemories: string[],
        enableEntitySearch: boolean
    ): string {
        const existingBlock = existingMemories.length > 0 ?
            existingMemories.join('\n') :
            '（无）';
        // 实体搜索未启用时不生成 entities 查询：prompt 中不注入 entities 字段说明
        return prompts.memoryQueryPrompt
            .replace('{entities_field}', enableEntitySearch ? prompts.memoryQueryPromptEntitiesField : '')
            .replace('{existing_memories}', existingBlock)
            .replace('{messages}', messagesText);
    }

    private async callKeywordModel (
        modelEntry: ModelEntry,
        prompt: string,
        disableThinking: boolean
    ): Promise<any> {
        const client = new OpenAI({
            apiKey: modelEntry.apiKey,
            baseURL: modelEntry.model.baseUrl
        });

        const completionBody: any = {
            model: modelEntry.model.id,
            messages: [{role: 'user', content: prompt}],
            temperature: 0
        };
        if (this.config.ai.memoryKeyword?.response_format ?? true) {
            completionBody.response_format = {type: 'json_object'};
        }
        if (disableThinking) {
            completionBody.thinking = {type: 'disabled'};
        }
        return client.chat.completions.create(completionBody);
    }

    private parseQueryResponse (text: string, enableEntitySearch: boolean): MemoryQueryParams | null {
        let parsed: {queries?: unknown; entities?: unknown};
        try {
            parsed = JSON.parse(this.repairJsonText(text));
        } catch {
            this.logger.debug(`[ReplyAgent] [${this.groupId}] memory query: invalid JSON`);
            return null;
        }

        const queries = Array.isArray(parsed.queries) ?
            parsed.queries.filter((q: unknown) => typeof q === 'string' && q.trim()) :
            [];
        const entities = enableEntitySearch && Array.isArray(parsed.entities) ?
            parsed.entities.filter((e: unknown) => typeof e === 'string' && e.trim()) :
            [];

        if (queries.length === 0 && entities.length === 0) {
            this.logger.debug(`[ReplyAgent] [${this.groupId}] memory query: no queries or entities`);
            return null;
        }

        return {queries, entities};
    }

    /** response_format 关闭时端点不保证返回纯 JSON：用 jsonrepair 修复 markdown 围栏与尾随内容 */
    private repairJsonText (text: string): string {
        if (this.config.ai.memoryKeyword?.response_format ?? true) return text;
        try {
            return jsonrepair(text);
        } catch (err) {
            if (!(err instanceof JSONRepairError) || err.position <= 0) throw err;
            // jsonrepair 不接受根值之后的额外内容，按其给出的出错位置截断后重试
            return jsonrepair(text.slice(0, err.position));
        }
    }

    private async search (queryParams: MemoryQueryParams): Promise<string> {
        if (!this.graphiti) return '';

        const groupName = `group-${this.groupId}`;
        const uniqueMemories = new Map<string, string | null>();

        // 搜索自然语言查询（事实）
        for (const query of queryParams.queries) {
            try {
                const results = await this.graphiti.search(query, groupName, 5);
                for (const e of results.results) {
                    if (!uniqueMemories.has(e.fact)) {
                        uniqueMemories.set(e.fact, e.valid_at);
                    }
                }
            } catch (err) {
                this.logger.error(`[ReplyAgent] [${this.groupId}] memory search error for query "${query}":`, err);
            }
        }

        const facts = Array.from(uniqueMemories.entries()).slice(0, 10);
        this.logger.debug(`[ReplyAgent] [${this.groupId}] found ${facts.length} relevant memories`);

        const factLines = facts.map(([fact, validAt]) => {
            const timeInfo = validAt ? ` (${validAt.split('T')[0]})` : '';
            return `- ${fact}${timeInfo}`;
        });

        // 实体搜索关闭时，「--- 记忆自动检索 ---」不分节，仅注入事实列表
        if (!(this.config.ai.memoryKeyword?.enable_entity_search ?? false)) {
            return factLines.join('\n');
        }

        const sections: string[] = [];
        if (facts.length > 0) {
            sections.push(`${prompts.memorySearchFactsHeader}\n${factLines.join('\n')}`);
        }

        const entities = await this.searchEntities(queryParams.entities, groupName);
        if (entities.length > 0) {
            sections.push(
                `${prompts.memorySearchEntitiesHeader}\n${
                    entities.map(([name, summary]) => {
                        if (!summary) return `- ${name}`;
                        const trimmed = summary.length > 200 ? `${summary.slice(0, 200)}…` : summary;
                        return `- ${name}：${trimmed}`;
                    }).join('\n')}`
            );
        }

        return sections.join('\n\n');
    }

    private async searchEntities (
        entityNames: string[],
        groupName: string
    ): Promise<Array<[string, string | null]>> {
        const uniqueEntities = new Map<string, string | null>();
        for (const entity of entityNames) {
            try {
                const nodeResults = await this.graphiti!.searchNodes(entity, groupName, 3);
                for (const node of nodeResults.nodes) {
                    if (!uniqueEntities.has(node.name)) {
                        uniqueEntities.set(node.name, node.summary);
                    }
                }
            } catch (err) {
                this.logger.error(`[ReplyAgent] [${this.groupId}] memory search error for entity "${entity}":`, err);
            }
        }

        const entities = Array.from(uniqueEntities.entries()).slice(0, 10);
        if (entities.length > 0) {
            this.logger.debug(`[ReplyAgent] [${this.groupId}] found ${entities.length} relevant entities`);
        }
        return entities;
    }

    /**
     * 从当前 session 分支中提取已注入的记忆事实。
     * 扫描所有 message entry 中 "记忆自动检索" 分割线之后的内容，
     * 提取以 "- " 开头的记忆条目，用于去重。
     */
    private async extractExistingFacts (): Promise<string[]> {
        const facts: string[] = [];
        try {
            const entries = await this.session.getBranch();
            for (const entry of entries) {
                if (entry.type !== 'message') continue;
                const msg = entry.message;
                if (msg.role !== 'user') continue;
                const text = typeof msg.content === 'string' ?
                    msg.content :
                    msg.content
                        .filter(c => c.type === 'text')
                        .map(c => c.text)
                        .join('');
                const separatorIdx = text.indexOf('--- 记忆自动检索 ---');
                if (separatorIdx === -1) continue;
                const memBlock = text.slice(separatorIdx + '--- 记忆自动检索 ---'.length);
                for (const line of memBlock.split('\n')) {
                    const trimmed = line.trim();
                    if (trimmed.startsWith('- ')) {
                        facts.push(trimmed);
                    }
                }
            }
        } catch {
            // ignore
        }
        return facts;
    }
}
