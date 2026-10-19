---
name: codex-dsh-collab
description: 通过本工具的原生 DSH 控制器启动、继续、查看和停止 Codex 与 DeepSeek Harness 协作；由当前 Codex 对话规划验收，完整原生 DSH 执行任务。
---

先读取本Skill目录中的 `local-settings.json`；若工作区副本没有，则查个人 `$CODEX_HOME/skills/codex-dsh-collab/local-settings.json`（未设CODEX_HOME时为用户主目录下 `.codex/skills/codex-dsh-collab/local-settings.json`）。该文件由 setup 自动生成，包含 toolRoot、stateDir、connection、url，不含令牌或cookie。跨项目使用相同配置，不另建账本。没有配置时：仓库内从本Skill向上三级定位工具；独立安装的Skill应先定位已安装工具或让用户提供安装位置，然后运行 setup，不要求用户手写配置JSON。

通过配置toolRoot读取 docs/manuals/codex-guide.md 并定位 bin/codex-dsh.mjs。仓库/安装路径不是目标项目路径，不能把个人Skill目录或当前业务项目误当工具根。正文不需要本机专用路径；搬迁后从新工具位置重新 setup，沿用原stateDir。不以旧研究探针代替产品 CLI。

先取得目标项目绝对路径、目标、范围、验收条件。用 connections 检查非秘密连接元数据，不完整输出含cookie的state.json。缺少首次连接时用 setup --url URL --token-stdin 或 --token-file 本地文件进行一次初始化；不把令牌放入聊天/URL/配置。setup未鉴权成功或返回authenticationRequired时不能宣称已可发送。连接记录存在不保证Host仍在线；只在配置缺失/歧义或实际鉴权失败时问必要信息，已授权步骤自主执行。

用工具仓库 bin/codex-dsh.mjs 或已安装的 codex-dsh 调用CLI。CLI自动使用个人配置，显式--state-dir可覆盖；继续旧任务必须沿用原账本。一个Host使用同一状态目录；任务ID跨项目取唯一名称，新任务start且--cwd是目标项目绝对路径，继续先resume。原生模型工作必须在用户任务/费用授权内send --allow-model；工具无总费用硬上限。

循环：发送具体合同 → follow 接收匹配请求的状态 → 读取 resultFile 与真实文件/测试验收 → 新请求追修。COMPLETED 只是一轮结束。观察超时继续观察；通信不明先恢复，不盲目重投。由 Codex 持续决策，无需用户逐轮传话；不要承诺对话关闭或配额耗尽后仍有主控常驻服务。

审批遵循用户权限与原生流程，保持 watcher 有效，核对具体操作后决定。原生部署若绕过审批，不能宣称控制器补回了它。

收到停止，停止派发并调用 stop；无法证明后台/子树静止则明确 STOP_PENDING。不要杀共享 Host、归档会话或删除提醒。每阶段透明汇报 DSH 行为、Codex 验收、下一步和未确认项。

保留原生配置、UI、上下文、工具、skills、MCP 和子 Agent 执行链。CLI 不提供文件沙箱或事务接收，真实项目遵循其本身的隔离/合入规则。
