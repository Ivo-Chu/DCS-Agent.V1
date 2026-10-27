import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

export type LogRecord = Record<string, any>;

export async function logFiles(root: string, prefix = ""): Promise<string[]> {
    const entries = await readdir(path.join(root, prefix), { withFileTypes: true }).catch((e) => {
        if (e.code === "ENOENT") return [];
        throw e;
    });
    const groups = await Promise.all(entries.map(e => {
        const relative = path.posix.join(prefix, e.name);
        return e.isDirectory() ? logFiles(root, relative) :
            Promise.resolve(e.isFile() && e.name.endsWith(".jsonl") ? [relative] : []);
    }));
    return groups.flat();
}

export async function readLog(root: string, file: string) {
    const text = await readFile(path.join(root, file), "utf8");
    const records: LogRecord[] = [];
    let skippedLines = 0;
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
            const value = JSON.parse(line);
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
            records.push(value);
        } catch { skippedLines++; }
    }
    return { records, skippedLines };
}

export async function listLogs(root: string) {
    const items = await Promise.all((await logFiles(root)).map(async file => {
        try {
            const { records } = await readLog(root, file);
            const start = records.find(r => r.event === "run_start");
            const input = records.find(r => r.event === "model_call_start");
            const end = records.find(r => r.event === "run_end");
            const messages = Array.isArray(input?.contextMessages) ? input.contextMessages : [];
            const question = [...messages].reverse().find(m => m.role === "user")?.content;
            return { file, runId: start?.runId ?? file, timestamp: start?.timestamp ?? "",
                channel: start?.channel ?? "未记录", model: start?.model ?? "未记录",
                question: typeof question === "string" ? question.slice(0, 120) : "问题未记录",
                reason: end?.reason ?? "尚无结束记录", turns: records.filter(r => r.event === "model_call_start").length };
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw e;
        }
    }));
    return items.filter(i => i !== null).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}
