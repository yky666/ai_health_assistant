# 验证记录

**2026-10-29 最新软件检查（PR #5）：**自动化前端测试 **295** 项、后端 **133** 项通过；生产构建通过；本地模型/WASM 资源检查通过；真实浏览器 E2E **10/10** 通过（显式设置 `LOCALFIT_E2E_DB` 后）。历史读取/保存反馈实现基线 commit `47c13580200bfd85fd7735e8c2eb23d51f9ba4d4`。上述仅为自动化与真实浏览器 E2E 结果；真实摄像头、断网重启、目标设备性能和真人动作准确率**尚未验证**。详见下方 PR #5 记录及 `WANG_JINGYI_STORAGE_READ_FIX_20261027.md`。

**2026-10-22 历史记录：**前端 120、后端 61 项通过；生产构建、24 场景跨端对照、12 个合成片段、本地资源与单独回环服务 API 冒烟通过。详见 [本轮实施与证据快照](IMPLEMENTATION_2026-10-22.md)。以下日期对应历史记录，不能用来替代真人/设备验收。

记录日期：2026-10-09。本文件只登记实际执行的检查；真实人体准确率、设备性能和全部离线验收不得填写推测数字。

## 本次检查

初始环境：Windows、Node 24.19.0、Python 3.14.7。

| 检查 | 实际结果 |
|---|---|
| 后端 `python -m pytest backend/tests -q` | 8 项通过；Starlette TestClient 对 httpx 有弃用提醒，不影响当前结果 |
| MediaPipe 模型准备 | 成功，5,777,746 字节权重与 4 个本地 WASM/JS 资产；本地 manifest 记录哈希 |
| 前端 `npm test` | 5 项全部通过，覆盖角度退化、两个动作计数、不可见和追踪缺口 |
| 前端 `npm run build` | TypeScript 检查和 Vite 生产构建成功 |
| 依赖审计 | Vitest 升级至 5.0.3 后 `npm audit --audit-level=moderate` 返回 0 项漏洞 |
| 初次前端测试 | 发现模拟深蹲几何范围不足，已修正回放，不通过的结果未当作真实模型结论 |
| 浏览器视觉／交互检查 | 当前 UI 自动化环境没有可用浏览器；未完成，不宣称视觉或摄像头验收 |
| GitHub 同步 | 初版 e168964 已推送 main，`git ls-remote` 与本地 commit 一致；后续单服务与格式化改进一并同步 |
| 本地服务联通 | 网页代理 `/api/health` 返回 ok、deterministic、video_upload=false、cloud_required=false |
| API 完整冒烟 | 实际运行服务 health → 合成摘要 → 调整提案 → 接受 → 示例食品计算通过，未保存数据 |
| 单服务展示 | FastAPI 8000 同时返回构建网页、模型 manifest 和 API；无需 Vite，真实浏览器交互仍待验证 |

本地服务通过 127.0.0.1 启动供用户后续试用。安装日志或测试输出不包含真实用户健康数据。

## 待执行

- 真实用户动作计数、纠错和机位失效验证。
- 自动校准功能及固定规则对照。
- 明确型号的普通笔记本 P95 延迟、内存与有效 FPS。
- 实际本地 LLM 权重、延迟和解释质量。
- 断网后关闭页面和服务再启动的完整验收。
- 第三方从干净环境复现。

结果必须关联 commit、设备、数据和执行人。

## 2026-10-10：vision-demos 参考与规则增强

参考源版本：8e1467ec39ac5b6b992ce748294664b87382756c。未运行上游云端实现或上传音视频，独立实现宽高比修正、深蹲逐次幅度与时序、未知状态、报告接线。

- 前端 `npm test`：12 项通过，包括宽高比不变性、浅/深周期分离、起始中途姿态、短遮挡未知、长缺口拒绝。
- 后端 `python -m pytest backend/tests -q`：11 项通过，新增单次证据回传、时序一致性、动作类别和组时长边界校验。
- `npm run build`：TypeScript 和生产构建通过。
- 重启本机 8000 服务后，实际 API 冒烟确认单次幅度进入响应与 training_analyst 证据，提案确认及示例饮食仍通过。
- 上述为合成输入/接口验证，不代表真实人体准确率。真实摄像头和视觉交互仍待实机验收。
- 卡路里公式未改为学习型预测或自动分段；明确记录现有运行时钟可能包含静止/休息的限制。

## 2026-10-21：P0 一致性、运行模式与资源边界

本轮旧基线 a64e9dc，按用户授权实际修改；具体变化及待验证项目见 [IMPLEMENTATION_2026-10-21](IMPLEMENTATION_2026-10-21.md)。前端 68 项、后端 33 项通过，生产构建通过；本轮 npm audit 为 0 项漏洞；实际 8010 API 冒烟通过。严格资源路径和本地模型 digest/WASM/入口检查通过，当前构建中未见旧外部人体参数来源标记。

源码姿态分段是因果启发式，不是验证过的运动生理分类；仅估算已分类片段，未知不推算。真实用户、网页视觉和断网重启仍待人工验收。UI 尝试遇到用户操作及窗口最小化后停止，没有取得本轮交互通过证据。新增[四人验收模板](ACCEPTANCE_CHECKLIST.md)，不要用合成测试数替代实测。

## 2026-10-26 王靖贻前端交付检查（历史）

本轮实际执行的检查：

