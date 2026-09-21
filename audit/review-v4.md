# GLM 修复全面复审（第三轮 · 独立复核）

- 审查日期：2026-09-21
- 审查对象：GLM 针对 F1–F6 的代码修复（`D:\Projects\DCS Agent.V1`）
- 审查依据：原 14 节方案、`audit/review.md`（第一轮）、`audit/review-v2.md`（第二轮）、`audit/review-v3.md`（astra 第三轮）
- 审查方式：只审不改。源码/测试/配置零改动；复现脚本在系统临时目录执行后已删除

---

## 一、总结论

**修复质量高：改动范围精准、回归测试扎实，原六项缺陷经独立复跑全部确认已修。但 review-v3 提出的 R1–R5 残留问题经核验全部成立，真实 DeepSeek 验收仍未执行——本轮不能签收，需再修一轮 R1–R5 后跑真实 key 验收。**

---

## 二、改动范围核查（精准，无越界）

依据文件修改时间与内容比对，GLM 仅修改：

| 文件 | 对应修复 |
|---|---|
| `src/core/model/deepseek.ts` | F1（SSE 错误编码） |
| `src/core/agent-loop.ts` | F2 / F3 / F6 |
| `src/index.ts` | F5（CLI 展示层）+ PowerShell 提示 |
| `test/smoke.ts` | 新增 H / I / J 回归场景（42 → 63 项） |
| `test/acceptance.ts` | 证据边界声明 + 显式断言 + 追问数据源修正 |
| `test/deepseek-live.ts` | 严格 PASS / FAIL / SKIPPED 判定 |
| `test/acceptance-live.ts`（新增） | 真实 DeepSeek 三问验收脚本 |
| `package.json` / `README.md` | 新 script、修复记录 |

未触碰：`dcs/` 全层、`core/types.ts`、`core/events.ts`、`core/agent.ts`。零新增依赖，无范围外能力引入。

---

## 三、原六项缺陷逐项复核（独立复跑，非引用 GLM 自测）

| 缺陷 | GLM 的修法 | 独立复跑结果 |
|---|---|---|
| F1 SSE 误判 stop | 坏帧置 badFrame → error；无 finish_reason 的 EOF → error；心跳/注释/空行可忽略 | ✅ 坏 JSON + 截断流事件流 = `message_end:error` |
| F2 残缺 toolCalls 污染历史 | 非 toolCalls 完成时剥离片段（不执行、不入历史），length 附截断说明 | ✅ 剥离确认，content 含"截断…已丢弃" |
| F3 maxTurns 空答案 | 耗尽时生成明确终止说明写入 AssistantMessage，文本/事件/历史一致 | ✅ finalText = "已达最大执行轮次（1 轮）…" |
| F4 测试误报 | live 严格 PASS/FAIL/SKIPPED；acceptance 声明证据边界 + 显式断言 42/35/7/驳回；新增 acceptance-live.ts | ✅ 无 key 时两个 live 脚本均诚实报 SKIPPED |
| F5 CLI 泄源码路径 | 展示层对 search_dcs_code 成功摘要显示"内部检索已完成" | ⚠️ 摘要已堵，参数通道仍开（见 R4） |
| F6 Hook 异常 | afterToolCall 失败 → 丢弃原文换安全 error ToolResult；beforeToolCall 抛错 → 按"阻止"处理 | ✅ 两条路径均符合，prompt 不再 reject |

---

## 四、测试体系升级评价

- 冒烟 42 → **63 项**（新增 H：SSE 边界 5 项、I：length 截断 6 项、J：Hook 异常 7 项），实跑 **63/63 通过**
- H5 亮点：完成标志之后的坏帧同样判流损坏，口径严于审查建议
- acceptance.ts：追问轮改为调用餐标配置工具，答案数据均有真实 ToolResult 来源，消除"剧本穿越"
- `tsc --noEmit` 通过；acceptance 9 项断言通过；两个 live 脚本无 key 时正确输出 SKIPPED

---

## 五、残留问题 R1–R5（源自 review-v3，本次全部核验成立）

### R1 [P1] acceptance-live 判定仍可被错误回复骗过

位置：`test/acceptance-live.ts:94`、`:106–:112`、`:128–:138`。

只依据 tool_execution_start 事件与回复关键词判定，未检查本轮 agent_error、ToolResult.isError，也未核对场景 2 的 menuName 确为"报餐管理"、dataType 确为"报餐订单"。含"系统管理员/开通"字样的 API 错误文本即可骗过 1c；查错菜单仍可通过 2a 的顺序断言。
核验方式：代码阅读确认无 agent_error / isError 检查逻辑；review-v3 已用本地故障注入实测 exit 0 + PASS 横幅。
建议：每问检查无 agent_error、必要 ToolResult 存在且成功；核对工具参数；增加"错误回复含关键词必须 FAIL"的反例测试。

