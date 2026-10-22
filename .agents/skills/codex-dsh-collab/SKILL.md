---
name: codex-dsh-collab
description: 通过本工具的原生 DSH 控制器启动、继续、查看和停止 Codex 与 DeepSeek Harness 协作；由当前 Codex 对话规划验收，完整原生 DSH 执行任务。
---

先读取本Skill目录中的 `local-settings.json`；若工作区副本没有，则查个人 `$CODEX_HOME/skills/codex-dsh-collab/local-settings.json`（未设CODEX_HOME时为用户主目录下 `.codex/skills/codex-dsh-collab/local-settings.json`）。该文件由 setup 自动生成，包含 toolRoot、stateDir、connection、url，不含令牌或cookie。跨项目使用相同配置，不另建账本。没有配置时：仓库内从本Skill向上三级定位工具；独立安装的Skill应先定位已安装工具或让用户提供安装位置，然后运行 setup，不要求用户手写配置JSON。

通过配置toolRoot读取 docs/manuals/codex-guide.md 并定位 bin/codex-dsh.mjs。仓库/安装路径不是目标项目路径，不能把个人Skill目录或当前业务项目误当工具根。正文不需要本机专用路径；搬迁后从新工具位置重新 setup，沿用原stateDir。不以旧研究探针代替产品 CLI。

先取得目标项目绝对路径、目标、范围、验收条件。用 connections 检查非秘密连接元数据，不完整输出含cookie的state.json。缺少首次连接时用 setup --url URL --token-stdin 或 --token-file 本地文件进行一次初始化；不把令牌放入聊天/URL/配置。setup未鉴权成功或返回authenticationRequired时不能宣称已可发送。连接记录存在不保证Host仍在线；只在配置缺失/歧义或实际鉴权失败时问必要信息，已授权步骤自主执行。

用工具仓库 bin/codex-dsh.mjs 或已安装的 codex-dsh 调用CLI。CLI自动使用个人配置，显式--state-dir可覆盖；继续旧任务沿用原账本。新任务start，cwd为预期原生目录绝对路径；已有任务recover --task或resume。忘记ID时tasks按连接/目录/精确标题查询，recover仅唯一匹配，多候选明确选择，未绑定会话不自动挂靠。附加/恢复/发送会核原生cwd与本地目录身份，缺失或不符不发送，不改旧头/账本绕过。原生cwd与获准临时实施树分开，Git基线/允许范围另核；目录门不是写沙箱。原生模型仅在任务/费用授权内send --allow-model，工具无总费用硬上限。

真实工程先读 toolRoot 下 docs/manuals/contracts.md：以 contract --file 绑定版本化合同、允许文件、Git 基线、完整要求与测试职责，再 send --contract-sha 当前 contractSha。首次该 hash 附完整合同，后续确认后带引用与增量；压缩/上下文不明重读合同资产的 contract 字段。删改 requirement 必须修订并逐项声明决定，不擅开例外。run 依合同 owner/scope/guard/probe 执行，runtimeInputs 必须显式完整列出外部依赖才可复用，[] 仅用于无额外外部依赖；receipt 核真实证据与指纹，repo-full 先过 readiness。不明执行意图 UNKNOWN 禁止重跑或删账本。textFiles 只允许指定 UTF-8 文本 CRLF/LF 内容等价，原始日志/资产仍字节严格。

workspace --connection NAME 列表，加 --cwd ABSOLUTE 注册；start --workspace ID 为新会话绑定工作区，读回目录与成员。旧 session 不迁移，不改旧头绕过。

循环：发送合同与本轮增量 → follow/listen 接收匹配请求的状态 → 读取 resultFile 与真实文件/测试验收 → 新请求追修。COMPLETED 只是一轮结束。观察超时继续观察；通信不明先恢复，不盲目重投。由 Codex 持续决策，无需用户逐轮传话；不要承诺对话关闭或配额耗尽后仍有主控常驻服务。

使用 --view summary/--request latest 与 cursor/generation 做增量观察；generation 包含停止/审批/错误变化，不只看 cursor。usage 只导出本任务原生计数及完整度，不含消息正文，不代表双方费用或节省。

审批遵循用户权限与原生流程，保持单一 watcher 有效，核对具体操作后通过另一 CLI 进程决定。listen 输出 JSONL，最多 60 秒保持审批 lease，leaseOpen=false 后不复用旧事件。原生部署若绕过审批，不能宣称控制器补回了它。

收到停止，禁止新 send/run/审批并调用 stop；无法证明后台/子树静止则明确 STOP_PENDING。读取可用的stopAttempt/stopDiagnostic，取消ack不等于请求终止，历史工具也可能使已中断请求仍报pending；保留不明证据，不自动重投或循环cancel。不要杀共享 Host、归档会话或删除提醒。每阶段透明汇报 DSH 行为、Codex 验收、下一步和未确认项。

0.1.3观察到外部或未知来源的真实输入/队列后，自建会话也永久采取共享停止，不取消外部轮次；看cancelSkippedReason，不以初始exclusive推定当前独占。原生无按request条件取消的原子API。额度中断后的路线读toolRoot下docs/manuals/quota-continuity.md；当前没有常驻接管服务，原生schedule也不能替代Codex验收或绕过停止，不自动创建循环提醒。

保留原生配置、UI、上下文、工具、skills、MCP 和子 Agent 执行链。CLI 不提供文件沙箱或事务接收，真实项目遵循其本身的隔离/合入规则。
