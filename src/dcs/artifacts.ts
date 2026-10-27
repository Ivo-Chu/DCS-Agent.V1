import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

/** 工具完整结果供read_dcs_result读取。 */
export function toolOutputDirectory(): string {
  return path.resolve(process.env.DCS_TOOL_OUTPUT_DIR || fileURLToPath(new URL("../../data/tool-results/", import.meta.url)));
}

export async function createArtifact(kind: string, extension: string) {
  const directory = toolOutputDirectory();
  await fs.mkdir(directory, { recursive: true });
  const filename = path.join(directory, `${kind}-${randomUUID()}.${extension}`);
  const handle = await fs.open(filename, "wx");
  return { filename, handle };
}
