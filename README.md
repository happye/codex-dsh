# Codex ↔ DeepSeek Harness

让当前 Codex 对话通过原生接口发送任务、接收结果、检查状态，再安排下一轮。DSH 继续使用完整原生 Harness；控制器不提供模型代理、不重新实现工具执行器。

版本：0.1.3。提供原生工作区、版本化任务合同、执行证据回执、增量观察与原生用量导出；已观察外部参与时采用保守共享停止，避免取消其他客户端的轮次。验收结果与限制以[验证范围](docs/validation.md)为准。

## 一句话开始

在目标项目的Codex会话中发送（替换三个占位）：

> 使用 $codex-dsh-collab，在【项目绝对路径】完成【目标】，以【验收标准】验收；授权本任务必要的原生DeepSeek调用及费用，由你规划验收、DSH实施，按项目规则保留现有改动、建立或复用合同与会话，自主循环追修并阶段汇报，直到验收通过或我叫停，Git提交、推送和部署沿用已有授权。

新任务由Codex完成接入；续工直接说“使用 $codex-dsh-collab，继续任务【TASK_ID】，沿用原账本和DSH会话，先核对上轮成果，再按原合同继续”。用户不必逐轮传话、填写合同JSON或手动操作CLI。

机器初始化只做一次；新项目准备和完整操作流程见[用户手册](docs/manuals/user-guide.md#new-project)。当前电脑已初始化时，复用个人Skill、工具定位及连接账本。控制器由活跃Codex对话驱动；额度耗尽后的自动接管与常驻调度不属于本项目路线。

## 准备和运行

需要 Node.js ≥22.19、完整原生 DSH Web Host，以及 Codex 可调用本机命令。当前原生集成验证在 Windows 完成。先以自己的配置启动原生 DSH Web，保留浏览器入口；本工具附加到该 Host。

```sh
git clone https://github.com/happye/codex-dsh.git
cd codex-dsh
npm ci
node bin/codex-dsh.mjs setup --url http://127.0.0.1:PORT --token-stdin
```

把 PORT 替换为原生 Host 实际端口，在本地输入一行访问令牌；也可使用 `--token-file TOKEN_FILE` 从本地文件读取，两个选项不同时使用。不要把令牌放入聊天、URL参数、命令参数或Git。首次认证需要 Host 的真实凭证，工具不绕过原生鉴权。

setup 自动安装个人全局 Skill、记录工具当前路径、创建私有共享账本，并在提供令牌时执行原生鉴权。**GitHub 与安装后的 SKILL.md 正文相同**；每台电脑的路径只在自动生成的 local-settings.json 中，cookie只在私有账本。未提供令牌时只完成本地初始化，返回 authenticationRequired，不冒充已连接。

默认个人目录为用户主目录的 `.codex`，可用 CODEX_HOME 定位。生成的 Skill 在 `skills/codex-dsh-collab`，连接账本在 `codex-dsh-state`。切换项目后，CLI 自动沿用个人配置，无需手写绝对路径或再次提供令牌；鉴权失效时重新 setup。仓库搬迁后从新位置运行 setup 更新定位，保留原有账本。

例如从任意项目调用工具时，用第一次 setup 输出的 toolRoot 定位 bin/codex-dsh.mjs。也可在仓库运行 `npm install -g .`，然后在终端直接调用：

```sh
codex-dsh connections
codex-dsh tasks --connection native --cwd PROJECT_ABSOLUTE_PATH
codex-dsh recover --connection native --cwd PROJECT_ABSOLUTE_PATH --title EXACT_TITLE
codex-dsh workspace --connection native --cwd PROJECT_ABSOLUTE_PATH
codex-dsh start --connection native --cwd PROJECT_ABSOLUTE_PATH --workspace WORKSPACE_ID --task demo
codex-dsh contract --task demo --file CONTRACT_JSON
codex-dsh send --task demo --text-file PROMPT_FILE --contract-sha CONTRACT_SHA256 --allow-model --wait 60 --view summary --request latest
codex-dsh follow --task demo --wait 60 --view summary --request latest
codex-dsh resume --task demo --view summary --request latest
codex-dsh stop --task demo
```

连接列表只输出非秘密元数据，包括该账本下已绑定的 task、cwd 和 session ID；它不搜索原生会话标题，也不检查 Host 当前在线。状态目录优先级为显式 `--state-dir`、个人共享配置、旧版当前目录 `.codex-dsh/`。已有任务若使用旧目录，继续显式指定原目录；不要丢掉旧账本另建相同任务。`send` 会启动原生模型工作；`--allow-model` 代表调用者已取得任务及费用授权，不是费用硬上限。

start 默认创建任务专属原生会话；附加已有会话使用共享停止语义。JSON 返回状态及完整答复的 resultFile，Codex 读取答复和实际交付物后决定下一轮。COMPLETED 仅代表该轮次结束，不代表项目验收通过。

继续任务可直接recover --task ID。按连接/目录/精确标题恢复时，只选该账本已绑定且唯一匹配的任务；多个候选返回AMBIGUOUS_TASK和候选ID，不按标题猜、不新建或重投。--active只筛选可观察的原生运行或未决请求，不表示项目目标完成。

附加、恢复和发送前校验原生header里的真实cwd与任务绑定目录。目录缺失、不可解析或身份不同会拒绝，旧账本也要重核；控制器需能访问同一文件系统目录。路径核验不是写入沙箱，不限制显式合同允许的独立实施树，也不能代替Git基线和允许文件核对。内部或未知原生错误即使返回错误帧，也不会被当成“肯定没执行”；安全diagnostic帮助判断，未知提交仍禁止自动重投。

同一任务默认持续同一 DSH 会话；换 Codex 聊天后说“继续任务 TASK_ID，沿用原账本和会话，先恢复核对”。指定会话若已绑定，查出原 task 后执行 `resume/status`，不要再 start；仅未绑定时才用 `start --session SESSION_ID`，控制器不会自动查找并复用旧 task。`--state-dir` 不是项目目录。`workspace` 可列出或注册原生工作区，`start --workspace` 只为新建会话指定工作区；旧 session 不会迁移。目录、权限与真实 Git 须先核对，流程见 [Codex 手册](docs/manuals/codex-guide.md#resume-session)。

上面是各操作示例，不是每轮顺序执行的脚本。正常运行继续follow；断线或换聊天才resume。仅需单次查询时可用status --view summary --request latest，不紧接着成功resume再例行重复status；后续观察携带cursor/generation，见[减少重复读取与等待输出](docs/manuals/efficient-collaboration.md)。stop仅在需要停止时调用。

协作工具仓库与目标项目是两个独立 Git 仓库；改动、验收、提交和推送分别核对各自的 Git 根、分支与授权。一个仓库的提交不能代表另一个仓库已交付。具体以 Codex 负责 Git 的合同为准。

## 原生边界

模型、上下文整理、输出参数、工具、skills、MCP、子 Agent、配置和权限由 DSH 决定。控制器不覆盖 profile，不增加实验中的 8192 输出或 1 MiB WebSocket 限制。它不是操作系统沙箱，也不保证原生所有功能均已逐项验收。

超时仅结束观察，不取消原生任务；断线后先 resume / follow，禁止盲目重投。STOP_PENDING 表示已阻止新派发，但未能证明所有原生活动停止；不杀共享 Host，不以归档或删除提醒实现停止。原生 UI 保留用于观察和接管。

## 文档与验证

- [用户手册](docs/manuals/user-guide.md)：日常协作、费用、停止和故障处理。
- [Codex 手册](docs/manuals/codex-guide.md)：命令、状态、审批和循环决策。
- [合同与证据手册](docs/manuals/contracts.md)：合同 JSON、修订、测试职责、readiness 与回执复用。
- [减少重复读取与等待输出](docs/manuals/efficient-collaboration.md)：常规增量等待、材料复用、必要复核及量化边界。
- [流程图与技术说明](docs/architecture.md) · [Mermaid 源文件](docs/architecture.mmd)。
- [协作 Skill](.agents/skills/codex-dsh-collab/SKILL.md) · [验证范围](docs/validation.md)。
- [待办与迭代方向](docs/validation.md#known-issues)：后续真实工程验收、必要缺陷修复和未验证边界；额度自动接管方向已取消。
- [0.1.2 本轮迭代](docs/iterations/2026-10-22-0.1.2.md)：合同、证据、增量观察、工作区与用量；历史结果不冒充本轮重测。
- [0.1.3 并发停止修复](docs/iterations/2026-10-22-0.1.3.md)：外部客户端保护、原生DSH联调与真实用量。

```powershell
npm test
npm run check
$env:DSH_ROOT = 'C:\path\to\deepseek-harness'
npm run test:native
```

原生测试使用隔离 home/cwd 和本机模拟提供方，不使用真实密钥；要求 Windows、Python 3 和已构建原生安装。发布内容不包含私人研究日志、会话、凭证或其他项目资产。
