# 输出预算与完整原件

0.1.4新增可选`--output-budget-bytes N`，适用于CLI的JSON标准输出；缺省或0保持原有返回结构。N为1024–1048576的十进制整数字节数。它只控制给主控的投影，不改变DSH模型、上下文、输出参数、工具或权限。

```sh
codex-dsh follow --task demo --wait 60 --view summary --request latest --output-budget-bytes 16384
codex-dsh receipt --task demo --run RUN_ID --output-budget-bytes 16384
codex-dsh contract --task demo --output-budget-bytes 16384
```

## 怎样读取返回

未超预算仍是原结构。超预算返回`schema="dsh-output/v1"`：

- `summary`：关键状态、请求和最终答复引用、审批、停止诊断、范围、源指纹及验收字段的允许清单投影。
- `artifactRef`：完整原JSON的私有文件路径、字节数和SHA256；`omitted`给出被省略内容的JSON pointer及计数，根pointer覆盖所有未投影字段。
- `truncated=true`：本次模型可见投影不完整，不代表原件被裁剪，更不代表已经审阅全部证据。
- `statistics.fullBytes/visibleBytes`：完整JSON与实际投影JSON的UTF-8字节数，不含末尾换行，不是token。Codex usage未知为null，DSH usage仅在原生usage结果中可取得时保留；不补零或推算双方费用。
- `budgetExceeded=true`：保留审批操作、逐任务/逐请求状态和停止等必要字段后仍超软限。必须处理这些字段，不为满足预算静默删除。

超限任务列表仍保留逐任务身份及state/blocked/running/unresolved等安全状态。不能从省略后的普通定位列表自动猜选任务；需要时读取原件。source中的executionRoot、baseCommit、sourceManifestSha只从已有字段提取，缺失为null；原件没提供的信息不能由摘要猜测补齐。

原始命令的退出码与业务含义保留：命令退出0不等于receipt.passed=true。先检查错误、projectionFailed、state、审批/停止、valid/passed/evidenceComplete，再核原件、真实diff和测试。最终新答复仍按requestId/resultSha256完整读取一次；本预算不会截断resultFile内容。原件及回执含项目身份、路径和可能私有材料，不是可直接公开的导出格式。

## 日志聚合

超预算run/receipt的stdout/stderr先用现有readAsset核对原始长度/hash，然后按完全相同的可识别Python异常行或pytest ERROR/FAILED行分组。摘要只给类型、次数、代表行号、原件引用；不回显错误正文、命令参数或其单行hash。完整组索引另存`dsh-error-groups/v1`私有文件，未显示组有起止索引，原始日志不改写。

分组ID与同一原件绑定，不代表跨日志根因等价；首条错误只是排查入口，rootCause保持unverified。未知格式标unclassified，不把未识别行当“无错误”。同类异常的不同正文不合并，回原件才能判断供应商TimeoutError与等待器超时等语义。

## 输出处理失败

若命令已执行而输出原件落盘、核验或聚合失败，CLI非零退出，并尽可能先输出`projectionFailed=true`的结构化故障帧：保留已观察到的任务、请求、审批/lease及停止状态，明确原件尚未确认保全，artifactRef=null；不把这份输出判成可接收证据。

此时恢复原task/session或核对原receipt、日志和真实副作用，不重投prompt、不自动重试取消。listen失败后的租期仍会关闭，旧审批不能继续使用。该路径不把ENOSPC/EACCES或证据损坏伪装成“命令肯定没执行”。

## 范围与后续

本轮P0覆盖本CLI输出、原件索引、已捕获日志的分组与必要状态保留。现有执行器16MiB输出保护仍保留；若它因output-limit停止，不能用本层原件证明此前未捕获的日志完整。

P1的多组确定性验证驱动、共享fixture消费者映射与更细粒度复用尚未交付；Codex逐调用用量、完整可见输入/等待计量也未取得。P2的同任务配对与全部质量反例矩阵另列待办。不得为补这些证据重跑暂停的业务项目或付费模型。

业务项目可在既有合同requirements中引用taskIds、scopeRevision、进度前后证据的路径/hash，作为范围和交接说明；这些不是新增CLI字段，也不替代合同修订、真实目录与原始证据核验。

## 本次离线对照

在工具根运行`python -X utf8 -B benchmarks/output_budget.py`可重建模拟回执。2026-10-25这次运行：完整JSON为401,720字节、投影为3,009字节，首次输出减少99.25%；o200k_base参考token为110,423→1,048，减少99.05%。随机原件ID可使参考token数略有差别。3506条相同异常与1条不同异常分为2组，完整原件及失败判定保留；脚本有12项信号/原件断言。

这是特意构造的大失败回执，不是平均项目收益、历史账单重放或整个Codex输入减少量。后续读取原件、改造与审阅成本另计；错误语义和代码质量仍需主控验收。没有调用DeepSeek或业务Host，不能替代真实原生链路验收。
