/**
 * 诊断 .env.local 配置格式（不打印任何密钥/URL 值，只输出布尔特征与长度）。
 * 用法：npx tsx scripts/env-diagnose.ts
 */
import * as fs from "node:fs";
import { loadEnvLocal } from "../src/dcs/env-local.ts";

loadEnvLocal();

const key = process.env.DCS_EMBEDDING_API_KEY ?? "";
const url = process.env.DCS_EMBEDDING_URL ?? "";

console.log("== 格式诊断（不含任何敏感值）==");
console.log(`API_KEY 已设置: ${key.length > 0}，长度: ${key.length}`);
console.log(`KEY 含前导/尾随空格: ${key !== key.trim()}`);
console.log(`KEY 含换行/回车: ${/[\r\n]/.test(key)}`);
console.log(`KEY 含引号包裹: ${/^["']|["']$/.test(key)}`);
console.log(`KEY 含中文字符: ${/[\u4e00-\u9fff]/.test(key)}`);
console.log(`URL 已设置: ${url.length > 0}，长度: ${url.length}`);
console.log(`URL 以 https 开头: ${url.startsWith("https://")}`);
console.log(`URL 以 http:// 开头: ${url.startsWith("http://")}`);
console.log(`URL 含空格: ${/\s/.test(url)}`);
console.log(`URL 末尾斜杠: ${/\/$/.test(url)}`);
console.log(`URL 路径部分(不含协议与主机)长度: ${(() => { try { const u = new URL(url); return u.pathname.length; } catch { return -1; } })()}`);
console.log(`文件开头 BOM: ${(() => { const b = fs.readFileSync(".env.local"); return b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf; })()}`);

// 多认证方案探测：用同一个 Key 依次尝试 4 种认证头，看网关认哪种。
// 只输出状态码与特征头，不打印任何敏感值。
if (url && key) {
  console.log("\n== 认证方案探测（每种方案各发 1 条最小请求）==");
  const model = process.env.DCS_EMBEDDING_MODEL ?? "Qwen3-Embedding-8B";
  const body = JSON.stringify({ model, input: ["测试"], encoding_format: "float" });
  const schemes: Array<{ label: string; headers: Record<string, string> }> = [
    { label: "Authorization: Bearer <key>（OpenAI 惯例，当前代码所用）", headers: { Authorization: `Bearer ${key}` } },
    { label: "Authorization: Key <key>（MSE 网关 Key 方案）", headers: { Authorization: `Key ${key}` } },
    { label: "x-api-key: <key>（自定义 header）", headers: { "x-api-key": key } },
    { label: "Authorization: <key>（裸 token）", headers: { Authorization: key } },
  ];
  for (const scheme of schemes) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...scheme.headers },
        body,
      });
      const wwwAuth = res.headers.get("www-authenticate");
      console.log(`[${res.status}] ${scheme.label}${wwwAuth ? `（WWW-Authenticate: ${wwwAuth}）` : ""}`);
      if (res.status !== 401) {
        const text = await res.text();
        console.log(`       响应体(前200字符): ${text.slice(0, 200)}`);
      }
    } catch (err) {
      console.log(`[异常] ${scheme.label}: ${String(err).slice(0, 150)}`);
    }
  }
  console.log("（[200] = 网关接受该方案；[401] = 拒绝；[404/400] 等 = 认证已通过但路径/参数问题）");
}
