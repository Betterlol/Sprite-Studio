# 多策略切割

状态：2026-11-07 设计已批准；实现从 main `ffce38a` 开始，位于 `worktree-multi-strategy-slicing`。

## 目标与范围

支持不规则 spritesheet，保留网格，增加真实透明度连通域与显式矩形，让人和 Agent 经同一份持久配方选择方法。识别区域、统一输出画布、后续动画位姿调整分别处理。只读检测/预览不发布素材；保存配方与执行切割仍是两个明确动作。

用户选择第一版透明图优先，不处理白底去除、复杂背景、语义抠图。不修改生图、补帧专用路径或 1–8 帧限制；不承诺补足缺失姿势、自动确定动作顺序、动态质量或角色脚底识别。

## 方案与取舍

采用扩展现有 sheet-recipe、read_document/write_documents/slice_sheet 链路。仅新增连通域执行工具会割裂可修正结果与稳定身份，不采用；通用抠图模型扩大依赖和不确定性，不采用。新只读 inspect_sheet 返回实际图像证据，不绕过写入权限。

## 配方与像素契约

- v1 网格保持原 schema、序列化、定义哈希、grid-v1 缓存、舍入和补边行为；读取不迁移、不改写。
- v2 严格区分 grid/components/boxes，条目共同字段 id/name/enabled，数组顺序为输出顺序。新项省略 ID，由服务分配；已有本来源 ID 明确表示编辑同一帧，允许修改区域/成员并保持下游引用。不得用检测序号、名称或 bbox 近邻自动继承 ID。
- grid 保留 margin/spacing/cell；boxes 是原图像素半开矩形 [left,top,right,bottom]。两者不隐式 alpha trim。
- components 保存 sourceContentHash、algorithmVersion、检测参数与显式分组的 componentKeys；key 绑定源内容、算法、规范化参数和真实组件掩码，与输出画布、名称、顺序、分组无关。重新检测只给无切片 ID 的候选，明确放入已有条目或新建条目。
- v2 必填统一 output 画布宽高（1–4096）、全局 scale（0.05–4，默认 1）、alignment（center/bottom-center，默认 center）。画布建议必须经明确动作写入本地配方并保存，不随执行自动改变。
- scale=1 不重采样；显式统一 scale 用 nearest，尺寸正数 half-up 舍入，居中 offset 用 floor。透明补边；溢出预览报告，执行拒绝，不自动缩小、裁切或放大画布。不逐帧 contain/拉伸。
- 几何居中/底部居中不是语义锚点，不保证保留跳跃位移；需要时明确修改矩形或后续动画 transform。

## 连通域

复用现有 Python/Pillow worker，不新增 NumPy/SciPy 或模型依赖。确定性 8 邻域标记，alpha > threshold（默认 16），minComponentPixels 默认 1。过滤效果和丢弃数量明确可见，不自动吸附碎片、不为凑帧数切最宽主体。离体武器/粒子可明确分组；粘连姿势用 boxes 修正。组件输出使用归属掩码而不是简单裁 bbox，保留被选像素的原 RGBA；被阈值排除的像素变透明，不能称为全源像素无损。

限额：源图 16,777,216 像素、候选 4096、输出 128 帧、输出总量 67,108,864 像素；连通扫描中间结构另设复杂度上限，避免每个组件复制整图。空图、不透明/疑似全图背景、过滤、未分配组件、帧数不符、超界和溢出均诊断。期望帧数只是校验，不合成/硬拆姿势。

## 检查、身份和发布

- inspect_sheet detect 接受 assetId/expectedSourceRevision/检测参数，不要求预先有条目和画布；返回源身份、参数哈希、算法版本、候选 bbox/key/像素数与真实叠框图。候选每页最多 128。
- preview 接受同样的源版本及完整未保存配方 text，返回已选区域、画布信息、溢出与实际 contact sheet；每批最多 16 帧，返回总数与批边界。不得建临时动画借用 inspect_clip。
- 检查生成不可变、哈希校验的项目内派生缓存，不保存配方、不产生正式资源。显式触发，不在每个键入动作重复检测。
- 结构可读与可执行分开。源哈希/算法/key 过期时仍可读、复制、修复旧配置；保存可执行 components 配方和执行时严格核对来源/成员。检测不受“移除既有引用”的发布校验影响。
- 原有 document CAS、混合文档原子写、ID/跨来源校验、删除/停用引用保护、source/config/output 异步后复核、请求幂等、最终 publication guard 和事务恢复保留。未引用旧切片不自动清理。
- v2 执行/cache 独立版本命名；worker 显式接收 recipeVersion，不从可选字段猜。主机校验输出数量、顺序协议、解码尺寸与预算后发布，不能盲信 worker。

## 网页与 Agent

扩展 SliceConfigPanel：方法参数、数值矩形编辑、可选中原图叠框、组件成员显式分组、条目增删/排序、固定画布与批次预览。forms 和 JSON 共用正文；切换不保存，不丢草稿，不悄悄重分配 ID；外部更新/409/ABA 晚回复不覆盖本地输入。第一版不做绘制/缩放拖拽手柄或自动碎片建议。

Agent 通过 read_document/get_schema/inspect_sheet/write_documents/slice_sheet 使用同样能力。inspect_sheet 继承 read_document 与 inspect_clip 权限、当前任务源范围和队列检查，缓存命中也不豁免；保持只读，不进入 productionWrite，不开放任意路径。证据返回真实 PNG，不把工具成功当切割正确。已通过方向内可自主换方法；实际缺帧或方向不符仍返回 pre-check。

## 实施与验证

顺序：契约冻结 → 纯图像 → 文档/检查/发布服务 → HTTP/MCP/权限 → 最小网页编辑器 → 统一验证。复用 SheetDocuments、ImagingWorker、imagePath/stage/reading、publishFiles、现有不可变预览缓存和组件状态测试套路。

1. 本树独立安装锁文件依赖、生成 protocol 类型，先跑完整基线。
2. 真实 Pillow 夹具覆盖：v1 精确像素，非等距/多行、对角连通、碎片分组、接触/空图/不透明/噪声、阈值与 alpha、重叠 bbox 不串帧、统一缩放与透明放置、溢出及预算。
3. Store/HTTP/stub-runtime 覆盖来源/配置/输出竞态、原子混合写、稳定 ID、引用/缓存/幂等/回滚、权限 deny/ask、handoff 与旧发布屏障、实际图片证据。
4. UI 覆盖方法切换不丢数据、分组/矩形/重排、源/配方/请求过期、409 保留正文和 JSON 修复。
5. npm test、typecheck、build、diff --check；独立端口和合成工程真实浏览器操作检测→修改→预览→保存→执行→动画，检查 console/network 并截图。

现有正式服务、工程素材和其他分支不改；不运行真实模型/生图，不自动提交、推送、合并或停止其他服务。
