---
name: codex-dsh-collab
description: 通过本工具的原生 DSH 控制器启动、继续、查看和停止 Codex 与 DeepSeek Harness 协作；由当前 Codex 对话规划验收，完整原生 DSH 执行任务。
---

读取工具仓库的 docs/manuals/codex-guide.md；本仓库中的本文件位于 .agents/skills/codex-dsh-collab。若 Skill 已复制到个人目录，先定位工具仓库，不能把个人 Skill 目录误当工具根。不以旧研究探针代替产品 CLI。

先取得目标项目绝对路径、目标、范围、验收条件和原生 Host 连接。只缺少实际必需信息时询问；已授权的例行步骤自主执行。令牌通过本地标准输入传给 attach，不要求用户粘贴到聊天。

用工具仓库 bin/codex-dsh.mjs 调用 CLI，统一 --state-dir 绝对路径。一个 Host 使用同一状态目录；新任务 start，继续先 resume。原生模型工作必须在用户任务/费用授权内 send --allow-model；工具无总费用硬上限。

循环：发送具体合同 → follow 接收匹配请求的状态 → 读取 resultFile 与真实文件/测试验收 → 新请求追修。COMPLETED 只是一轮结束。观察超时继续观察；通信不明先恢复，不盲目重投。由 Codex 持续决策，无需用户逐轮传话；不要承诺对话关闭或配额耗尽后仍有主控常驻服务。

审批遵循用户权限与原生流程，保持 watcher 有效，核对具体操作后决定。原生部署若绕过审批，不能宣称控制器补回了它。

收到停止，停止派发并调用 stop；无法证明后台/子树静止则明确 STOP_PENDING。不要杀共享 Host、归档会话或删除提醒。每阶段透明汇报 DSH 行为、Codex 验收、下一步和未确认项。

保留原生配置、UI、上下文、工具、skills、MCP 和子 Agent 执行链。CLI 不提供文件沙箱或事务接收，真实项目遵循其本身的隔离/合入规则。
