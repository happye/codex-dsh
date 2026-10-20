# Codex 操作手册

先定位工具仓库绝对路径、用户目标项目和统一的绝对状态目录。保持当前原生 Codex 对话作为主控；不增加模型代理或绕过原生 Harness。按项目权限完成规划、验收和阶段汇报。

跨项目提交前核对实际Git根、origin和允许文件：协作工具改动交付到本工具仓库，业务项目交接交付到业务仓库。分别报告提交与推送结果，不能拿业务仓库的提交当作工具已发布。

先读个人Skill目录的local-settings.json（由setup生成），字段toolRoot/stateDir/connection/url用于跨工作区定位。CLI自动沿用配置；可用connections列出非秘密元数据，不能完整打印state.json。缺少首次鉴权时运行setup，不能把Skill已安装或配置已存在当作已认证。测试fixture里的连接不可当正式连接复用。不要让用户手写配置JSON或在每个项目重新提供同一stateDir。

## 命令合同

在工具仓库使用node bin/codex-dsh.mjs，或通过配置toolRoot定位bin，或用已安装的codex-dsh。setup后自动复用个人stateDir；显式--state-dir优先，用于旧任务或隔离测试。无配置时保留旧版当前目录.codex-dsh的兼容行为。完整参数以--help为准。

| 命令 | 用途 |
| --- | --- |
| setup --url URL [--name native] [--token-stdin 或 --token-file FILE] | 安装原样个人Skill，自动生成非秘密定位配置和私有账本；首次鉴权或更新失效凭证 |
| connections | 列出连接名、Host及任务定位元数据；不输出cookie，不等于Host在线检查 |
| attach --name NAME --url URL --token-stdin | 读取一行本地令牌，附加现有原生 Host |
| start --connection NAME --cwd ABSOLUTE --task ID | 创建原生任务会话；可选 --title TITLE |
| start ... --session SESSION_ID | 附加已有会话，按 shared 处理停止 |
| send --task ID --text-file FILE --allow-model --wait 60 | 持久化意图后发原生 prompt，同时观察 |
| status --task ID | 读原生历史并协调 |
| resume --task ID | 恢复观察，不重放 prompt |
| follow --task ID --wait 60 | 打开原生事件/审批观察窗口 |
| approvals --task ID | 查看本地已接收的有效审批 |
| approve --task ID --approval EVENT_ID --decision allowed-once | 排队单次许可；拒绝用 rejected |
| stop --task ID | 阻止新派发并尝试限定范围停止 |

JSON 输出。退出码 0 表示命令成功/取得状态，**不表示任务完成**；2 参数错误，3 状态或冲突，4 通信/原生失败。读取 state、requests、observationTimedOut、stopReason 和 resultFile，而非只看退出码。

## 循环执行

1. 明确目标、允许目录、验收标准、现有未提交修改和费用授权。对真实工程按其合同选择隔离工作树；不要把新原生会话当文件沙箱。工具不会自动复制或接收改动。
2. 新任务在连接后 start，记录任务 ID、sessionId、状态目录、真实项目根和 Git 基线。同一任务默认持续使用同一个原生 session；换 Codex 聊天先 resume，不重复 start，也不自动创建新 DSH session。
3. 把具体工作合同写入提示文件，经 send 提交。--allow-model 只能在已有任务和费用授权内使用，不能据它扩大范围。
4. 保持有界观察；超时而未完成则继续 follow，断线则 resume/follow。不要因观察窗口结束取消或重发。审批需要活跃 watcher：若同时等待模型和审批，保持 send --wait / follow 进程运行，通过另一 CLI 进程查询/提交决定。
5. 对已匹配本请求的 COMPLETED，读取完整 resultFile，并检查文件、diff 与相关测试。必要时把具体反例发成下一轮新请求；原生 turn 完成不代表用户目标完成。
6. 每阶段报告目标、DSH 行为、Codex 验收、下一步、已知费用及未验证边界。任务完成、明确受阻或用户停止时结束派发。

没有自动模型决策守护进程。可以由 Codex 主动重复上述调用；用户不必手动在两端传话。工具没有保证跨 Codex 配额中断的持续主控服务。

<a id="resume-session"></a>
## 新 Codex 聊天与已有会话

用户可以说：“使用 $codex-dsh-collab，继续任务 demo，沿用原状态目录和 DSH 会话；先核对项目根、Git 基线和上轮结果，再按原合同续工。”新聊天先读取个人配置、connections 元数据与项目交接，再执行：

```sh
codex-dsh connections
codex-dsh resume --task demo
codex-dsh status --task demo
```

