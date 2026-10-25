# 合同与执行证据手册

适用 0.1.2及后续当前版本；实际验收见[验证记录](../validation.md)，命令入口见[Codex 手册](codex-guide.md)。这些机制记录授权声明、检查 Git/文件身份并捕获本地证据；原生模型、工具、权限链仍由完整 DSH 执行。它们不是 OS 沙箱、用户授权证明或多文件事务合入器。

合同由Codex根据用户目标和项目规则生成；用户不必手写下方JSON。绑定前executionRoot必须正好是Git根且已有初始提交HEAD。新项目先在授权初始化范围内建立最小基线；已有项目可带未提交/未跟踪改动，不为接入而清理或擅自提交。

0.1.4可给contract/run/receipt/readiness追加--output-budget-bytes 16384，超限时读结构化摘要及完整原件索引，不能把投影当全部证据。原件核验失败、projectionFailed或证据未知时不接收为通过；详见[输出预算](output-budget.md)。业务taskIds/scopeRevision和进度前后证据可在既有requirements文本中引用，不是新增参数或自动放宽范围的依据。

## 首次绑定与派发

先 start 或恢复同一 task，核原生 cwd、Git 根、HEAD、分支、现有修改和费用授权。nativeCwd 是任务绑定目录；executionRoot 是获准实施的 Git 根，可以是独立工作树。两者分别核验。协作工具与业务项目各自管理 Git；gitOwner 固定 Codex，DSH 保留他人编辑，不自行提交/合并/发布。

把下面 JSON 保存为 contract.json。示例使用 Windows 通用绝对路径占位，全部替换为本机已核验的真实路径；在其他系统换为该系统绝对路径。示例的 scripts/check.cjs 必须真实存在、执行目标断言、失败时非零退出且正常时输出结果；不能为取得 passed 制造无断言脚本。示例仅适合该脚本只依赖 Node 标准库的情形。

```json
{
  "id": "project-fix",
  "revision": 1,
  "supersedes": null,
  "gitOwner": "Codex",
  "authorizationRef": "用户已授权的任务记录",
  "feeAuthorizationRef": "用户已授权的本阶段模型费用记录",
  "stopConditions": ["用户停止", "范围或授权冲突时停止派发并报告"],
  "nativeCwd": "C:/ABSOLUTE/PROJECT",
  "executionRoot": "C:/ABSOLUTE/PROJECT",
  "allowedFiles": ["src/example.js"],
  "protectedFiles": ["package.json", "package-lock.json"],
  "textFiles": ["src/example.js"],
  "requirements": [
    {"id": "R1", "text": "按已授权的具体验收条件修复 example 行为"}
  ],
  "testPlan": [
    {
      "id": "example-guard",
      "owner": "Codex",
      "purpose": "验证 R1 的定向行为",
      "scope": "targeted",
      "domain": "guard",
      "runner": "command",
      "executable": "C:/ABSOLUTE/NODE/node.exe",
      "argv": ["scripts/check.cjs"],
      "timeoutMs": 30000,
      "inputs": ["src/example.js", "scripts/check.cjs", "package.json", "package-lock.json"],
      "runtimeInputs": [],
      "env": {},
      "expectedNodeids": []
    }
  ]
}
```

```sh
codex-dsh contract --task demo --file contract.json
codex-dsh send --task demo --contract-sha CONTRACT_SHA256 --text-file prompt.txt --allow-model --wait 60 --view summary
```

CONTRACT_SHA256 取 bind 输出的 contractSha，不能用原 JSON 文件的哈希代替。绑定资产 schema 为 dsh-contract/v1，包含 contract、baseline、binding；绑定 task/session、目录身份、Git HEAD/branch/index 和文件基线。保护文件、未列入 allowedFiles 的文件或 index 变化会阻断后续检查。绑定不会清理原有修改，也不会自动回滚。

绑定返回的信息足够进入下一步时，不紧接着再inspect或全文打印baseline。`contract --task demo`用于需要重新核验合同、恢复或诊断的场合；审阅过的材料按路径/hash复用，但send/run/receipt/readiness仍执行其当前指纹及范围检查，代码或运行依赖变化后不能沿用旧通过。详见[减少重复读取与等待输出](efficient-collaboration.md)。

真实工程必须先绑定合同，send 传当前 contract-sha；已绑定任务漏传或错传会拒绝。尚未绑定的兼容任务仍可无 hash 发送，这不免除工程合同要求。首次该 hash 尚无确认消息时附完整 contract；后续确认使用同 hash 的请求仅附引用与本轮增量。压缩、上下文缺失或不明时，DSH 须读取资产的 contract 字段并保留全部要求；baseline 是核验数据，不必重复展开。轮次 COMPLETED 仍须 Codex 读 resultFile、diff 与证据验收。

## 字段约束与修订

- id、testPlan[].id 使用 CLI 标识符；revision 为正整数。首版为 1，无 supersedes 或 null。
- authorizationRef 非空；feeAuthorizationRef 必须存在，为 null 或非空引用。null 不授权真实模型费用；引用只记录调用者声明，仍需已有用户授权。
- stopConditions 为非空字符串数组。requirements 必须非空，id 唯一、text 非空。
- allowedFiles/protectedFiles 为无重复的相对文件清单，不支持 glob，二者不得重叠；使用 `/`，不得含绝对路径、反斜杠、`..`、`.git`、空路径段等危险路径。Windows 也检查大小写冲突，拒绝不安全链接。
- textFiles 可省略；只可列 allowedFiles 内非保护的 UTF-8 文本。其内容指纹仅把 CRLF 归一为 LF，不忽略其他字符。原始文件 SHA、byteFingerprint、stdout/stderr 及资产读取仍按原始字节严格校验；这不是日志宽松匹配。
- testPlan 可以为空，但每组实际测试必须先明确 owner、purpose、scope、domain、runner 与全部输入。执行时 owner 必须与计划完全一致。

