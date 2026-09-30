/**
 * dcs/env-local.ts — .env.local 最小加载器（2026-09-29 用户授权接入真实接口）。
 *
 * 规则：
 * - 只在项目根目录 .env.local 存在时生效；KEY=VALUE 逐行解析（# 注释、空行跳过）；
 * - 【系统环境变量优先】：process.env 中已存在的键不被覆盖；
 * - 不覆盖空值行（KEY= 留空视为未填写，跳过——避免空串挡住系统环境变量）；
 * - 任何解析问题静默跳过该行（本文件是便利项，不是必需项）。
 *
 * 使用：各入口（ingest 脚本 / web / CLI / wecom bot / 知识库工具模块加载前）
 * 顶部 import 一次即可。零依赖，不引 dotenv。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let loaded = false;

export function loadEnvLocal(): void {
  if (loaded) return;
  loaded = true;
  const file = path.join(ROOT, ".env.local");
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return; // 文件不存在：全部走系统环境变量，正常
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!key || value.length === 0) continue; // 留空 = 未填写
    if (process.env[key] !== undefined) continue; // 系统环境变量优先
    process.env[key] = value;
  }
}