| 检查 | 实际结果 |
|---|---|
| `cd frontend; npm test` | **236 passed** / 12 files，exit 0 |
| `python -m pytest backend/tests -q` | **133 passed**，exit 0 |
| `npm run build` | exit 0，TypeScript + Vite 构建成功 |
| `python scripts/check_local_assets.py` | exit 0；模型 SHA、WASM、构建入口和旧资产标记通过 |
| `npx playwright test`（显式 `LOCALFIT_E2E_DB`/`LOCALFIT_E2E_OUT`） | **10 passed**（含真实浏览器历史下载），真实 FastAPI + Vite + Edge，exit 0 |
| 真实摄像头 | **未执行**；无真实设备/权限记录 |
| 断网关闭并重启 | **未执行**；不能宣称离线验收通过 |
| 目标笔记本性能 | **未执行**；无 P95/FPS/内存记录 |

本地模型文件是生成物，Git 忽略，不应描述为已提交权重；干净 clone 仍需要 `npm run prepare:models` 后重建。当前模型哈希已固定在校验脚本中 = `59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a`；`prepare:models` 本轮实际执行因网络 120 秒超时失败，现有模型和构建资源检查仍通过。模型分发/许可按官方 BlazePose GHUM 3D Model Card 的 Apache-2.0 记录，但不得把 SHA-256 当作上游签名。

## 2026-10-27 sessionStorage 读取 fail-closed 修复

本轮实际执行（当前工作区，修复 `readStored()` 把读取异常/JSON 损坏当作“无键”的 P1 缺陷）：

| 检查 | 实际结果 |
|---|---|
| `cd frontend; npm test` | **244 passed** / 12 files，exit 0 |
| `python -m pytest backend/tests -q` | **133 passed**，exit 0 |
| `npm run build` | exit 0，TypeScript + Vite 构建成功 |
| `python scripts/check_local_assets.py` | exit 0；固定模型 SHA、WASM、构建入口通过 |
| `npx playwright test`（独立新数据库/输出目录） | **10 passed**，真实 FastAPI + Vite + Edge，exit 0 |
| 真实摄像头 | **未执行**；无真实设备/权限记录 |
| 断网关闭并重启 | **未执行**；不能宣称离线验收通过 |
| 目标笔记本性能 | **未执行**；无 P95/FPS/内存记录 |

新增 7 项前端回归覆盖：`getItem()` 抛错但写入/删除正常、活动会话 JSON 损坏、锁存 JSON 损坏、pending 本地锁存刷新后读取失败、空存储正常开始、读取恢复后必须等待服务端状态核验。完整记录见 `WANG_JINGYI_STORAGE_READ_FIX_20261027.md`。

## 2026-10-29 PR #5：浏览器模式不适锁存刷新恢复

- 分支：`feat/wjy-browser-latch-refresh-20261029`
- 实现基线 commit：`47c13580200bfd85fd7735e8c2eb23d51f9ba4d4`
- PR：#5，Draft/Open，base `main`
- 本轮实际验证：

| 检查 | 实际结果 |
|---|---|
| `cd frontend; npx vitest run --no-isolate --pool=forks` | **295 passed / 12 files**，exit 0 |
| `python -m pytest backend/tests -q` | **133 passed**，exit 0 |
| `npm run build` | exit 0，TypeScript + Vite 构建成功 |
| `python scripts/check_local_assets.py` | exit 0；固定模型 SHA、WASM、构建入口通过 |
| `npx playwright test`（独立新数据库/输出目录） | **10 passed**，真实 FastAPI + Vite + Edge，exit 0 |
| 真实摄像头/实际权限撤销 | **未执行**；jsdom/PW 使用 mock 或模拟数据 |
| 真实断网关闭并重启 | **未执行**；不能宣称离线验收通过 |
| 目标设备性能与真人动作准确率 | **未执行** |

- 同一标签页刷新后，浏览器模式的不适锁存恢复，训练保持阻断。
- 不恢复计数、计时、视频或报告；不能生成空报告/虚假报告。
- 恢复后提供只读“查看已保存历史”入口；不提供绕过安全门控的新组流程。
- 不适后摄像头流释放、取消勾选不解锁、重置/切换输入源不能恢复本组，均由现有及新增测试覆盖。
- 自动化测试不等于真实摄像头、真实断网或目标设备验收。

## 2026-10-29 PR #5：历史读取与保存状态反馈

- 实现 commit：`47c13580200bfd85fd7735e8c2eb23d51f9ba4d4`
- 问题：报告 `saved=false` 时，本机历史为空；点击“读取已保存记录”只得到空数组，页面已有静态提示无变化，用户看不到任何反馈。
- 根因确认：
  - `persist` 默认 `false`，分析请求携带 `persist:false`；
  - `analyzeLocal` 用 `saved: Boolean(summary.persist)` 标记报告，并且仅当 `summary.persist` 为 true 才调用 `saveHistory()`；
  - JSON 导出只是当前报告 Blob，不是历史写入；
  - 读取按钮事件本身存在，但空结果未产生任何 UI 状态变化。
- 修复：
  - 读取时显示读取中状态并禁用重复点击；
  - 成功读取 N 条显示数量；
  - 空历史显示“已读取本机历史：暂无已保存记录”；
  - 当前报告 `saved=false` 时明确提示 JSON 导出不会写入历史；
  - 读取损坏历史时显示明确错误，不覆盖原存储；
  - 报告页明确标注 `saved=false` 的保存含义。
- 新增回归覆盖：成功读取 2 条、空历史、损坏历史读取失败、unsaved 报告与 JSON 导出/历史保存的语义区分。
- 实际验证：前端 **295 passed**、后端 **133 passed**、E2E **10/10**、生产构建通过。
- 未自动保存未勾选“同意在本机保存本次摘要”的报告；未自动确认 pending 提案；未删除历史。
- 真实浏览器验证仍为模拟输入；真实摄像头/真实视频不在本轮自动化结论内。