旧任务用了其他账本时，每条命令显式加 `--state-dir STATE_ABSOLUTE_PATH`。这个参数选择控制器账本，不选择 DSH 工作目录。resume 读取原生历史，不重新投递旧 prompt；恢复后仍须检查真实文件、当前活动、允许范围与费用授权，才发送下一轮。当前没有自动选择唯一活动任务的跨聊天恢复指针，任务身份需由交接与账本核对。

用户也可以说：“挂靠我指定的已有 DSH 会话 SESSION_ID，在【项目根】继续【目标】，先核对目录、活动和权限。”若该会话已被同一账本绑定，复用原 task 并 resume，不另建 task 重复挂靠。未绑定时，核对原生会话真实 cwd、当前活动及权限后使用：

```sh
codex-dsh start --connection native --cwd PROJECT_ABSOLUTE_PATH --task demo --session SESSION_ID
codex-dsh status --task demo
```

这里的挂靠命令是 `start --session`；`attach` 用于连接 Host，没有 `attach --session`。已有会话按 shared 处理，传入 `--cwd` 不能改变它原来的 cwd。当前 refresh 只核会话 ID、未强制核真实 cwd；核对不一致或无法确认时，不发送工作提示，见 [C02](../validation.md#c02)。

## 项目根、原生工作区与 Git 职责

新建时控制器调用原生 `session/create`，传入 sessionId 与 cwd；任务元数据记录 cwd。cwd 决定会话工具的工作位置，原生 UI 的 workspace 注册和成员关系是另一项配置。当前 CLI 没有 workspace 命令；原生 `workspace/create`、`session/create(workspaceId)` 能注册工作区，但本轮一次 API 配置与成员读回只证明该配置成功，不是 CLI 普遍修复，也不是浏览器视觉验收。

Windows 原生 ensureSession 会比较原始 cwd 字符串。同一路径的斜杠写法不同也曾使 workspace 绑定返回 RPC_REJECTED；新建前用文件系统 realpath 规范路径，并读回目录及成员关系。不能修改旧会话头绕过校验；跨项目或换目录要新建会话，或按用户明确授权的迁移流程核对。UI 显示工作区不证明操作的是预期 Git 仓库，须独立核对仓库根、branch、HEAD 与现有改动。

把 DSH 作为受委派的实施 subagent 职责使用；它仍是完整原生 DSH 会话，并未变成 Codex 原生嵌套 subagent。每轮合同至少包含：

- 项目根/工作区、task/session、基线 branch 与 HEAD。
- 允许文件、目标与验收条件、禁止范围、阶段及费用授权。
- `git_owner=Codex`：DSH 在允许文件内实施和验证，保留他人编辑；Git 检查、提交、合并与发布由 Codex 按授权掌握。
- 返回实际变更、实际运行的验证及结果、产物位置、限制和下一步；未运行的检查明确为未验证。

Codex 读取返回和真实 diff，按合同验收；COMPLETED 不等于验收通过。工程开发的真实“写入→测试→追修→Codex 验收与 Git”闭环仍待验证，不能从本轮只读业务试用推定通过。长期缺陷、功能缺口、待验与能力边界唯一登记在 [已知问题与迭代记录](../validation.md#known-issues)；本地 progress 只保留进度与入口。

## 不明状态和原生审批

SUBMITTING / SUBMISSION_UNKNOWN / UNKNOWN / CREATE_UNKNOWN 不能当作“未执行”。先查原生会话和真实副作用；不自动重投，不删除锁逃避状态。终态 FAILED/ABORTED/INTERRUPTED/REJECTED 也要核对已发生改动。

只处理本任务有效、可理解的原生审批，核对操作说明和用户权限。未知/其他会话交给原生事件链。DECISION_QUEUED 仅是本地决定排队，RESULT_SENT_UNCONFIRMED 也不是原生一定执行或拒绝。watcher 失联后不复用过期事件；原生 UI 可处理有效询问。原生部署绕过询问时，CLI 无法补造审批；向用户说明部署事实。

## 停止

收到停止先调用 stop，禁止下一轮 send。专属会话使用会话级原生取消；共享会话不盲目取消其他用户轮次。无法证明子任务、后台 job、外来轮次、工具或不明提交静止时报告 STOP_PENDING。不要杀共享 Host、archive、删提醒或宣称整棵工作树已停止。

一个 Host 使用同一状态目录：目录内协调连接别名和任务锁，目录间无全局协调。原生 UI 和外部客户端仍能操作会话，所谓 exclusive 是控制器创建的任务用途，不是服务器排他锁。

## 技术和验证

[技术说明](../architecture.md)解释协议、请求关联和冷快照。 [验证记录](../validation.md)区分当前 installed built、本机模型与源码 fixture。当前实现不提供未知请求的自动人工裁决、模型费用硬上限、生产候选事务合入或原生所有功能的全覆盖保证。
