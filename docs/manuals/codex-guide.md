# Codex 操作手册

先定位工具仓库绝对路径、用户目标项目和统一的绝对状态目录。保持当前原生 Codex 对话作为主控；不增加模型代理或绕过原生 Harness。按项目权限完成规划、验收和阶段汇报。

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
2. attach 后 start，记录任务 ID、sessionId、状态目录。重启对话先 resume，不重复 start。
3. 把具体工作合同写入提示文件，经 send 提交。--allow-model 只能在已有任务和费用授权内使用，不能据它扩大范围。
4. 保持有界观察；超时而未完成则继续 follow，断线则 resume/follow。不要因观察窗口结束取消或重发。审批需要活跃 watcher：若同时等待模型和审批，保持 send --wait / follow 进程运行，通过另一 CLI 进程查询/提交决定。
5. 对已匹配本请求的 COMPLETED，读取完整 resultFile，并检查文件、diff 与相关测试。必要时把具体反例发成下一轮新请求；原生 turn 完成不代表用户目标完成。
6. 每阶段报告目标、DSH 行为、Codex 验收、下一步、已知费用及未验证边界。任务完成、明确受阻或用户停止时结束派发。

没有自动模型决策守护进程。可以由 Codex 主动重复上述调用；用户不必手动在两端传话。工具没有保证跨 Codex 配额中断的持续主控服务。

## 不明状态和原生审批

SUBMITTING / SUBMISSION_UNKNOWN / UNKNOWN / CREATE_UNKNOWN 不能当作“未执行”。先查原生会话和真实副作用；不自动重投，不删除锁逃避状态。终态 FAILED/ABORTED/INTERRUPTED/REJECTED 也要核对已发生改动。

只处理本任务有效、可理解的原生审批，核对操作说明和用户权限。未知/其他会话交给原生事件链。DECISION_QUEUED 仅是本地决定排队，RESULT_SENT_UNCONFIRMED 也不是原生一定执行或拒绝。watcher 失联后不复用过期事件；原生 UI 可处理有效询问。原生部署绕过询问时，CLI 无法补造审批；向用户说明部署事实。

## 停止

收到停止先调用 stop，禁止下一轮 send。专属会话使用会话级原生取消；共享会话不盲目取消其他用户轮次。无法证明子任务、后台 job、外来轮次、工具或不明提交静止时报告 STOP_PENDING。不要杀共享 Host、archive、删提醒或宣称整棵工作树已停止。

一个 Host 使用同一状态目录：目录内协调连接别名和任务锁，目录间无全局协调。原生 UI 和外部客户端仍能操作会话，所谓 exclusive 是控制器创建的任务用途，不是服务器排他锁。

## 技术和验证

[技术说明](../architecture.md)解释协议、请求关联和冷快照。 [验证记录](../validation.md)区分当前 installed built、本机模型与源码 fixture。当前实现不提供未知请求的自动人工裁决、模型费用硬上限、生产候选事务合入或原生所有功能的全覆盖保证。
