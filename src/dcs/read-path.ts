import { promises as fs } from "node:fs";
import path from "node:path";

/** 所有模型指定的读取路径都必须解析到配置目录内部。 */
export async function resolveReadPath(root: string, requested: string): Promise<string> {
  if (typeof requested !== "string" || !requested.trim() || requested.includes("\0")) throw new Error("路径不能为空。");
  const base = await fs.realpath(root);
  const target = path.resolve(base, requested);
  const inside = (p: string) => {
    const relative = path.relative(base, p);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  if (!inside(target)) throw new Error("路径超出允许读取的目录。");
  const real = await fs.realpath(target);
  if (!inside(real)) throw new Error("链接指向允许读取目录之外。");
  return real;
}

export function sourceRoot(): string { return path.resolve(process.env.DCS_SOURCE_ROOT || process.cwd()); }
export function validKeys(value: unknown, keys: string[]): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k));
}
export function integer(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
}
