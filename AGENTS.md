# AGENTS.md — Codex ↔ DeepSeek Harness

本仓库实现薄原生控制器：当前 Codex 对话规划验收，完整原生 DSH 执行。先读 README.md、docs/manuals/codex-guide.md、docs/validation.md；协议与流程见 docs/architecture.md。

## 工作规则

- 中文交流，说明行为、验收结果和边界；区分实测、推断、未验证。
- 保留原生 UI、profile、上下文、工具、skills、MCP、子 Agent 和权限链；不引入模型代理或替代 Harness。
- 不因调用 send 参数存在而推定付费授权；真实提供方请求需要相应用户任务/费用授权。本地测试使用模拟模型。
- 不改外部安装、主 home 或真实会话；原生集成使用独立 fixture。项目实际开发遵循目标项目允许范围。
- 持久化发送意图，未知接收不自动重投；accepted 不等于完成，轮次完成不等于成果验收。
- 停止必须先阻止新派发；不杀共享 Host、不 archive、不删提醒。无法证明静止则 STOP_PENDING。
- 不提交 cookie、令牌、提示与答复私有账本、用户配置或私人历史。发布使用明确允许清单。
- setup生成个人共享配置；命令优先显式state-dir，其次个人配置，未初始化才兼容当前目录.codex-dsh。同 Host 使用同一状态目录，目录之间没有全局互斥。
- 测试 npm test、npm run check；原生测试 npm run test:native 需要 DSH_ROOT。维护文档必须与实际 CLI 对齐。
- 本地保留的历史研究档案不是发布产品的入口或当前验收结果；不要重跑旧的一次性真实费用探针。

## 按需分工

用户要求主动按能力分配有价值的独立子任务。实质工作先检查是否有适合委派的定位/验证；短小依赖任务直接做，不凑数量。写任务明确文件所有权，告知不是唯一开发者且保留他人编辑；只读角色不修改或触发外部动作，默认不递归委派。

角色与模型：task_explorer=gpt-6-luna/high，task_progress_monitor=gpt-6-luna/low；task_developer、task_reviewer=gpt-6.1-sol/medium；task_quality_guard=gpt-6.1-sol/high；复杂设计才用 task_architect=gpt-6-astra/low。主模型保持用户选择。未命名默认 gpt-6-luna/medium。检查运行时支持；不可用先披露，不静默替换。覆盖型号需 fresh context（fork_turns=none）。不根据自报名称或未经对照的数据声称模型/成本节省。
