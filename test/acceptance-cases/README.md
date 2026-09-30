# 真实业务验收案例目录

本目录存放**真实业务验收案例**（`npm run test:accept:live` 的输入）。

## 文件

| 文件 | 用途 |
|---|---|
| `cases.example.json` | 案例模板（占位符，不可执行、不计入通过率） |
| `cases.json` | 真实案例（**gitignored**，由你填写真实工号与已核实事实） |
| `reports/` | 运行报告输出目录（JSON + Markdown，gitignored） |

## 填写真实案例

1. 复制模板：`cp cases.example.json cases.json`（或手动创建）
2. 每个案例填入：

```json
{
  "id": "permission-001",
  "conversationId": "employee-a-permission",
  "employeeCode": "<真实测试工号>",
  "question": "<真实问题>",
  "expectedFacts": ["<人工核实的事实，如：该员工拥有XX角色>"],
  "expectedNextAction": "<期望建议，允许留空字符串>",
  "maxDurationMs": 15000
}
```

- `conversationId` 相同的案例**顺序执行并复用同一 Agent**（支持追问场景）；
  不同 conversationId 相互隔离。
- 同一 `conversationId` 内**不得混用不同 `employeeCode`**（脚本会直接 FAILED）。
- `expectedFacts` / `expectedNextAction` 由你**人工核实后填写**——这是业务
  正确性的人工核对依据（脚本只标记 PENDING_REVIEW，不代替人工判断）。
- `employeeCode` 若仍为 `<...>` 占位符，该案例 SKIPPED，不计入通过率。

## 运行

```powershell
# 需已设置：DEEPSEEK_API_KEY、DCS_DB_USER / DCS_DB_PASSWORD / DCS_DB_CONNECT_STRING
npm run test:accept:live
```

运行结束输出：
- 控制台：每案例的 COMPLETED / FAILED / SKIPPED 与 PENDING_REVIEW 标记
- `reports/acceptance-<时间戳>.json`：机器可读完整结果（含实际回答、耗时、
  轮次、工具调用数、工具错误数、停止原因）
- `reports/acceptance-<时间戳>.md`：人工核对用的可读报告
