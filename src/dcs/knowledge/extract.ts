/**
 * dcs/knowledge/extract.ts — 文档正文提取（本地，第一版支持 MD/TXT/DOCX/PDF）。
 *
 * - Markdown / TXT：直接读取 UTF-8 文本。
 * - DOCX：mammoth 提取纯文本（保留段落换行）。
 * - PDF：pdf-parse 提取可提取文字；扫描版/无文字 PDF → 明确错误（不算导入成功）。
 * - 旧版 .doc：不支持，明确提示转换成 DOCX。
 *
 * 不做 OCR；提取失败抛 ExtractError，由 ingest 上层按文件粒度处理。
 */
import * as fs from "node:fs";
import * as path from "node:path";

export class ExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractError";
  }
}

/** 分页文本：PDF 按页返回（页码 1 起，index+1）；其他格式单页（无页码）。 */
export interface ExtractedText {
  /** 每页文本；非 PDF 为单元素（pages[0] 为全文，无页码）。 */
  pages: string[];
  /** 是否有可靠页码（仅 PDF）。 */
  hasPages: boolean;
}

/** 归一化为带页码的页列表（分块输入）。 */
export function toPages(extracted: ExtractedText): Array<{ text: string; page?: number }> {
  return extracted.pages.map((text, i) => ({
    text,
    page: extracted.hasPages ? i + 1 : undefined,
  }));
}

export const SUPPORTED_EXTENSIONS = [".md", ".txt", ".docx", ".pdf"] as const;
export type SupportedExtension = (typeof SUPPORTED_EXTENSIONS)[number];

export function isSupportedFile(fileName: string): boolean {
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(path.extname(fileName).toLowerCase());
}

export async function extractText(filePath: string): Promise<ExtractedText> {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".md":
    case ".txt": {
      const content = fs.readFileSync(filePath, "utf8");
      if (content.trim().length === 0) throw new ExtractError("文档内容为空（未提取到正文）");
      return { pages: [content], hasPages: false };
    }
    case ".doc": {
      // 旧版二进制格式：mammoth 不支持；明确引导转换，不当成功导入
      throw new ExtractError("暂不支持旧版 .doc，请先用 Word/WPS 转存为 .docx 后再导入");
    }
    case ".docx": {
      const mammoth = await import("mammoth");
      const buf = fs.readFileSync(filePath);
      const result = await mammoth.extractRawText({ buffer: buf });
      const text = result.value ?? "";
      if (text.trim().length === 0) throw new ExtractError("DOCX 未提取到正文（可能为空文档或纯图片）");
      return { pages: [text], hasPages: false };
    }
    case ".pdf": {
      const { PDFParse } = await import("pdf-parse");
      const buf = fs.readFileSync(filePath);
      const parser = new PDFParse({ data: buf });
      try {
        const result = await parser.getText();
        // v2 逐页文本（pages:[{num,text}]）：页码可靠，分块时如实保留
        const pages = result.pages.map((p) => p.text ?? "");
        if (pages.every((t) => t.trim().length === 0)) {
          throw new ExtractError("PDF 未提取到文字（可能为扫描版/图片型 PDF，第一版暂不支持 OCR）");
        }
        return { pages, hasPages: true };
      } finally {
        await parser.destroy().catch(() => undefined);
      }
    }
    default:
      throw new ExtractError(`不支持的文件类型：${ext || "(无扩展名)"}`);
  }
}
