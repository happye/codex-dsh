# Codex ↔ DeepSeek Harness

让当前 Codex 对话通过原生接口发送任务、接收结果、检查状态，再安排下一轮。DSH 继续使用完整原生 Harness；控制器不提供模型代理、不重新实现工具执行器。

版本：0.1.0，薄原生控制层。[验证范围](docs/validation.md)单独记录。

## 一句话开始

在能读取本仓库 Skill 的 Codex 对话中说：

> 使用 $codex-dsh-collab，连接我的原生 DSH，为【项目绝对路径】完成【目标】，按【验收标准】自主协作，每阶段汇报，收到停止指令就停止新派发。

首次需要原生 Host 地址、访问令牌及任务授权；令牌通过标准输入提供，避免写入聊天、命令参数或 Git。之后可说“继续任务 TASK_ID”或“停止任务 TASK_ID”。Skill 不提供脱离活跃 Codex 对话的永久后台调度。

## 准备和运行

需要 Node.js ≥22.19、完整原生 DSH Web Host，以及 Codex 可调用本机命令。当前原生集成验证在 Windows 完成。先以自己的配置启动原生 DSH Web，保留浏览器入口；本工具附加到该 Host。

```powershell
npm ci
node bin/codex-dsh.mjs --help
node bin/codex-dsh.mjs attach --name native --url http://127.0.0.1:PORT --token-stdin
node bin/codex-dsh.mjs start --connection native --cwd C:\work\project --task demo
node bin/codex-dsh.mjs send --task demo --text-file C:\work\task.txt --allow-model --wait 60
node bin/codex-dsh.mjs status --task demo
node bin/codex-dsh.mjs follow --task demo --wait 60
node bin/codex-dsh.mjs resume --task demo
node bin/codex-dsh.mjs stop --task demo
```

将 PORT、项目和提示文件替换为实际值。attach 等待一行令牌输入。所有命令使用同一工作目录或同一绝对 `--state-dir`；默认私有账本是当前目录的 `.codex-dsh/`。`send` 会启动原生模型工作；`--allow-model` 代表调用者已取得任务及费用授权，不是费用硬上限。

start 默认创建任务专属原生会话；附加已有会话使用共享停止语义。JSON 返回状态及完整答复的 resultFile，Codex 读取答复和实际交付物后决定下一轮。COMPLETED 仅代表该轮次结束，不代表项目验收通过。

## 原生边界

模型、上下文整理、输出参数、工具、skills、MCP、子 Agent、配置和权限由 DSH 决定。控制器不覆盖 profile，不增加实验中的 8192 输出或 1 MiB WebSocket 限制。它不是操作系统沙箱，也不保证原生所有功能均已逐项验收。

超时仅结束观察，不取消原生任务；断线后先 resume / follow，禁止盲目重投。STOP_PENDING 表示已阻止新派发，但未能证明所有原生活动停止；不杀共享 Host，不以归档或删除提醒实现停止。原生 UI 保留用于观察和接管。

## 文档与验证

- [用户手册](docs/manuals/user-guide.md)：日常协作、费用、停止和故障处理。
- [Codex 手册](docs/manuals/codex-guide.md)：命令、状态、审批和循环决策。
- [流程图与技术说明](docs/architecture.md) · [Mermaid 源文件](docs/architecture.mmd)。
- [协作 Skill](.agents/skills/codex-dsh-collab/SKILL.md) · [验证范围](docs/validation.md)。

```powershell
npm test
npm run check
$env:DSH_ROOT = 'C:\path\to\deepseek-harness'
npm run test:native
```

原生测试使用隔离 home/cwd 和本机模拟提供方，不使用真实密钥；要求 Windows、Python 3 和已构建原生安装。发布内容不包含私人研究日志、会话、凭证或其他项目资产。