### R2 [P2] run() 不打印实际回复，证据留存名不副实

位置：`test/acceptance-live.ts:70–:76`。
拿到 reply 只打印换行，结尾却宣称"回复全文见上方日志"。建议直接打印 reply 全文。

### R3 [P2] length 截断说明未接到 CLI，用户仍看到空回答

位置：`src/core/agent-loop.ts:153–:171` 与 `src/index.ts:42–:45`、`:94`。
CLI 只显示 message_delta，忽略 prompt() 返回值；模型只吐工具片段且 length 截断时，补充说明只存在于 assistant_message，用户面对空的"助手>"。（注：maxTurns 终止说明因走 agent_error 通道可显示，length 说明无此通道。）
建议：CLI 显示 Runtime 后补文本，同时避免与已流式内容重复打印。

### R4 [P2] tool_execution_start 明文打印 args，源码路径可从关键词漏出

位置：`src/index.ts:46–:47`。
模型拿上一轮源码结果中的路径/类名当搜索关键词时，参数日志原样输出。成功摘要已隐藏，但参数通道未覆盖。建议员工界面只显示"正在内部检索"类状态，不打印原始参数。

### R5 [P2] 检测到坏帧后可能挂起

位置：`src/core/model/deepseek.ts:163–:164`、`:188–:189`。
badFrame 只 break 内层逐行循环，for-await 需读到下一块数据才执行 `if (badFrame) break`；对端保持连接不发送数据时流程无法到达错误事件。
本次独立复现：构造"立即发坏 JSON、随后保持连接打开"的 ReadableStream，**500ms 后仍未返回错误**。
建议：发现坏帧时带标签 break 外层读取循环；补"坏帧后不 EOF"回归测试（H1/H5 均使用自动结束的字符串 Response，未覆盖此路径）。

---

## 六、本次新发现（review-v3 未覆盖）

1. **README 第 48 行目录树仍写"42 项冒烟测试"**（正文第 204/227 行已为 63）——一处漏改。
2. **EOF 时最后一帧无换行结尾会被静默丢弃** → 误报 error。真实 DeepSeek 帧尾必有 `\n\n` + `[DONE]`，实际不可达；误报 error 属 fail-safe 方向，可接受，记录在案。
3. **`agent-loop.ts:181` 工具执行循环遍历 `toolCalls` 而非 `effectiveToolCalls`**——当前仅在二者等价时可到达，正确性靠巧合维持，建议顺手改齐。

---

## 七、本次独立验证记录

环境：Windows；Node v24.18.0（原生 TS 执行）+ Node v22.22.2（tsc）；无安装、无项目文件变更。

| 检查 | 结果 |
|---|---|
| `tsc --noEmit` | ✅ 通过，exit 0 |
| `test/smoke.ts` | ✅ 63/63 通过 |
| `test/acceptance.ts` | ✅ 3 场景 9 项断言通过（Fake 模型，仅证接线） |
| `test/deepseek-live.ts` | ⏸ SKIPPED（缺 key，未验证） |
| `test/acceptance-live.ts` | ⏸ SKIPPED（缺 key，未验证） |
| 原 F1 场景复跑（坏 JSON + 无 finish_reason EOF） | ✅ 已修复：message_end:error |
| 原 F2 场景复跑（length + 残缺 toolCalls） | ✅ 已修复：片段剥离，附截断说明 |
| 原 F3 场景复跑（maxTurns=1 耗尽） | ✅ 已修复：非空终止说明 |
| 原 F6a 复跑（afterToolCall 抛错） | ✅ 已修复：安全 error ToolResult，isError=true |
| 原 F6b 复跑（beforeToolCall 抛错） | ✅ 已修复：按阻止处理，不 reject |
| R5 复现（坏帧 + 连接保持） | ✅ 复现：500ms 无返回，确认挂起 |
| R1–R4 | ✅ 代码阅读确认成立（与 review-v3 结论一致） |

---

## 八、结论与下一步

**修复有效（90 分），签收仍不行。** 建议顺序：

1. 修 R1：验收判定加 agent_error / isError / 工具参数核对 + 反例测试
2. 修 R2：打印 reply 全文
3. 修 R3 / R4：CLI 员工可见输出全通道收口
4. 修 R5：外层 break + 未关闭流回归测试
5. 顺手处理：README 第 48 行、agent-loop.ts:181 变量名
6. 设置 `DEEPSEEK_API_KEY`，跑 `test:live` + `test:accept:live` + CLI 真实三问，留存证据后签收

一句话带给 GLM：**修缺陷和修"检测缺陷的检测器"是两回事——前者这轮做完了，R1 说明后者还差一锤。**
