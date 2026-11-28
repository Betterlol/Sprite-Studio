# 网页一键导出

## 目标与范围

网页顶部“导出”按钮把当前工程已保存的动画一次性打包成 ZIP：PNG 帧序列、PNG 图集与 TexturePacker JSON、WebP、GIF，或整个工程归档。它替代旧版逐项导出的入口体验，但只读取已保存的动画快照，不修改资源、不写入动画配置。

导出的边界保持现状：

- 未保存的动画草稿、帧草稿不进入导出；需要导出先保存。
- 参考图、原图素材本身不单独导出，只有“完整工程”格式会带上 `Assets` 下的全部文件。
- 不新增 Agent 导出工具；网页点击是人工入口，导出产物不登记为项目资源。
- 生成的 ZIP 保存在工程 `Exports/` 目录，不覆盖已有文件；只清理 `Exports/` 之外的临时目录。

## 界面流程

1. 顶部“导出”打开对话框。已有导出记录会列出文件名、时间、大小和格式。
2. 选择格式：完整动作资源、PNG 帧序列、图集、WebP、GIF、Review 序列、完整工程。
3. 动作类格式可勾选要导出的动画；默认全选。Review 格式选择一条未归档的 Review 序列，导出其当前重复次数与倍速展开后的播放。
4. 点击“生成并下载 ZIP”。服务端异步生成，网页轮询进度并显示阶段与完成项；完成后自动下载，也可随时点击记录重新下载。
5. 生成过程中可以取消；已开始的单个图像任务会在当前步骤结束后停止，不产生半成品 ZIP。

服务端同一工程同时只允许一个导出任务；第二个请求返回 409。完成、失败、取消都会保留记录，网页可继续下载。

## 产物结构

动作资源（`all` 与单项格式）按动画名组织：

```text
export.json                     本次导出的格式、动画、文件清单与播放信息
frames/<动画>/<动画>_00.png     游戏帧顺序的 PNG 帧
atlas/<动画>.png                图集
atlas/<动画>.json               TexturePacker JSON Hash（未裁剪、含每帧 duration）
webp/<动画>.webp                无损 WebP
webp/<动画>.animation.json      播放顺序与逐帧毫秒
gif/<动画>.gif                  GIF（256 色、二值 alpha）
gif/<动画>.animation.json       同上
```

- 帧顺序与停留时长取自动画帧实例；WebP 使用 `loop=0` 表示无限循环、`loop=1` 表示播放一次，GIF 按 GIF 语义换算。
- 图集列数默认 4，可在请求中指定 1–32；单轴超过 16384 像素时拒绝生成并提示调整。
- 导出动画若存在画布不一致的帧，会拒绝并给出错误，不做逐帧缩放。
- `review` 格式输出 `review/<序列>.webp`、`review/<序列>.gif` 和一份 `review/<序列>.animation.json`，`export.json` 记录序列版本与快照。
- `project` 格式输出 `Assets/` 下全部文件（含图片、动画配置、`.meta.json`、切割配方与文档）、`project.json` 和 `export.json`。

## 服务端实现

| 文件 | 职责 |
| --- | --- |
| `studio/export-formats.ts` | 格式枚举、名称与说明；不依赖 Node API，网页可直接引用 |
| `studio/export.ts` | 导出任务：校验、选片、快照、渲染帧、进度、取消、记录与 ZIP 命名 |
| `studio/export_imaging.py` | Pillow 生成帧 PNG、图集、WebP/GIF 与播放 JSON；暂存短路径 |
| `studio/zip.ts` | 按条目写 ZIP（UTF-8 名称、CRC32、deflate、中央目录），不依赖第三方库 |
| `studio/imaging.py` | 增加 `export_clip` 分发入口 |
| `studio/server.ts` | `/api/projects/:projectId/exports` 一组路由 |
| `web/ExportDialog.tsx` | 导出对话框、进度轮询、自动下载与导出记录 |

- 每个动画先由 `AnimationStore.capture` 固定快照，再逐帧 `renderFrame`，因此导出与工程后续保存互不影响。
- Python 只写 `.studio/exports/<任务ID>` 下的短相对路径（`f/000.png`、`a.png`、`w.webp`、`g.gif` 等），由 TypeScript 映射成可读的 ZIP 条目；这样深层数据目录也不会触碰 Windows 路径上限。ZIP 由 Node 写入，避免 Python 在长路径上遍历。
- 所有写入都经过 `ProjectStore.safePath`；导出期间使用 `store.reading()`，整工程删除会被拒绝直到导出结束。
- 失败或取消会删除暂存目录；进程重启时 `ProjectExports` 构造器清理遗留暂存目录，不影响已完成的 ZIP。

## HTTP 接口

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/projects/:projectId/exports` | 已完成的 ZIP 记录与近期任务 |
| `POST /api/projects/:projectId/exports` | 创建任务，返回 `202` 与任务状态 |
| `GET /api/projects/:projectId/exports/jobs/:exportId` | 查询阶段、完成项与结果 |
| `POST /api/projects/:projectId/exports/jobs/:exportId/cancel` | 请求取消 |
| `GET /api/projects/:projectId/exports/files/:fileName` | 下载 ZIP；校验文件名与工程范围 |

请求体：`{format, clipIds?, reviewSequenceId?, columns?}`，`format` 取 `all`、`frames`、`atlas`、`webp`、`gif`、`review`、`project`。

## 本轮边界与检查

- 不增加导出预览播放器、自动上传、云同步或按资源单独导出；WebP/GIF 是否好看由人实际播放判断，工具只保证文件可解码。
- 长路径依赖 Node 写 ZIP、Python 短路径暂存的分工；真实数据目录超过 260 字符时仍有覆盖，但未在集成测试中专门构造该深度。
- 本地按约定不运行构建与浏览器核验，也未运行完整测试套件。`npm run typecheck` 仅报出 `studio/frame-drafts.test.ts` 两处既有错误（`userApproval` 联合类型），与本次改动无关；`node --test studio/export.test.ts` 的三项检查通过：完整动作资源（帧、图集、WebP、GIF 实际解码为 2 帧且循环为无限）、Review 序列展开（重复 2 次、2 倍速，GIF 4 帧）、格式参数拒绝。整页交互与真实工程导出仍需开发者在浏览器确认。
