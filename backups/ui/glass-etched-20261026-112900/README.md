# DCS Agent UI 存档：磨砂玻璃 + 轻蚀刻版

保存时间：20261026-112900
状态：用户确认存档的当前版本，尚未实施新的乳白喷砂刻字方案。

包含：React 前端 src、现有测试、锁定依赖及 Vite/TypeScript 配置、dist 构建产物、DCS 父页面接入文件 _Likeniu.cshtml、模拟页面效果截图。
不包含 node_modules、环境凭据或 Agent 后端。

当前视觉：18px 背景虚化、细窄折射边、淡蓝阴影、灰蓝标题和图标、输入框及消息卡片轻凹刻边缘。

恢复时：先备份届时的改动，再按需将 DCS Agent.web 内对应文件恢复至 D:\work\DCS Agent.web。DCS shell\_Likeniu.cshtml 对应 D:\work\DCS code\Luxshare.DCS.WebApp\Views\Shared\_Likeniu.cshtml，仅在父页面接入需要回滚时恢复。恢复已存 dist 可直接使用；从源码重建使用 npm ci 和 npm run build。之后在 DCS 主页面 Ctrl+F5 重新打开助手。

SHA256.csv 记录包内文件摘要；preview.png 为模拟页面实测截图。