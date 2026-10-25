# Codex 操作手册

先定位工具仓库绝对路径、用户目标项目和统一的绝对状态目录。保持当前原生 Codex 对话作为主控；不增加模型代理或绕过原生 Harness。按项目权限完成规划、验收和阶段汇报。

跨项目交付时把协作工具仓库与目标项目当作两个独立 Git 仓库。分别核对实际 Git 根、branch、HEAD、origin、现有改动和允许文件；每个仓库按自身合同完成验收与获授权的提交/推送，并分别报告结果。一个仓库的提交不能代表另一个仓库已交付；目标项目要求直接在 main 工作时，按该项目明确指令执行，不擅自套用工具仓库分支策略。

先读个人Skill目录的local-settings.json（由setup生成），字段toolRoot/stateDir/connection/url用于跨工作区定位。CLI自动沿用配置；可用connections列出非秘密元数据，不能完整打印state.json。缺少首次鉴权时运行setup，不能把Skill已安装或配置已存在当作已认证。测试fixture里的连接不可当正式连接复用。不要让用户手写配置JSON或在每个项目重新提供同一stateDir。

## 新项目接入顺序

用户的一句话模板及准备条件以[用户手册](user-guide.md#new-project)为准。用户给目标、范围、验收和必要模型调用授权；以下机械步骤由Codex完成，不要求用户手工填写合同或逐条执行命令。

1. 读个人local-settings，定位工具与原账本；connections查本地元数据，再用原生workspace/状态查询确认实际连通。配置存在不等于已在线；仅缺失/失效才setup，不重新索要已有有效连接凭证。
2. 读目标项目规则，核真实Git根/branch/HEAD、脏树与未跟踪项。工程合同executionRoot必须正好是有HEAD的Git根；空仓库先在允许的初始化范围内建立最小基线，已有成果不得为接入而reset/clean/擅自提交。
3. 查询本项目已有task/workspace。续工恢复原task/session；新目标才start。可复用/注册原生workspace后带--workspace，或直接start --cwd；用户不需要预先提供workspaceId。
4. 工程任务由Codex准备合同JSON，绑定nativeCwd、获准executionRoot、允许文件、要求、测试职责与授权引用，然后send --contract-sha。测试计划尚未确定可暂为空，但不虚构验收通过；Python仅在项目/测试需要时准备。
5. 保持有界观察，按真实产物和证据验收/追修，阶段报告并留下task ID。已有任务和费用授权持续有效，提交/推送/部署不超出项目既有授权。

全局Skill和工具安装无需复制进业务项目；未全局安装codex-dsh命令时，按个人配置toolRoot使用node加bin入口的绝对路径。nativeCwd、executionRoot和state-dir三者不能互相代替；本工具不自动复制候选树或合入改动。

## 命令合同

在工具仓库使用node bin/codex-dsh.mjs，或通过配置toolRoot定位bin，或用已安装的codex-dsh。setup后自动复用个人stateDir；显式--state-dir优先，用于旧任务或隔离测试。无配置时保留旧版当前目录.codex-dsh的兼容行为。完整参数以--help为准。

0.1.4所有命令可选--output-budget-bytes，常规建议16384；缺省/0兼容原结构，超限则为dsh-output/v1，先读summary及关键错误/审批/停止，再核artifactRef与omitted入口。projectionFailed非零退出后恢复核对，不因格式化失败重发已执行的命令。详见[输出预算手册](output-budget.md)。

| 命令 | 用途 |
| --- | --- |
| setup --url URL [--name native] [--token-stdin 或 --token-file FILE] | 安装原样个人Skill，自动生成非秘密定位配置和私有账本；首次鉴权或更新失效凭证 |
| connections | 列出连接名、Host及任务定位元数据；不输出cookie，不等于Host在线检查 |
| tasks --connection NAME [--cwd ABSOLUTE] [--title EXACT_TITLE] [--active] | 联结同Host已绑定任务与原生目录/标题/活动线索；不派发，可更新本地观察账本，不自动绑定未绑定会话 |
| recover --task ID | 核目录并恢复同一任务，不创建或重投 |
| recover --connection NAME [--cwd ABSOLUTE] [--title EXACT_TITLE] [--active] | 唯一候选才恢复；零候选TASK_NOT_FOUND，多候选AMBIGUOUS_TASK及候选ID |
| attach --name NAME --url URL --token-stdin | 读取一行本地令牌，附加现有原生 Host |
| workspace --connection NAME [--cwd ABSOLUTE] | 无 cwd 时列出原生工作区；有 cwd 时注册并读回核验 |
| start --connection NAME --cwd ABSOLUTE --task ID [--workspace ID] | 创建原生任务会话；可选 --title TITLE；workspace 须与 cwd 匹配 |
| start ... --session SESSION_ID | 附加已有会话，按 shared 处理停止 |
| send --task ID --text-file FILE --allow-model [--contract-sha SHA256] --wait 60 | 持久化意图后发原生 prompt；工程任务绑定合同 hash |
| status --task ID | 读原生历史并协调 |
| resume --task ID | 恢复观察，不重放 prompt |
| follow --task ID --wait 60 | 打开原生事件/审批观察窗口 |
| approvals --task ID | 查看本地已接收的有效审批 |
| approve --task ID --approval EVENT_ID --decision allowed-once | 排队单次许可；拒绝用 rejected |
| stop --task ID | 阻止新 send/run/审批并尝试限定范围停止 |
| contract --task ID [--file CONTRACT_JSON] | 无 file 时检查当前合同；有 file 时绑定首版或修订 |
| run --task ID --contract-sha SHA256 --case CASE_ID --owner OWNER [--rerun-reason REASON] | 按合同运行或复用本地测试 |
| receipt --task ID --run RUN_ID | 重新核验回执、原始证据与当前指纹 |
| readiness --task ID --contract-sha SHA256 --review-file REVIEW_JSON | 定向证据有效且 blockers 为空后放行全量 |
| listen --task ID [--wait 60] | JSONL 增量观察并保持有效审批 lease；上限 60 秒 |
| usage --task ID | 导出本任务原生用量，不含消息正文 |

JSON 输出。退出码 0 表示命令成功/取得状态，**不表示任务完成**；2 参数错误，3 状态或冲突，4 通信/原生失败。读取 state、requests、observationTimedOut、stopReason 和 resultFile，而非只看退出码；停止诊断另看 stopAttempt、stopDiagnostic。

## 循环执行

1. 明确目标、允许目录、验收标准、现有未提交修改和费用授权。对真实工程按其合同选择隔离工作树；不要把新原生会话当文件沙箱。工具不会自动复制或接收改动。
2. 新任务在连接后start，记录任务ID、sessionId、状态目录、真实项目根和Git基线。同一任务持续使用原生session；换聊天先recover --task或resume/status，不重复start。忘记task时，用tasks按连接、目录、精确标题筛选，再recover唯一候选；有歧义时选具体ID，不猜。connections仍只列本地定位元数据。
3. 真实工程先按[合同与证据手册](contracts.md)准备 JSON，以 contract --file 绑定，再用 send --contract-sha 返回的 SHA256 派发。首个已确认使用该 hash 的请求附完整合同，后续带合同引用及本轮增量；压缩或上下文不明时须重读合同资产的 contract 字段。--allow-model 只能在已有任务和费用授权内使用，不能据它扩大范围。
4. 常规send/follow使用--wait 60 --view summary --request latest；后续观察传上次cursor/generation。超时而未完成则继续follow，断线才resume/follow，不叠加status或短轮询。审批事件依赖活跃watcher；需实时处理时用listen并通过另一CLI决定。窗口结束后重开有效lease。完整规则及例外见[减少重复读取与等待输出](efficient-collaboration.md)。Watcher不是后台常驻服务；Codex主控不活跃、聊天关闭或额度耗尽时，不保证自动收发事件或安排下一轮。
5. 对已匹配本请求的终态，按requestId/resultSha256读取新resultFile一次，并检查实际文件、diff与相关测试；同路径hash变化或恢复后内容缺失时重读。RUNNING不因cursor变化反复展开全文；用户需要中间结果、审批或排错时定向读取。必要时把具体反例发成下一轮新请求；原生turn完成不代表用户目标完成。
6. 每阶段报告目标、DSH 行为、Codex 验收、下一步、已知费用及未验证边界。任务完成、明确受阻或用户停止时结束派发。

没有自动模型决策守护进程。可以由 Codex 主动重复上述调用；用户不必手动在两端传话。工具没有保证跨 Codex 配额中断的持续主控服务。

<a id="resume-session"></a>
## 新 Codex 聊天与已有会话

用户可以说：“使用 $codex-dsh-collab，继续任务 demo，沿用原状态目录和 DSH 会话；先核对项目根、Git 基线和上轮结果，再按原合同续工。”新聊天先读取个人配置、connections 元数据与项目交接，再执行：

```sh
codex-dsh connections
codex-dsh resume --task demo --view summary --request latest
```

旧任务用了其他账本时，每条命令显式加--state-dir STATE_ABSOLUTE_PATH。该参数不选择DSH工作目录。resume/recover读取历史，不重投旧prompt；恢复后仍须核文件、允许范围和费用授权。tasks/recover只查同Host已绑定任务；标题可改且可缺失，不能作为永久身份。--active为true表示native running或仍有未决请求，false/null不表示产品目标完成。

用户也可以说：“挂靠我指定的已有 DSH 会话 SESSION_ID，在【项目根】继续【目标】，先核对目录、活动和权限。”若该会话已被同一账本绑定，复用原 task 并 resume，不另建 task 重复挂靠。未绑定时，核对原生会话真实 cwd、当前活动及权限后使用：

```sh
codex-dsh start --connection native --cwd PROJECT_ABSOLUTE_PATH --task demo --session SESSION_ID
codex-dsh status --task demo
```

这里的挂靠命令是start --session；attach用于连接Host。传入cwd不会迁移已有会话。0.1.2开始，附加、refresh、watch和实际派发前核原生header ID、cwd realpath和本地目录身份；缺字段或不一致直接拒绝，旧READY账本也重新核验。旧账本没有历史inode可追溯，首次升级只建立当前可验证身份。目录核验不是原子Host/文件系统锁，不替代允许的execution root、Git HEAD与保护文件检查，见[C02](../validation.md#c02)。

## 项目根、原生工作区与 Git 职责

`workspace --connection NAME` 从原生 workspace/follow 基线列出工作区；加 `--cwd ABSOLUTE` 注册工作区并核验返回目录和读回结果。使用返回的 workspaceId 新建：

```sh
codex-dsh workspace --connection native --cwd PROJECT_ABSOLUTE_PATH
codex-dsh start --connection native --cwd PROJECT_ABSOLUTE_PATH --workspace WORKSPACE_ID --task demo
codex-dsh workspace --connection native
```

控制器用 realpath 核 cwd 与工作区目录身份；新建通过原生 session/create 的 workspaceId，随后检查原生 header 与成员关系。没有 --workspace 时保留 cwd 新建方式。旧 session 的 `start --session` 只附加，不迁移；同时传 --workspace 仅核该 session 已属于这个工作区，不能用它补迁移。不能编辑旧头或账本绕过。CLI 读回不等于浏览器视觉验收，UI 工作区也不能代替 Git 根、branch、HEAD 和允许文件核对。

把 DSH 作为受委派的实施 subagent 职责使用；它仍是完整原生 DSH 会话，并未变成 Codex 原生嵌套 subagent。每轮合同至少包含：

- 项目根/工作区、task/session、基线 branch 与 HEAD。
- 允许文件、目标与验收条件、禁止范围、阶段及费用授权。
- `git_owner=Codex`：DSH 在允许文件内实施和验证，保留他人编辑；Git 检查、提交、合并与发布由 Codex 按授权掌握。
- 返回实际变更、实际运行的验证及结果、产物位置、限制和下一步；未运行的检查明确为未验证。

Codex 读取返回和真实 diff，按合同验收；COMPLETED 不等于验收通过。2026-10-21 暮云六轮真实工程已完成一次有限范围的“写入→测试→追修→Codex 独立验收与 Git”闭环，范围见 [工程样本](../validation.md#known-issues)及[后续迭代](../iterations/2026-10-21-0.1.2.md)；不据此推定通用目录门、并发或全部原生功能通过。长期缺陷、功能缺口、待验与能力边界唯一登记在 [已知问题与迭代记录](../validation.md#known-issues)；本地 progress 只保留进度与入口。

## 增量观察与用量

status、resume、follow、send 支持 `--view summary`、`--request latest|REQUEST_ID`、`--since-cursor N`、`--since-generation SHA256`；send 的 request 只允许 latest。默认 summary 选最新请求，counts.requests 仍表示全部请求数。resultFile、resultSha256、resultBytes 用于定位与核验完整答复，摘要不展开正文。保存返回的 cursor 和 generation，下一次继续传入；generation 覆盖本地停止、审批及错误变化，不能只凭原生 cursor 不变跳过处理。changed=false 时 requests 为空，仍检查审批与状态。冷恢复仍读取完整历史协调。

```sh
codex-dsh status --task demo --view summary --request latest
codex-dsh follow --task demo --wait 60 --view summary --since-cursor CURSOR --since-generation GENERATION_SHA256
codex-dsh listen --task demo --wait 60 --request latest
codex-dsh usage --task demo
```

listen 输出 JSON Lines，变化时输出摘要，退出前输出 leaseOpen=false。它保持原生活跃 watcher/审批 lease，最多 60 秒，也可能在终态提前退出；不要收到一条消息就结束进程。每 task 只允许一个 watcher；已有 send --wait/follow/listen 时，不再开第二个。通过另一 CLI 进程查询 approvals/approve；lease 关闭或过期后不能沿用旧事件。程序监听不是模型持续推理，也不是永久主控。

usage 使用 `dsh-usage/v1`，只输出计数、关联、完整度和缺失/冲突说明，没有消息、参数或来源正文。inputTokens 对应非缓存输入；totalInputTokens 为非缓存+缓存读+缓存写，cacheReadRatio 分母为 totalInputTokens。只取每次原生采样的末次 usage，不把流中累计中间样本相加；不明关联及缺失不补零，partial/reportedTotals 不冒充完整 totals。范围是当前任务已记录请求对应的单一原生 session，不是双方总账、提供方账单或节省证明。

## 不明状态和原生审批

SUBMITTING / SUBMISSION_UNKNOWN / UNKNOWN / CREATE_UNKNOWN 不能当作“未执行”。先查原生会话和真实副作用；不自动重投，不删除锁逃避状态。终态 FAILED/ABORTED/INTERRUPTED/REJECTED 也要核对已发生改动。

只处理本任务有效、可理解的原生审批，核对操作说明和用户权限。未知/其他会话交给原生事件链。DECISION_QUEUED 仅是本地决定排队，RESULT_SENT_UNCONFIRMED 也不是原生一定执行或拒绝。watcher 失联后不复用过期事件；原生 UI 可处理有效询问。原生部署绕过询问时，CLI 无法补造审批；向用户说明部署事实。

## 停止

收到停止先调用 stop，禁止后续 send、run 和审批决定。专属会话使用会话级原生取消；共享会话不盲目取消其他用户轮次。无法证明子任务、后台 job、外来轮次、工具或不明提交静止时报告 STOP_PENDING。不要杀共享 Host、archive、删提醒或宣称整棵工作树已停止。

0.1.3起，自建会话一旦观察到外部rpc、外部/未知来源队列或非原生context的未知用户输入，也永久采用共享停止语义：仅移除本任务队列，不调用session/cancel。stopAttempt.cancelSkippedReason说明跳过原因。原生缺少按request/turn做条件取消的API，最后检查之后仍可能有外部输入，这不是服务器排他锁或跨客户端原子保护。

0.1.2本地迭代新增stopAttempt，保留最近一次停止尝试的阶段、时间、cancelRequested、cancelAck及前后活动计数；stopDiagnostic使用固定原因码和安全诊断。cancelAck.accepted只表示原生接收取消，不能代替turn/end、running=false或后台静止证明。before.running为null表示未采集取消前的原生列表；诊断不增加取消前的列表查询。并发调用读取的是任务最新尝试，须按id辨认，不把别次尝试的回执当本次私有结果。出现STOP_REQUEST_RUNNING、STOP_CANCEL_UNKNOWN等，保留账本和原生记录，不自动再次取消或重投prompt。

一个 Host 使用同一状态目录：目录内协调连接别名和任务锁，目录间无全局协调。原生 UI 和外部客户端仍能操作会话，所谓 exclusive 是控制器创建的任务用途，不是服务器排他锁。

额度耗尽后的自动接管、常驻调度与循环提醒不属于本项目路线。Codex中断时不承诺新派发；恢复后先核对原task/session已发生的工作，再按原合同继续，不重放不明请求。

## 技术和验证

[技术说明](../architecture.md)解释协议、请求关联和冷快照。 [验证记录](../validation.md)区分当前 installed built、本机模型与源码 fixture。合同 JSON、回执和全量门见[合同与证据手册](contracts.md)。当前实现不提供未知请求/执行意图的自动人工裁决、模型费用硬上限、生产候选事务合入或原生所有功能的全覆盖保证。
