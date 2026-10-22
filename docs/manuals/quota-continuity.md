# Codex额度中断后的续工方案

2026-10-22核查。结论：有成熟的额度续用机制和持久化工作流组件；尚未验证一个可直接安装、完整保留本项目双端原生能力并自动接管桌面当前聊天的成品。下面区分官方能力、本机源码证据和建议设计。

## 选择方案

| 目标 | 方案 | 证据与限制 |
| --- | --- | --- |
| 同一个Codex继续承担规划和验收 | 使用计划可用的追加credits；也可另用API计费的本地聊天 | 官方支持额度后继续工作。API是另一计费路径，不承诺自动接管当前桌面聊天；不能假定用户账户已有余额或自动购买权限 |
| 不依赖持续活跃的桌面聊天执行既定流程 | 原生Codex SDK / codex exec加独立持久化调度器 | 官方支持程序化启动、继续和恢复；仍需要模型额度。桌面聊天、插件和权限配置是否全部等价需另验 |
| Codex暂不可用，DSH继续已批准工作 | 把有限任务和交接状态交给原生DSH，或评估其schedule | 保留DSH自身Harness，但这时Codex没有参与新判断。不能把DSH自验称作Codex独立验收，也不能自动改变目标或提交发布 |
| 额度恢复后自动继续 | 独立等待器记录精确会话、重置时间和停止状态，再恢复一次 | 不在等待期间获得推理能力。社区插件只是候选，本项目未安装或实测 |

官方说明：额度后可购买追加credits，也支持API计费的额外本地聊天。[额度与计费](https://learn.chatgpt.com/docs/pricing)

Codex SDK支持同thread继续与按ID恢复；非交互模式也支持resume。官方将自动化任务指向SDK；app-server WebSocket目前仍有experimental/unsupported说明，不能仅因桌面内部使用它就认定自建WebSocket调度服务已达生产标准。[SDK](https://learn.chatgpt.com/docs/codex-sdk)、[非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)、[App Server](https://learn.chatgpt.com/docs/app-server)

## 网上方案的成熟度

**Temporal适合作为成熟的外层持久化调度基础。** 官方有生产使用案例，事件历史可重建工作流；旧Activity结果在重放时从历史读取。生产环境需要Worker、Temporal Service和持久化运维，不能把开发用单进程服务当生产部署。Activity的外部副作用仍需正确处理幂等与未知结果；本项目原生发送不明时必须等待核对，不能套用默认重试再次发送。[生产使用](https://docs.temporal.io/evaluate/use-cases-design-patterns)、[任务与重放](https://docs.temporal.io/tasks)、[生产部署](https://docs.temporal.io/production-deployment)

**LangGraph可表达状态、检查点和人工审批分支。** 它需要真正持久化的checkpointer；内存保存器不会跨重启保留状态。它本身不是为本项目配置好的常驻服务，更不提供额外模型额度。[持久化文档](https://docs.langchain.com/oss/python/langgraph/persistence)

**codex-auto-resume是贴近需求的社区候选，成熟度尚不足以在此背书。** 作者说明它在合法额度重置后恢复CLI会话，提供Windows计划任务集成；仍附着于活跃TUI的会话不恢复，非交互审批也有要求。未核实本机桌面适配、长期故障注入或独立生产复现，故未安装、未改配置。[作者仓库与限制](https://github.com/lutzkind/codex-auto-resume)

以上能证明组件或作者声明的能力，不能证明本项目双端协作已经获得同等可靠性。

## 本机DSH原生能力

本轮通过新DSH会话做只读核查，并由Codex复核关键源码：

- `packages/schedule/schedule/src/runtime.ts`会resolve原session，再以`source.kind=schedule`投递followup；Host进程内的timer负责唤醒。
- 任务使用持久化storage；初始化会重新驱动调度。浏览器关闭与Host进程退出不同，Host不在时不会实时执行。
- 当前RPC表没有创建schedule的入口，创建工具由session内agent调用。存在list/update/delete不等于外部控制器已能创建；本轮没有创建任何提醒或计划。
- `session/cancel`仅接收sessionId，没有按request/turn/owner做原子条件取消。读取状态再取消仍有跨客户端竞态。

这些是当前机器源码/工具表的观察，不是所有安装的普遍保证。本次真实Host从源码入口运行，而隔离回归使用构建入口，两种结果分别登记。历史曾观察过schedule跨Host重启保留并按截止点投递，但当时客户端回执存在缺口，不能借来宣称当前版本干净验收或离线错过截止点的补投已通过。

原生schedule不等于本工具已经具备额度接管：它不知道Codex侧合同、验收和停止账本。现有stop也不删除原生提醒；若直接用循环提醒驱动项目，可能在停止后再次唤醒。补齐统一停止与授权之前，不应自动启用这种循环。

## 推荐落地方式

以下为设计建议，尚未实现或部署常驻服务：

1. 继续使用同一桌面Codex时，优先采用官方可用credits，这是对当前交互影响最小的路径。账户购买、API切换和模型切换都由用户决定。
2. 如果要求Codex不可用期间也能推进，增加独立、持久化、单一拥有者的任务队列。队列记录合同hash、允许任务、下一阶段、会话ID、发送意图、审批/费用范围、停止标记和恢复条件，仍调用现有原生薄控制器。
3. 调度器只推进已批准的确定分支。新架构判断、范围扩张、未知提交、审批不明或最终独立验收进入等待；DSH不能代替离线Codex签署验收。
4. 停止入口必须在模型之外可用，并先持久化，所有重启、定时和重试都检查它。未知发送不重投，旧账本不删除，不能通过绕过审批实现无人值守。
5. 先验证单机进程崩溃/重启、重复事件、断网未知、额度恢复与停止竞态。以后需要跨机器高可靠时，再采用Temporal；不要先为单机工具搭一套未验证的平台。

本轮交付的是并发停止修复、原生联调证据和这个可评估方案，没有更改Codex计费、安装社区续跑插件、注册常驻服务或创建原生循环提醒。
