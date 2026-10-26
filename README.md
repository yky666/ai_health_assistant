# LocalFit Agent · 本地健身教练

面向居家健身新手的开源端侧教练：**动作反馈 → 用户疲劳反馈 → 计划调整 → 用户确认 → 训练复盘**。

参加第四届开放原子大赛 · 2026 开源行业解决方案创新赛 **赛道一**。团队：4–5 人，算法与网页全栈；最终目标设备：普通笔记本＋摄像头；开发可使用 4090，训练可使用 A100。提交截止：2026-10-31 24:00（Asia/Shanghai）。

**公网演示：** https://yky666.github.io/ai_health_assistant/ （GitHub Pages，无需本机启动；摄像头与视频识别在浏览器内完成。）

> 当前是 v0.1.0 可运行框架，不是经过真实人群验证的健康产品。模拟数据、待验证规则、示例食品数据和可选模型均在界面标明。多 Agent 默认采用确定性角色节点；LangGraph 和学习型动作模型列入后续任务。

## 文档入口

**10/29 冲刺：** [最新资产盘点与四人分工](docs/冲刺分工_2026-10-29.md)（杨开元、刘小凡、王靖贻、徐倩茹；2026-10-21 代码核对）。

**10/22 杨开元 / 刘小凡交付：** [实施与交接记录](docs/IMPLEMENTATION_2026-10-22.md) · [合同冻结](docs/CONTRACT_FREEZE_2026-10-22.md) · [标注及回放规范](docs/ANNOTATION_PROTOCOL.md)。上一轮：[10/21 实施记录](docs/IMPLEMENTATION_2026-10-21.md) · [待填写人工验收表](docs/ACCEPTANCE_CHECKLIST.md)。

| 用途 | 文档 |
|---|---|
| 完整分析、比赛、产品与可行性 | [方案分析](docs/方案分析.md) |
| 演示与交流 | [独立展示文档](docs/展示文档.html)（下载后用浏览器打开，可打印为 PDF） |
| 架构、Agent 流与状态 | [ARCHITECTURE](docs/ARCHITECTURE.md) |
| 数据合同与接口 | [API](docs/API.md)；运行后 http://127.0.0.1:8000/docs |
| 分工与进度 | [TASKS](docs/TASKS.md)、[ROADMAP](docs/ROADMAP.md) |
| 算法、评测、验收 | [EVALUATION](docs/EVALUATION.md) |
| 离线、隐私与部署 | [PRIVACY](docs/PRIVACY.md)、[SETUP](docs/SETUP.md) |
| 许可、参考与决策 | [DEPENDENCIES](docs/DEPENDENCIES.md)、[SOURCES](docs/SOURCES.md)、[ADR](docs/ADR.md) |
| vision-demos 借鉴与接入 | [源码评估](docs/VISION_DEMOS_REVIEW.md) |
| 本次实际验证 | [VALIDATION](docs/VALIDATION.md) |

## 快速启动（Windows PowerShell）

需要 Node.js 22.12+、Python 3.11+；首次安装需要网络。两终端分别运行。

```powershell
# 终端一：仓库根目录
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend/requirements.lock.txt
.\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

```powershell
# 终端二：仓库根目录
cd frontend
npm ci
npm run dev
```

打开 http://127.0.0.1:5173 。默认“模拟演示”，无需摄像头或模型权重；点击开始、训练十余秒、调整疲劳、结束复盘，查看协作记录并确认下一组目标。

真实摄像头在 `frontend` 中先准备资源：

```powershell
npm run prepare:models
```

切换“真实摄像头”并授权。默认仅从同源 `/models`、`/wasm` 加载，禁止 CDN 回退；只有显式选择 `assets=online` 才允许公共资源。首次下载的哈希记录在 manifest 中，**它不是上游可信签名**。Windows 等终端的模型下载、许可核对和离线验收见 [SETUP](docs/SETUP.md)。

## 单服务本地展示

先在 frontend 中运行 `npm run prepare:models` 和 `npm run build`，再启动／重启上述后端。FastAPI 会同时提供构建后的网页与 API，打开 **http://127.0.0.1:8000**，无需 Vite 开发服务。首次准备完依赖与资产后，运行期可在本机完成；完整断网重启验收仍需执行。

默认 `?runtime=browser`：规则和摘要在浏览器中运行；经同意保存至 sessionStorage（最多 50 条，与后端读取上限一致，关闭标签页不保证保留），支持历史 JSON 导出。使用本机 API、SQLite 或可选 LLM 时选择 **`http://127.0.0.1:8000/?runtime=backend`**。模式固定，请求失败不会偷偷切换计算来源。切换链接会重载并结束当前训练。资源默认严格同源；显式 `&assets=online` 才允许 CDN，不属于严格离线模式。