修订必须同 id、revision 加 1、supersedes 等于当前 contractSha，并提供 decision.approved=true 与非空 reason。之前每个 requirement 若删除或任何字段替换，须逐项声明；新增 requirement 不需要这类声明。不得静默删除要求或擅开兼容例外。例如修改 R1、删除 R2：

```json
{
  "approved": true,
  "reason": "已取得范围调整决定",
  "requirementChanges": [
    {"id": "R1", "action": "replace", "reason": "具体替换原因", "authorizationRef": "该项授权记录"},
    {"id": "R2", "action": "remove", "reason": "具体移除原因", "authorizationRef": "该项授权记录"}
  ]
}
```

把此对象作为完整新合同的 decision 字段后重新 contract --file。声明必须与实际变化逐项一致；它不是用户审批凭证。修订前仍须通过旧合同检查；相同 executionRoot 保留原基线，不能用修订重置越界改动，readiness 会失效。

## 测试计划与运行

scope 只允许 targeted/repo-full；domain 只允许 guard/probe。guard 用于既定验收守卫，probe 用于诊断反例，两者分别保留目的和结果；不得把探针结果当守卫通过或放宽守卫制造通过。runner 只允许 command/pytest。

executable 必须是绝对可执行文件，不能是 .cmd/.bat；argv 为字符串数组，timeoutMs 为 1–300000。运行使用 shell:false、无 stdin、cwd=executionRoot、仅计划 env，不继承整个宿主环境；所需 PATH/SystemRoot 等应显式列在 env。输出合计上限 16 MiB。超时/输出溢出/中止只尝试终止直接子进程，不保证后代静止。

inputs 必须非空，列出相对 executionRoot 的真实输入文件，不能只列测试入口而漏源码、配置或锁文件。runtimeInputs 是**显式完整的外部依赖清单**，包含会影响结果的解释器环境、已安装库/插件与外部配置等文件绝对路径；锁文件不能证明安装环境没变。只有确实仅依赖标准库等没有额外外部依赖时才填 []。省略 runtimeInputs 仍可运行，但结果不可复用，receipt.valid/passed 不会成为 true；工具也不能证明调用者没有漏报依赖。

pytest 计划示例字段：runner="pytest"，executable 指向真实 python.exe，argv 如 `["-m", "pytest", "tests/test_example.py", "-q"]`，并在 expectedNodeids 中列全本次预期收集项（含参数化 ID）。工具追加自带 reporter、关闭插件自动加载并设置 reporter 所需 PYTHONPATH；不要依赖未经声明的自动插件。runtimeInputs 仍须完整列出该 Python/pytest 环境依赖。command 的 expectedNodeids 可为 []，它没有 pytest 收集项证明。

```sh
codex-dsh run --task demo --contract-sha CONTRACT_SHA256 --case example-guard --owner Codex
codex-dsh receipt --task demo --run RUN_ID
```

run 先持久化 dsh-execution-intent/v1 再启动进程，保存不可覆盖的 stdout/stderr、可选 pytest 报告及 dsh-run/v1 回执。同合同、同指纹且当前 receipt.passed 的结果默认复用；失败后再跑、指纹变化再跑或主动重跑须 --rerun-reason 说明具体失效原因。同 purpose/domain 的不同 case 含重叠 expectedNodeids 时也须理由。不默认由独立验收者复制整套测试。

## readiness 与回执判定

repo-full 执行前，先清零审查 blockers 并取得所有 targeted 计划的当前有效通过回执。review.json 示例：

```json
{"blockers": [], "targetedRuns": ["TARGETED_RUN_ID"]}
```

```sh
codex-dsh readiness --task demo --contract-sha CONTRACT_SHA256 --review-file review.json
codex-dsh run --task demo --contract-sha CONTRACT_SHA256 --case FULL_CASE_ID --owner FULL_CASE_OWNER
```

FULL_CASE_ID 必须已列入同合同 testPlan 且 scope=repo-full；示例首版只有 targeted，不能直接运行未定义全量。readiness 绑定合同与当前源指纹；变化后须重新准备，不可沿用旧审查或旧通过。blockers 为空只是调用者声明，Codex 仍应完成真实审查。

receipt 会校验资产字节/长度/hash、当前合同范围、源/index/Git 基线、可执行文件、计划、runtimeInputs、平台和执行器版本。valid 表示结果仍可用于当前指纹；evidenceComplete 表示捕获证据满足规则；passed 要求两者成立。退出 0 或模型自报通过不足以通过：必须正常退出、stdout 非空、执行前后源与测试指纹一致。pytest 还须实际收集非空、预期 nodeids 精确一致、所有项 call/teardown 通过、报告完成且观测 cwd 正确；空输出、错 cwd、缺收集或失败不能通过。command 仅有进程和输出证据，断言充分性由审查负责。

进程启动后崩溃、超时或后代清理不明可能留下 UNKNOWN 意图。它会阻断新运行/合同检查，旧回执也不能因此宣称有效；先核原始资产、进程和真实副作用，**不得重跑、删锁/账本或换任务逃避不明状态**。若停止先于实际启动，则意图标记 SETTLED/not-started，receipt 返回 NOT_STARTED 且不可通过；这与已启动但结果未知不同。当前不提供自动人工裁决命令。停止先阻止新 send/run/审批；未能证明静止继续 STOP_PENDING。原始失败和日志必须保留，不能覆盖成一次成功。
