# 依赖、模型与数据清单

本表是项目清单与复核入口，未表示完成法律审阅。原创代码 MIT 不改变第三方条款。实际 npm 版本看 package-lock，Python 看 requirements.lock。

| 组件 | 用途 | 许可／检查入口 |
|---|---|---|
| React / React DOM | 网页 | MIT，安装包 LICENSE |
| Vite / TypeScript / Vitest | 构建、类型、测试 | 安装包 LICENSE，发布前再次审核 |
| lucide-react | 界面图标 | ISC，安装包 LICENSE |
| @mediapipe/tasks-vision | 姿态 runtime | Apache-2.0，npm 包与上游仓库 |
| Pose Landmarker Lite 权重 | 姿态 | 官方 BlazePose GHUM 3D Model Card：`https://storage.googleapis.com/mediapipe-assets/Model%20Card%20BlazePose%20GHUM%203D.pdf`，Apache-2.0；发布时保留许可/声明，SHA-256 仅作下载完整性校验，不是上游签名 |
| FastAPI / Pydantic / Uvicorn / httpx / pytest | 后端 | 安装包许可，以锁版本逐项复核 |
| Python-Markdown | 文档构建 | BSD，独立工具依赖 |
| llama.cpp（可选） | 同机 LLM 推理 | MIT，上游仓库；不随代码捆绑 |
| Qwen3-4B（候选） | 中文解释 | 官方卡 Apache-2.0；量化产物也检查来源 |
| LangGraph / ONNX Runtime | 规划 | 未作为当前运行依赖引入，接入时补清单 |
| MET、食品数据 | 估算依据 | 当前假设／示例；正式导入逐条核对来源、版本和复用条款 |

发布材料需要：依赖许可证清单、模型卡、数据引用与版本、演示素材授权。不能以“来自网页”或“模型开源”代替授权核对。用户视频、访谈和医疗数据不提交仓库。

2026-10-10 新增参考：jeremyipark/vision-demos（Apache-2.0），仅源码评估与设计借鉴，不是运行依赖，没有复制上游实现。若后续移植，按上游许可保留适用版权/NOTICE并标修改，详见 VISION_DEMOS_REVIEW。

2026-10-21：当前版本移除了 `smplx_official.json`（来源标记为外部人体模型的派生参数），改用 `scripts/prepare_body_template.py` 生成原创示意关节与外观参数。保留旧 TypeScript 接口名只为兼容，不表示包含或实现官方 SMPL/SMPL-X 模型。Git 历史未重写。食品来源与 MET 参数仍待核验，不因共享 JSON 就视为来源合规或准确性已验证。
