/**
 * dcs/knowledge/chunk.ts — 结构感知分块（本地程序完成，不交给聊天模型）。
 *
 * 规则（2026-09-29 方案 §三）：
 * - 优先按 Markdown 标题 / 空行段落划分；片段保留所属标题链（# 父标题 > 子标题）。
 * - 普通段落目标 600–1000 中文字符；超长按句子切分，相邻片段保留 ~100 字重叠。
 * - 操作步骤（有序/无序列表）尽量同块，避免"前提条件"与"执行步骤"拆开。
 * - 表格（Markdown 表格行）拆分时重复表头。
 * - 分块版本号 CHUNKING_VERSION：与索引配置一起保存，规则变更提示重建索引。
 *
 * 位置信息如实记录：只有 Markdown 标题路径是可靠的（section）；
 * PDF/DOCX 本版不做页级定位，不编造页码（page 为 undefined）。
 */

export const CHUNKING_VERSION = 2; // v2：Embedding/Rerank 输入改为「标题+章节+正文」（2026-09-29 审查修复 3，需重建索引）
/** 普通段落目标分块长度（中文字符）。 */
export const TARGET_CHUNK_CHARS = 800;
/** 段落合并/切分容差：低于最小值时与相邻段落合并。 */
export const MIN_CHUNK_CHARS = 100;
/** 超长文本按句子切分时的相邻片段重叠。 */
export const SENTENCE_OVERLAP_CHARS = 100;
/** 单片段硬上限（保险）。 */
export const MAX_CHUNK_CHARS = 2000;

export interface RawChunk {
  /** 所属标题链（如 "报餐管理 > 取消报餐"），无标题时 undefined。 */
  section?: string;
  /** 可靠页码（本版恒 undefined，不编造）。 */
  page?: number;
  chunkIndex: number;
  content: string;
}

/**
 * 向量化/重排序输入文本（2026-09-29 审查修复 3）：
 * 文档标题 + 章节链 + 正文——长章节尾部片段（如"点击确认"）也能带上下文命中。
 * 展示时仍用 content 原文与出处，不展示此组合文本。
 */
export function embeddingText(documentTitle: string, section: string | null | undefined, content: string): string {
  const parts: string[] = [`《${documentTitle}》`];
  if (section) parts.push(section);
  parts.push(content);
  return parts.join("\n");
}

/** 中文句末标点切分（。！？；保留在句内）。 */
function splitSentences(text: string): string[] {
  const parts = text.split(/(?<=[。！？；!?;\n])/);
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** 超长段落 → 句子滑窗切分（带重叠）。 */
function splitLongText(text: string, section?: string, startPage?: number): { content: string; section?: string; page?: number }[] {
  const sentences = splitSentences(text);
  const out: { content: string; section?: string; page?: number }[] = [];
  let buf: string[] = [];
  let bufLen = 0;
  for (const s of sentences) {
    // 单句超硬上限：按字符硬切（极端防御）
    if (s.length > MAX_CHUNK_CHARS) {
      for (let i = 0; i < s.length; i += MAX_CHUNK_CHARS) {
        out.push({ content: s.slice(i, i + MAX_CHUNK_CHARS), section, page: startPage });
      }
      continue;
    }
    if (bufLen + s.length > TARGET_CHUNK_CHARS && buf.length > 0) {
      out.push({ content: buf.join(""), section, page: startPage });
      // 保留重叠：从尾部回溯 ~100 字的完整句子
      const overlap: string[] = [];
      let overlapLen = 0;
      for (let i = buf.length - 1; i >= 0 && overlapLen < SENTENCE_OVERLAP_CHARS; i--) {
        overlap.unshift(buf[i]);
        overlapLen += buf[i].length;
      }
      buf = [...overlap];
      bufLen = overlapLen;
    }
    buf.push(s);
    bufLen += s.length;
  }
  if (buf.length > 0) out.push({ content: buf.join(""), section, page: startPage });
  return out;
}

/** Markdown 表格块切分：重复表头。 */
function splitTableBlock(lines: string[], section?: string, startPage?: number): { content: string; section?: string; page?: number }[] {
  // lines[0] 表头，lines[1] 分隔行，其后为数据行
  const header = lines.slice(0, 2);
  const dataRows = lines.slice(2);
  if (dataRows.length === 0) return [{ content: lines.join("\n"), section, page: startPage }];
  const out: { content: string; section?: string; page?: number }[] = [];
  let buf: string[] = [];
  let bufLen = header.join("\n").length;
  const flush = (): void => {
    if (buf.length > 0) {
      out.push({ content: [...header, ...buf].join("\n"), section, page: startPage });
      buf = [];
      bufLen = header.join("\n").length;
    }
  };
  for (const row of dataRows) {
    if (bufLen + row.length > TARGET_CHUNK_CHARS) flush();
    buf.push(row);
    bufLen += row.length + 1;
  }
  flush();
  return out;
}

const isTableRow = (line: string): boolean => /^\s*\|.*\|\s*$/.test(line);
const isListItem = (line: string): boolean => /^\s*([-*+]|\d+[.、)])\s+/.test(line);

