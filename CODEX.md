# Codex 入口

读取 [AGENTS.md](AGENTS.md) 和 [Codex 手册](docs/manuals/codex-guide.md)。

协作入口为 [.agents/skills/codex-dsh-collab/SKILL.md](.agents/skills/codex-dsh-collab/SKILL.md)。保持当前原生 Codex 对话驱动 CLI，完整原生 DSH 执行任务。新任务先设目标/范围/验收，继续任务先恢复原生状态。

首次用setup自动安装通用个人Skill并生成本机连接定位；用connections查看非秘密连接元数据。跨项目自动沿用共享账本，继续旧任务时保留原state-dir。不要将本机路径或凭证硬编码回Skill正文。

发送、观察、验收和追修无需用户逐轮传话；不明提交先协调，不重投。真实模型费用须在任务授权内。原生 UI 用于观察和接管，停止不杀共享 Host、不删除提醒。限制见 [验证说明](docs/validation.md)。

新项目准备和一句话启动模板见[用户手册](docs/manuals/user-guide.md#new-project)。每台电脑setup一次，跨项目复用个人Skill与账本；工程合同需有HEAD的Git根。额度自动接管/常驻调度方向已取消，当前仍由活跃Codex对话主控。
