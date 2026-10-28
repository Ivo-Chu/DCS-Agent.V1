import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { integer, resolveReadPath, sourceRoot } from "./read-path.ts";

export interface SourceReference {
  path: string; startLine: number; endLine: number; sha256: string;
  role: "route" | "controller" | "view" | "implementation";
}
export interface SourceEntry {
  name: string; aliases: string[]; page: string; controller: string; action: string;
  verification: { status: "verified" | "unverified"; basis: string; checkedAt: string };
  references: SourceReference[];
}
export interface SourceMap { version: 1; entries: SourceEntry[] }
export const sourceMapPath = () => path.resolve(process.env.DCS_SOURCE_MAP_FILE || "data/harness-v1/source-map.json");

/** 校验只证明已人工登记的定位依据仍存在，不自动推导菜单关系或业务结论。 */
export async function validateSourceEntry(entry: SourceEntry, root = sourceRoot()): Promise<string[]> {
  const issues: string[] = [];
  if (!entry || typeof entry.name !== "string" || !entry.name || !Array.isArray(entry.aliases) ||
    !entry.aliases.every(a => typeof a === "string" && a.length > 0) ||
    !entry.page || !entry.controller || !entry.action || entry.verification?.status !== "verified" ||
    !entry.verification.basis || !Number.isFinite(Date.parse(entry.verification.checkedAt))) issues.push("unverified_mapping");
  if (!Array.isArray(entry?.references) || !entry.references.length) return [...issues, "missing_references"];
  for (const role of ["route", "controller", "view"]) {
    if (!entry.references.some(r => r.role === role)) issues.push(`missing_${role}`);
  }
  for (const ref of entry.references) {
    try {
      if (typeof ref.path !== "string" || path.isAbsolute(ref.path)) throw new Error("relative_path_required");
      const file = await resolveReadPath(root, ref.path);
      const content = await fs.readFile(file);
      const lines = content.toString("utf8").split(/\r?\n/);
      if (!integer(ref.startLine, 1, lines.length) || !integer(ref.endLine, ref.startLine, lines.length)) throw new Error("invalid_lines");
      if (!/^[a-f0-9]{64}$/.test(ref.sha256) || createHash("sha256").update(content).digest("hex") !== ref.sha256) throw new Error("source_changed");
    } catch (e) { issues.push(`${ref.path}: ${String(e)}`); }
  }
  return issues;
}

export async function searchSourceMap(pattern: string, offset: number, limit: number) {
  let bytes: Buffer;
  try { bytes = await fs.readFile(sourceMapPath()); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return { status: "empty", items: [], hasMore: false, nextOffset: null, reason: "index_not_configured", hint: "继续使用files/text搜索。" };
  }
  const map: SourceMap = JSON.parse(bytes.toString("utf8"));
  if (map.version !== 1 || !Array.isArray(map.entries)) throw new Error("unsupported_source_map");
  const query = pattern.trim().toLocaleLowerCase();
  const candidates = map.entries.filter(e => [e.name, ...(Array.isArray(e.aliases) ? e.aliases : [])]
    .some(s => typeof s === "string" && s.toLocaleLowerCase().includes(query)));
  const valid: SourceEntry[] = [], rejected: { name: string; issues: string[] }[] = [];
  for (const entry of candidates) {
    const issues = await validateSourceEntry(entry);
    if (issues.length) rejected.push({ name: entry.name, issues }); else valid.push(entry);
  }
  const items = valid.slice(offset, offset + limit), hasMore = offset + items.length < valid.length;
  return { status: items.length ? "success" : "empty", indexVersion: map.version,
    indexSha256: createHash("sha256").update(bytes).digest("hex"), items, rejected, hasMore,
    nextOffset: hasMore ? offset + items.length : null,
    hint: "索引仅是定位线索；使用read_dcs_code核实实际实现。无匹配或失效时继续files/text搜索。" };
}
