# FE-BE-01 迁移证据与 Review 重点

基线：`wjy/three-day-delivery` @ `c788a1ad0237055c74c42b4f80d04e1860787be8`
（完整上游 `be013f09d82448aac63aeae243d07e8db4a5c2bb` + 协作规则）。
功能分支：`feat/fe-be-01-safety-contract`；Draft PR #4。

## 迁移来源

- `D:\原子赛道\FE-BE-01.zip` / `D:\原子赛道\outputs\FE-BE-01\`（可访问）
- `D:\原子赛道\outputs\FE-BE-01-R1\`（独立 Review 修复，可访问）
- 原工作区 `D:\localfit-fe-02` 的 25 项未提交改动未被整体搬运；隔离目录逐文件 3-way 合并。

## 提交

- `2316168` `feat(backend): integrate BE-01 safety state contract`
- `31a5ecc` `feat(frontend): integrate FE-BE-01 safety UI and review fixes`
- 本文件为后续证据提交。

## 迁移范围与分类

1. **BE-01 后端安全契约（FE-BE-01 运行前置）**：SQLite 权威 `active_sessions` / `session_events`、
   safety latch/version、analyze/decision/explanation 对账、R1/R2/R3 回归测试；
2. **FE-BE-01 前端集成**：会话/事件生命周期、checking/storage/uninitialized fail-closed、
   `expected_safety_version`、迟到响应防护、历史/决定恢复、Draft 安全 UI；
3. **FE-BE-01-R1 修复**：P1.1–P1.4、P2.1–P2.3 的实现与测试；
4. **测试与 E2E**：Vitest backend/browser 模式测试、Playwright 真实浏览器场景 A–H、测试配置。

## 冲突与兼容处理（Review 重点）

| 文件 | 处理 |
| --- | --- |
| `backend/app/agents.py` | 保留上游共享 `POLICY`，加入 `safety_latched` 阻断 |
| `backend/app/main.py` | 保留上游 `contract`/nutrition 路由，替换为权威 SQLite 安全决定/状态实现 |
| `frontend/src/api.ts` | 合并上游 contract 健康字段与安全 `ApiError`/safety-events/state 接口 |
| `frontend/src/App.tsx` | 保留上游 `LandmarkRecorder`，加入安全门禁/生命周期/恢复逻辑 |
| `frontend/src/localCoach.ts` | 同时保留上游合同校验与安全取消、原子持久化 |
| `backend/tests/test_release_contract.py` | 历史删除后决定/解释期望由 `404` 改为 `409 not recoverable`（有意语义变更） |

## 实际验证

| 命令 | 结果 |
| --- | --- |
| `cd backend && python -m pytest -q` | 133 passed |
| `cd frontend && npx vitest run` | 210 passed / 11 files |
| `cd frontend && npm run build` | success |
| `cd frontend && npx playwright test`（系统 Edge + FastAPI + 临时 SQLite） | 9 passed (41.2s) |

GitHub Actions（PR #4，pull_request）：
- `frontend` job：success；`backend` job：success；工作流 `Validate LocalFit`：success。

E2E A–H 摘要：
- A 两组不同 session_id，accept `expected_safety_version` 正确；
- B 不适立即阻断、服务端 latched、结束生成阻断报告；
- C safety event 失败保持阻断、同 event_id 重试成功；
- D1 锁存先 accept 409；D2 决定先 accepted+latched；
- E 刷新恢复锁存、删历史不复活报告；F 纯浏览器 `/api` 请求 0；
- G 客户端请求层重叠 409 且未 accepted；
- H 已提交 v1 但响应丢失，恢复重放同版本，`analysis.committed` 仅 1 条。

## 未覆盖 / 风险

- 真实摄像头未在 E2E 覆盖（仓库缺 MediaPipe wasm 资源，E2E 使用模拟来源）。
- 真实 503 存储故障/410 过期未在浏览器 E2E 注入（mock/后端测试覆盖）。
- 5 个冲突文件与 `404→409` 语义变更需独立 Review。
- ChatGPT Reviewer 尚未接入；本 PR 不宣称已通过独立 Review。
- 不合并 `main`；不启用 auto-merge；等待王靖贻明确授权。