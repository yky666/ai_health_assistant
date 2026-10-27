# 三天交付协作规则（内部工作分支）

本分支 `wjy/three-day-delivery` 是 `yky666/ai_health_assistant` 最新基线
`be013f09d82448aac63aeae243d07e8db4a5c2bb` 在本仓库的独立工作基线，保留完整上游 Git 历史。
本仓库 `main` 保持 README-only，不用于内部开发，不直接推送、不合并。

## 角色

- DeepSeek Harness：实现、测试、证据整理、Draft PR 创建/更新（不合并）。
- ChatGPT：独立 Code Review，在 PR 中提交 Review 意见；不以实现方自测替代独立复审。
- 王靖贻：最终验收与合并授权；唯一有权授权合并 `main` 的人。

## 分支与 PR

- 内部功能分支从 `wjy/three-day-delivery` 创建（或从已验收的内部功能分支创建）。
- 功能 PR 的 base 必须是 `wjy/three-day-delivery`，不是 README-only 的 `main`。
- 所有变更先以 Draft PR 提交；不得直接向 `main` 推送或绕过 PR。
- 本仓库 `main` 不做业务代码合并；如需同步回总仓库 `yky666/ai_health_assistant`，必须另行获得
  王靖贻对具体提交 SHA/PR 的明确授权。

## 证据要求

每个任务必须在 PR 中附：
- 测试命令与**实际执行结果**（含失败记录）；
- 变更文件清单与提交 SHA；
- 真实浏览器 E2E 证据（若涉及浏览器行为），不得用单元测试或构建成功冒充；
- 未覆盖项、剩余风险与需决策事项。

任何缺陷未关闭前不得标记通过；不得以计划或自述代替实际执行证据。

## 合并授权

- 不启用 Auto-merge、Merge Queue 或任何自动合并。
- PR 达到条件后只标记“已验收，等待王靖贻授权合并”。
- 只有王靖贻在本对话中明确授权指定 PR 与提交 SHA 后，才可执行对应合并；授权不扩展到其他 PR。

## 当前状态

- 基线 SHA：`be013f09d82448aac63aeae243d07e8db4a5c2bb`（上游 CI：backend/frontend 均 success）。
- FE-BE-01 交付材料可在本机访问，正在按文件核验后迁移；不得整体搬运原工作区未提交改动。