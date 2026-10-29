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
  /** 仅填写已核对的菜单上下文；缺省时不推测线上菜单关系。 */
  menuContext?: string[];
  verification: { status: "verified" | "unverified"; basis: string; checkedAt: string };
  references: SourceReference[];
}
export interface SourceMap { version: 1; entries: SourceEntry[] }
export interface SourceMatchBasis {
  field: "name" | "alias" | "menuContext" | "page";
  value: string;
  match: "exact" | "query_contains" | "entry_contains";
}
export type SourceCandidate = SourceEntry & { matchBasis: SourceMatchBasis[] };
export const sourceMapPath = () => path.resolve(process.env.DCS_SOURCE_MAP_FILE || "data/harness-v1/source-map.json");

/** 校验只证明已人工登记的定位依据仍存在，不自动推导菜单关系或业务结论。 */
export async function validateSourceEntry(entry: SourceEntry, root = sourceRoot()): Promise<string[]> {
  const issues: string[] = [];
  if (!entry || typeof entry.name !== "string" || !entry.name || !Array.isArray(entry.aliases) ||
    !entry.aliases.every(a => typeof a === "string" && a.length > 0) ||
    (entry.menuContext !== undefined && (!Array.isArray(entry.menuContext) || !entry.menuContext.every(s => typeof s === "string" && s.trim()))) ||
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
  const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  const query = normalize(pattern);
  const valid: SourceCandidate[] = [], rejected: { name: string; issues: string[] }[] = [];
  for (const entry of map.entries) {
    const labels: { field: SourceMatchBasis["field"]; value: string }[] = [
      { field: "name", value: entry.name }, { field: "page", value: entry.page },
      ...(Array.isArray(entry.aliases) ? entry.aliases.map(value => ({ field: "alias" as const, value })) : []),
      ...(Array.isArray(entry.menuContext) ? entry.menuContext.map(value => ({ field: "menuContext" as const, value })) : []),
    ];
    const matchBasis: SourceMatchBasis[] = [];
    for (const { field, value } of labels) {
      if (typeof value !== "string") continue;
      const normalized = normalize(value);
      if (!query || !normalized) continue;
      const match = query === normalized ? "exact" : query.includes(normalized) ? "query_contains" : normalized.includes(query) ? "entry_contains" : undefined;
      if (match) matchBasis.push({ field, value, match });
    }
    if (!matchBasis.length) continue;
    const issues = await validateSourceEntry(entry);
    if (issues.length) rejected.push({ name: entry.name, issues }); else valid.push({ ...entry, matchBasis });
  }
  const items = valid.slice(offset, offset + limit), hasMore = offset + items.length < valid.length;
  return { status: items.length ? "success" : "empty", indexVersion: map.version,
    indexSha256: createHash("sha256").update(bytes).digest("hex"), items, rejected, hasMore,
    nextOffset: hasMore ? offset + items.length : null,
    hint: "索引仅是定位线索；保留全部匹配候选，同名或上下文相近不代表已确定目标。按候选路径缩小directory/glob或使用read_dcs_code读取；无匹配或失效时继续files/text搜索。" };
}
