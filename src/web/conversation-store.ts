import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentMessage } from "../core/types.ts";
export interface DisplayMessage {
    kind?: "process" | "answer" | "selection";
    id: string;
    role: "user" | "assistant";
    content: string;
}
export interface DisplayTool {
    messageId?: string;
    candidates?: { title: string; path: string }[];
    key: string;
    name: string;
    status: "running" | "success" | "error" | "selection";
}
export interface Conversation {
    id: string;
    loginId: string;
    title: string;
    updatedAt: number;
    messages: DisplayMessage[];
    tools: DisplayTool[];
    context: AgentMessage[];
    runId: string | null;
}
export function validContext(messages: AgentMessage[]): boolean {
    const pending = new Set<string>();
    for (const m of messages) {
        if (!m || typeof m.content !== "string")
            return false;
        if (m.role === "assistant") {
            if (pending.size)
                return false;
            for (const t of m.toolCalls ?? []) {
                if (!t.id || pending.has(t.id))
                    return false;
                pending.add(t.id);
            }
        }
        else if (m.role === "toolResult") {
            if (!pending.delete(m.toolCallId))
                return false;
        }
        else if (m.role !== "user" || pending.size)
            return false;
    }
    return pending.size === 0;
}
export class ConversationStore {
    private db: DatabaseSync;
    constructor(file: string, idleMs = 30 * 60_000) {
        if (file !== ":memory:")
            mkdirSync(dirname(file), { recursive: true });
        this.db = new DatabaseSync(file);
        this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA secure_delete=OFF; PRAGMA journal_mode=DELETE;
      CREATE TABLE IF NOT EXISTS logins(id TEXT PRIMARY KEY, employee TEXT NOT NULL, valid INTEGER NOT NULL, recent TEXT, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, login TEXT NOT NULL REFERENCES logins(id), title TEXT NOT NULL,
        created INTEGER NOT NULL, updated INTEGER NOT NULL, messages TEXT NOT NULL, tools TEXT NOT NULL, context TEXT NOT NULL, run TEXT);`);
        // Existing local records keep their ownership; expiry starts from their last stored activity.
        if (!this.db.prepare("PRAGMA table_info(logins)").all().some(r => r.name === "expires")) {
            this.db.exec("ALTER TABLE logins ADD COLUMN expires INTEGER NOT NULL DEFAULT 0");
            this.db.prepare("UPDATE logins SET expires=updated+?").run(idleMs);
        }
        // No automatic replay: retain last complete context, mark persisted partial output interrupted.
        for (const row of this.db.prepare("SELECT * FROM conversations WHERE run IS NOT NULL").all()) {
            const c = this.decode(row);
            c.messages.push({ id: `${c.runId}:interrupted`, role: "assistant", content: "服务重启，本次回复已中断；可以继续提问。" });
            this.finish(c, c.runId!, false);
        }
    }
    deadline(id: string): number { return Number(this.db.prepare("SELECT expires FROM logins WHERE id=? AND valid=1").get(id)?.expires ?? 0); }
    touch(id: string, expires: number) { this.db.prepare("UPDATE logins SET expires=?,updated=? WHERE id=? AND valid=1").run(expires, Date.now(), id); }
    find(employee: string): string | undefined { return this.db.prepare("SELECT id FROM logins WHERE employee=? AND valid=1 ORDER BY updated DESC LIMIT 1").get(employee)?.id as string | undefined; }
    close() { this.db.close(); }
    logins(): {
        id: string;
        employee: string;
    }[] { return this.db.prepare("SELECT id,employee FROM logins WHERE valid=1").all() as unknown as {
        id: string;
        employee: string;
    }[]; }
    knownLogins(): {
        id: string;
        valid: number;
    }[] { return this.db.prepare("SELECT id,valid FROM logins").all() as unknown as {
        id: string;
        valid: number;
    }[]; }
    active(id: string) { return !!this.db.prepare("SELECT 1 FROM logins WHERE id=? AND valid=1").get(id); }
    bind(id: string, employee: string): boolean {
        const prior = this.db.prepare("SELECT * FROM logins WHERE id=?").get(id);
        if (prior)
            return prior.valid === 1 && prior.employee === employee;
        this.db.prepare("INSERT INTO logins(id,employee,valid,recent,updated) VALUES(?,?,1,NULL,?)").run(id, employee, Date.now());
        return true;
    }
    revoke(id: string) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            this.db.prepare("UPDATE logins SET valid=0,recent=NULL,updated=? WHERE id=?").run(Date.now(), id);
            this.db.prepare("DELETE FROM conversations WHERE login=?").run(id);
            this.db.exec("COMMIT");
        }
        catch (e) {
            this.db.exec("ROLLBACK");
            throw e;
        }
    }
    list(login: string) {
        return this.db.prepare("SELECT id,title,updated AS updatedAt FROM conversations WHERE login=? AND EXISTS(SELECT 1 FROM logins WHERE id=? AND valid=1) ORDER BY updated DESC").all(login, login);
    }
    recent(login: string) { return this.db.prepare("SELECT recent FROM logins WHERE id=? AND valid=1").get(login)?.recent ?? null; }
    private decode(r: Record<string, unknown>): Conversation {
        return { id: String(r.id), loginId: String(r.login), title: String(r.title), updatedAt: Number(r.updated),
            messages: JSON.parse(String(r.messages)), tools: JSON.parse(String(r.tools)), context: JSON.parse(String(r.context)), runId: r.run as string | null };
    }
    get(login: string, id: string): Conversation | null {
        const row = this.db.prepare("SELECT * FROM conversations WHERE id=? AND login=? AND EXISTS(SELECT 1 FROM logins WHERE id=? AND valid=1)").get(id, login, login);
        return row ? this.decode(row) : null;
    }
    create(login: string): Conversation {
        if (!this.active(login))
            throw new Error("login inactive");
        const id = randomUUID(), now = Date.now();
        this.db.prepare("INSERT INTO conversations VALUES(?,?,?, ?,?,'[]','[]','[]',NULL)").run(id, login, "新对话", now, now);
        this.select(login, id);
        return this.get(login, id)!;
    }
    select(login: string, id: string) {
        if (!this.get(login, id))
            return false;
        this.db.prepare("UPDATE logins SET recent=?,updated=? WHERE id=? AND valid=1").run(id, Date.now(), login);
        return true;
    }
    delete(login: string, id: string) {
        const r = this.db.prepare("DELETE FROM conversations WHERE id=? AND login=? AND run IS NULL").run(id, login);
        this.db.prepare("UPDATE logins SET recent=NULL WHERE id=? AND recent=?").run(login, id);
        return Number(r.changes) > 0;
    }
    begin(c: Conversation, run: string, question: string) {
        c.messages.push({ id: `${run}:user`, role: "user", content: question });
        if (c.title === "新对话")
            c.title = question.replace(/\s+/g, " ").slice(0, 40);
        c.runId = run;
        const r = this.db.prepare("UPDATE conversations SET messages=?,title=?,run=?,updated=? WHERE id=? AND login=? AND run IS NULL AND EXISTS(SELECT 1 FROM logins WHERE id=? AND valid=1)")
            .run(JSON.stringify(c.messages), c.title, run, Date.now(), c.id, c.loginId, c.loginId);
        if (!Number(r.changes))
            throw new Error("conversation unavailable");
        this.select(c.loginId, c.id);
    }
    save(c: Conversation, run: string) { return this.write(c, run, false, false); }
    finish(c: Conversation, run: string, complete: boolean) { return this.write(c, run, true, complete); }
    private write(c: Conversation, run: string, end: boolean, complete: boolean) {
        if (complete && !validContext(c.context))
            throw new Error("invalid context snapshot");
        if (end)
            c.tools = c.tools.map(t => t.status === "running" ? { ...t, status: "error" } : t);
        const r = this.db.prepare(`UPDATE conversations SET messages=?,tools=?,updated=?,run=?${complete ? ",context=?" : ""}
      WHERE id=? AND login=? AND run=? AND EXISTS(SELECT 1 FROM logins WHERE id=? AND valid=1)`)
            .run(JSON.stringify(c.messages), JSON.stringify(c.tools), Date.now(), end ? null : run, ...(complete ? [JSON.stringify(c.context)] : []), c.id, c.loginId, run, c.loginId);
        return Number(r.changes) > 0; // Never recreate missing/deleted rows.
    }
}
