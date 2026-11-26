# Token Flow · Token 落点版

用户于 2026-11-26 确认采用这版：瀑布落点处带倾斜 token 和水花。母版按已确认预览进行黑白矢量化，保持整体轮廓、卷边、token 倾斜与三处水花；没有继续改换设计方向。

## 文件

- token-flow-logo.svg：主标，两条内线、倾斜 token、面内短杠和三处水花。
- token-flow-logo-small.svg：16–24px，去掉三处小水花、token 内短杠及靠近 token 的内线；保留外轮廓、token 与一条下落线。
- token-flow-mono.svg / token-flow-white.svg：主标的镂空单色／反白稿。
- token-flow-favicon.svg / ico：带白底的小尺寸图标，保证浅深色标签页中可见。

主色 #020202，白色 #FFFFFF。所有 SVG 为真正填充路径，无字体、描边、滤镜或嵌入位图。主标中的白色底只铺在外轮廓内部；单色和反白稿则保留透明孔洞。

四周至少保留绘制宽度约 5% 的留白。常规主标建议至少 32px；16–24px 使用专用稿；不单独移动 token、拉伸或旋转整个标志。现有 Token Flow 名称排版与 UI 字体沿用原实现。

项目内 ui/public/assets 为源资源；token_tap/viewer_assets 主标同步。token_tap/static_ui 通过 lint、typecheck、build、sync 更新，不手工编辑。

独立 HTML Viewer 的主标继续使用完整稿，favicon 则读取 `viewer_assets/token-flow-favicon.svg` 并内嵌为 data URI；该文件与 `ui/public/assets/token-flow-favicon.svg` 字节一致，避免把完整主标直接缩成 16px。
