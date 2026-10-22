---
name: codex-dsh-collab
description: 通过本工具的原生 DSH 控制器启动、继续、查看和停止 Codex 与 DeepSeek Harness 协作；由当前 Codex 对话规划验收，完整原生 DSH 执行任务。
---

先读本Skill目录的local-settings.json；工作区副本没有时，查个人`$CODEX_HOME/skills/codex-dsh-collab/local-settings.json`（未设CODEX_HOME则为`~/.codex/skills/codex-dsh-collab/local-settings.json`）。配置给出toolRoot、stateDir、connection、url，不含凭证；按toolRoot定位bin/codex-dsh.mjs和docs/manuals/codex-guide.md。工具根、项目根和账本目录分别定位，不把项目或Skill目录当工具仓库。

同一电脑跨项目复用个人Skill、工具安装和账本，不逐项目setup或复制仓库。缺少配置时，仓库副本可向上三级定位工具；独立Skill先定位已安装工具，再setup。仅首次认证缺失或实际失效才通过本地token-stdin/token-file补认证，不让用户手写配置JSON或把令牌放进聊天。connections只查非秘密元数据，不代表Host在线；不完整输出state.json。缺少配置、身份有歧义或权限冲突时才问必要信息，已有授权持续有效，不逐轮确认。

新项目先读docs/manuals/user-guide.md的新项目准备：核目标绝对路径、项目规则、目标/允许范围、验收与真实模型费用授权。工程合同executionRoot须为有有效HEAD的Git根；空项目仅在获准初始化范围内建最小基线，已有脏树/未跟踪成果保留。Python和全局npm命令不是桥接CLI的通用前置条件，依项目测试计划准备。

新目标：先查绑定任务和原生workspace，匹配明确才复用；需要时注册workspace并start新会话，记录task/session和账本定位。workspace预先存在不是必要条件，start --cwd也可创建。续工：recover --task或resume同一task/session；忘记ID时tasks按连接/真实cwd/精确标题筛选，歧义明确选择，不猜、不另建、不重投。start --session仅附加尚未绑定的指定会话，不迁移旧cwd或workspace。原生header、cwd身份和获准executionRoot分别核，不改旧头/账本绕门；目录门不是文件沙箱。

工程实施先读docs/manuals/contracts.md，由Codex生成并绑定版本化合同（允许/保护文件、Git基线、完整要求、测试职责和授权引用），不是让用户填写JSON，再send --contract-sha 当前hash。首次全文、后续引用加本轮增量；压缩或不明时重读资产。要求删改必须逐项授权修订；run/receipt/readiness和runtimeInputs等证据规则按合同手册执行，未知执行不重跑。授权真实模型调用不自动授权Git提交、推送或部署，这些按项目既有授权处理。

循环：在任务/费用授权内send --allow-model → follow/listen观察匹配请求 → 读取完整resultFile及实际文件/diff/测试验收 → 新请求追修。COMPLETED只表示轮次结束；超时继续观察，通信不明先恢复而不重投。summary/latest与generation减少重复输出，但不省略审批/错误/停止变化或完整成果验收。usage只代表可见DSH原生计数；一次逻辑send不等于一次提供方请求，不能承诺总费用硬上限或双方省费比例。每阶段报告目标、DSH行为、Codex验收、下一步和未确认项，交接保留task ID。

审批保持同task单一watcher，listen最多60秒并输出JSONL；另一CLI提交有效决定，leaseOpen=false后不复用旧事件。遵循原生权限链，部署绕过审批时不虚构已确认。收到停止，先禁止新send/run/审批并调用stop；观察到外部/未知活动后，自建会话也持久使用共享停止，看cancelSkippedReason，不能按初始exclusive推定独占。无法证明后台/子树静止则STOP_PENDING；不杀共享Host、不archive、不删提醒，不盲目循环cancel。

保留完整原生UI、profile、上下文、工具、skills、MCP及子Agent。当前活跃Codex对话负责规划验收；额度耗尽后的自动接管、常驻调度和循环提醒不属于本项目路线。真实项目隔离/合入依其合同，本工具不提供OS沙箱或事务接收。
