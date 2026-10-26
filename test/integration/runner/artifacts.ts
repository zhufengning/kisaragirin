import {appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

const RUNS_ROOT = resolve('data', 'test-runs');

export class ScenarioArtifacts {
    readonly dir: string;

    constructor (name: string) {
        this.dir = join(RUNS_ROOT, `${name}-${randomUUID().slice(0, 8)}`);
        mkdirSync(join(this.dir, 'data'), {recursive: true});
    }

    path (name: string): string {
        return join(this.dir, name);
    }

    writeJson (name: string, value: unknown): void {
        writeFileSync(this.path(name), `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
    }

    appendJsonl (name: string, value: unknown): void {
        appendFileSync(this.path(name), `${JSON.stringify(value)}\n`, 'utf-8');
    }

    discard (): void {
        if (existsSync(this.dir)) {
            rmSync(this.dir, {recursive: true, force: true});
        }
    }
}
