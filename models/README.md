# 模型资产

不提交模型权重。姿态模型用 `npm run prepare:models` 下载到 `frontend/public/models`；脚本会保存来源、SHA-256 和准备时间。

2026-10-26 当前工作区已准备：

- `frontend/public/models/pose_landmarker_lite.task`，官方 Google Storage URL，5,777,746 bytes，SHA-256 `59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a`。
- `frontend/public/wasm/` 下 4 个 `@mediapipe/tasks-vision@0.10.32` WASM/JS 资源。
- `frontend/public/models/manifest.json` 记录来源、模型卡、Apache-2.0 许可声明与哈希；模型卡：`https://storage.googleapis.com/mediapipe-assets/Model%20Card%20BlazePose%20GHUM%203D.pdf`。该 manifest **不是**上游可信签名。
- 发布/再分发时需保留官方 BlazePose GHUM 3D Model Card 的 Apache-2.0 许可与适用声明；本仓库不宣称已完成法律审阅。

这些是生成物，Git 忽略；干净 clone 仍需在受控网络下准备后重新 build。`scripts/check_local_assets.py` 对构建模型独立校验固定 SHA、WASM 与旧人体资产标记；`prepare-models.mjs` 也会拒绝不匹配的下载摘要，不得自动把新摘要当作可信摘要。

可选中文 LLM：先查看官方模型卡及许可，再使用 llama.cpp 在同机回环地址启动服务。不要把生产健康信息发送给公共模型接口。

当前网页使用原创程序化示意骨架（`frontend/src/body_template.json`，source 标注为 LocalFit contributors，MIT）。它不使用官方 SMPL/SMPL-X 权重或派生参数；旧 Git 历史中的早期外部人体资产不在本次发布构建中。

权重、缓存、WASM 不属于当前仓库的原创代码许可证。详见 `docs/DEPENDENCIES.md`。
