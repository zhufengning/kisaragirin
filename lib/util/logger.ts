import chalk from 'chalk';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const logLevels = ['debug', 'info', 'warn', 'error'];

enum LogLevel {
    DEBUG,
    INFO,
    WARN,
    ERROR
}

let globalLevel: LogLevel = LogLevel.INFO;
let globalFile: string | undefined;

export function configureLogger(level: 'debug' | 'info' | 'warn' | 'error', file?: string) {
    globalLevel = logLevels.indexOf(level);
    globalFile = file;
}

function formatTimestamp(): string {
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function writeToFile(line: string) {
    if (!globalFile) return;
    try {
        mkdirSync(dirname(globalFile), { recursive: true });
        appendFileSync(globalFile, line + '\n');
    } catch {
        // silently ignore file write errors to avoid recursion
    }
}

export class Logger {
    private level: LogLevel;

    constructor(level?: 'debug' | 'info' | 'warn' | 'error') {
        this.level = level !== undefined ? logLevels.indexOf(level) : globalLevel;
        if (this.level < 0) this.level = globalLevel;
    }

    private format(levelName: string, colorFn: (s: string) => string, ...messages: unknown[]): [string, string] {
        const ts = formatTimestamp();
        const prefix = `[${ts}] [${levelName}]`;
        const coloredPrefix = colorFn(prefix);
        const text = messages.map(m => typeof m === 'string' ? m : JSON.stringify(m)).join(' ');
        return [`${coloredPrefix} ${text}`, `${prefix} ${text}`];
    }

    debug (...messages: unknown[]) {
        if (this.level <= LogLevel.DEBUG) {
            const [consoleLine, fileLine] = this.format('DEBUG', chalk.gray, ...messages);
            console.debug(consoleLine);
            writeToFile(fileLine);
        }
    }

    info (...messages: unknown[]) {
        if (this.level <= LogLevel.INFO) {
            const [consoleLine, fileLine] = this.format('INFO', chalk.blue, ...messages);
            console.info(consoleLine);
            writeToFile(fileLine);
        }
    }

    warn (...messages: unknown[]) {
        if (this.level <= LogLevel.WARN) {
            const [consoleLine, fileLine] = this.format('WARN', chalk.yellow, ...messages);
            console.warn(consoleLine);
            writeToFile(fileLine);
        }
    }

    error (...messages: unknown[]) {
        if (this.level <= LogLevel.ERROR) {
            const [consoleLine, fileLine] = this.format('ERROR', chalk.red, ...messages);
            console.error(consoleLine);
            writeToFile(fileLine);
        }
    }
}