## 公网访问（不需要自己买域名或服务器）

当前公开地址：**https://yky666.github.io/ai_health_assistant/**

比赛演示用 **GitHub Pages** 即可，仓库已带 `.github/workflows/pages.yml`。在 GitHub 仓库 Settings → Pages → Source 选 **GitHub Actions**，推送到 `main` 或手动运行该工作流。

- 不需要单独购买域名，也不需要自建云服务器。
- Pages 自带 HTTPS，浏览器才能调用摄像头。
- 静态页可做姿态识别、原创演示骨架、输入参数外观调整、能耗情景估算和浏览器内复盘；FastAPI 历史库与本地 LLM 仍需本机后端。
- 公网页自动走浏览器本地教练，**不会把未鉴权的 FastAPI 暴露到公网**。需要完整 API 时再在本机启动后端，或用带登录的托管服务。

## 当前代码实现

- React 网页：训练、复盘、饮食记录、项目协作四个视图，响应式布局。
- 可复现的模拟动作回放；真实摄像头或上传视频 → Web Worker → MediaPipe 姿态接线。
- 视频与骨架按原比例对齐；使用原创手工比例的演示骨架，不包含官方人体模型参数，不测量肌肉或真实体型。
- 默认深蹲/开合跳核心入口，另外 28 个实验动作，以及可搜索匹配的示例食物库。
- 画面宽高比校正；深蹲次数与实验幅度独立，逐次下降/起身时间、最低角度和不可评价状态。
- FastAPI：结构化摘要、规则角色协作、版本检查、计划确认、示例能量计算。
- 摘要默认仅内存；勾选同意后按模式保存至标签页 sessionStorage（最多 50 条）或本机 SQLite（读取最多 50 条）；支持当前报告导出、历史 JSON 导出和删除。模型/摄像头中断或资源加载失败会在页面提示并可重试，不静默换用另一套计算来源。
- 同机 llama.cpp 可选解释接口，超时降级；不允许模型直接修改计划。
- 单元/API 测试、GitHub CI、Issue 与 PR 模板、任务和维护约定。

## 实现与目标的区别

| 能力 | 状态 |
|---|---|
| 模拟计数、规则协作、API、计划确认 | 已实现；见验证记录 |
| 摄像头姿态与计数 | 已接线；真实动作精度待人群验证 |
| 演示骨架与参数化外观 | 原创示意数据；保留旧内部类型名兼容，不是 SMPL/SMPL-X 模型或人体测量 |
| 自动机位判断、个体校准 | 待实现，当前机位提示＋实验阈值 |
| MET 消耗 | 演示用假设范围，未映射完整活动表 |
| 食品计算 | 示例食物库可搜索匹配，非正式营养库 |
| 本地 LLM | 可选适配器，真实模型端到端待测 |
| LangGraph、多模态语音、时序模型 | 规划项 |
| 表情疲劳、食物照片份量、医疗用途 | 不纳入本次核心范围 |

10/21 更新：能耗按实际时钟的活动/静止/未知分段，只估算已分类片段，不从次数、可见性或整组时长强行补造活动时间。未知数据不显示成完整训练消耗。双端共享 `shared/energy_catalog.json` 和黄金样例；MET 仍为待来源核验的场景参数。详见 [本轮实施记录](docs/IMPLEMENTATION_2026-10-21.md)。

## 测试

```powershell
# 根目录
.\.venv\Scripts\python.exe -m pytest backend/tests -q
cd frontend
npm test
npm run build
```

## 仓库结构

```text
backend/app/       数据合同、API、协作基线、存储、本地模型适配器
backend/tests/     规则与接口约束测试
frontend/src/      网页、动作引擎、姿态 Worker
frontend/scripts/  模型准备工具
docs/              方案、架构、分工、评测、展示文档
scripts/           文档导出、项目检查工具
models/            权重准备说明（权重不提交）
.github/           CI、Issue、PR 模板
```

## 协作

先认领 [TASKS](docs/TASKS.md) 中的任务，再建立 `feat/<任务编号>-<描述>` 分支，PR 写清变化、验证与剩余限制。没有实名分工前只使用 A–E 角色，不假定具体成员已认领。模型、食品数据、个体规则的更新必须补来源与验证。主分支用于可演示版本；分支保护需仓库管理员在 GitHub 设置。

原创代码采用 [MIT](LICENSE)；第三方组件、模型、数据遵循各自许可。原始会议纪要保留在本地且已忽略，不上传个人训练数据或凭据。