/**
 * 结构感知分块。输入为带页码的页列表（PDF 每页 page 从 1 起；
 * MD/TXT/DOCX 单页 page 为 undefined——不编造页码）。
 * Markdown 标题语法匹配标题链；PDF/DOCX 纯文本退化为段落合并启发。
 */
export function chunkPages(pages: Array<{ text: string; page?: number }>): RawChunk[] {
  const all: { content: string; section?: string; page?: number }[] = [];
  let sectionPath: string[] = [];
  for (const page of pages) {
    all.push(...chunkSinglePage(page.text, sectionPath, page.page, (sp) => (sectionPath = sp)));
  }
  return all
    .map((p, i) => ({ chunkIndex: i, content: p.content.trim(), section: p.section, page: p.page }))
    .filter((p) => p.content.length > 0);
}

/** 向后兼容：单文本入口（无页码）。 */
export function chunkText(text: string): RawChunk[] {
  return chunkPages([{ text, page: undefined }]);
}

function chunkSinglePage(
  text: string,
  initialSection: string[],
  page: number | undefined,
  setSection: (sp: string[]) => void
): { content: string; section?: string; page?: number }[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  type Block = { content: string; section?: string; page?: number; kind: "para" | "list" | "table" };
  const blocks: Block[] = [];
  let sectionPath = [...initialSection];
  let para: string[] = [];
  let table: string[] = [];
  let list: string[] = [];

  const flushPara = (): void => {
    const content = para.join("\n").trim();
    if (content.length > 0) blocks.push({ content, section: sectionPath.join(" > ") || undefined, kind: "para" });
    para = [];
  };
  const flushTable = (): void => {
    if (table.length >= 2) {
      for (const piece of splitTableBlock(table, sectionPath.join(" > ") || undefined)) {
        blocks.push({ ...piece, kind: "table" });
      }
    } else if (table.length > 0) {
      blocks.push({ content: table.join("\n"), section: sectionPath.join(" > ") || undefined, kind: "para" });
    }
    table = [];
  };
  const flushList = (): void => {
    const content = list.join("\n").trim();
    if (content.length > 0) blocks.push({ content, section: sectionPath.join(" > ") || undefined, kind: "list" });
    list = [];
  };
  const flushAll = (): void => {
    flushPara();
    flushTable();
    flushList();
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    // Markdown 标题：更新当前章节路径（# 一级、## 二级…）
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      const title = heading[2].trim();
      sectionPath = sectionPath.slice(0, level - 1);
      sectionPath[level - 1] = title;
      // 标题本身并入下一块的开头（保块内上下文），不单独成块
      para.push(title);
      continue;
    }
    if (isTableRow(line)) {
      flushPara();
      flushList();
      table.push(line);
      continue;
    }
    flushTable();
    if (isListItem(line)) {
      flushPara();
      list.push(line);
      continue;
    }
    flushList();
    if (line.trim().length === 0) {
      // 空行 = 段落边界
      if (para.length > 0) {
        flushPara();
      }
      continue;
    }
    para.push(line);
  }
  flushAll();
  // 标题路径跨页延续（PDF 长文档章节跨页时保持 section 一致）
  setSection(sectionPath);

  // 相邻块合并（段落太短时与下一块合并，列表与前后说明合并——保步骤完整）
  const merged: { content: string; section?: string; page?: number }[] = [];
  for (const b of blocks) {
    const prev = merged[merged.length - 1];
    const canMerge =
      prev &&
      b.kind !== "table" && // 表格保持独立（表头自成体系）
      prev.section === b.section &&
      prev.content.length < TARGET_CHUNK_CHARS &&
      prev.content.length + b.content.length <= MAX_CHUNK_CHARS;
    if (canMerge && (prev.content.length < MIN_CHUNK_CHARS || b.content.length < MIN_CHUNK_CHARS || b.kind === "list" || b.kind === "para")) {
      // 短段落/列表与相邻块合并；同 section 且合并后不超上限
      if (prev.content.length + b.content.length <= TARGET_CHUNK_CHARS + 200) {
        prev.content = `${prev.content}\n${b.content}`;
        continue;
      }
    }
    merged.push({ content: b.content, section: b.section, page: b.page ?? page });
  }

  // 超长块句子切分
  const pieces: { content: string; section?: string; page?: number }[] = [];
  for (const m of merged) {
    if (m.content.length > MAX_CHUNK_CHARS) {
      pieces.push(...splitLongText(m.content, m.section, m.page ?? page));
    } else {
      pieces.push(m);
    }
  }

  return pieces;
}
