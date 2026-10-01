# Claude Desktop Render Patch

给 Claude Desktop 补上 **Mermaid 图表**和**完整 TeX 数学公式**渲染。通过 npm 发布，运行后提供与 `incipit` 相同风格的交互式终端菜单。

```bash
npx @arsonist-g/claude-desktop-render-patch
```

## 效果

- Mermaid 12.0.0：流程图、时序图、类图、状态图、ER 图、甘特图、饼图、思维导图、时间线、象限图、需求图、C4、Git 图、桑基图、XY 图、块图、Packet、架构图、雷达图、TreeMap 等。
- MathJax 3.2.2 full TeX build：行内公式、显示公式、AMS、矩阵、多行对齐、`mhchem`、`physics`、`boldsymbol`、`mathtools`、`cancel`、`unicode`、`verb` 等扩展。
- 自动处理 `\(...\)`、`\[...\]`、`$$...$$`、`$...$` 以及常见 `language-math` / `language-latex` / `language-katex` 代码块。
- 渲染失败时保留源码，并提供“源码”按钮。
- 深色 / 浅色主题会重新渲染 Mermaid。

## 菜单

`npx` 不带参数启动时，会出现类似下面的交互菜单：

```text
╭ Claude Desktop Render Patch ───────────────────────────────╮
│ msix · Claude 2.9939.2  可写                                │
│ Mermaid 12 + MathJax 3 full TeX                             │
╰────────────────────────────────────────────────────────────╯

❯ 应用补丁  注入 Mermaid 与完整数学公式渲染
  恢复原版  从本机备份恢复 app.asar
  检查状态  显示安装、载荷与完整性哈希状态
  切换目标  选择其他 Claude Desktop 安装
  重新检测  刷新 Claude Desktop 安装列表
  退出
```

键盘：`↑/↓` 选择，`Enter` 确认，`q` 退出。

## 命令行

```bash
# 应用补丁
npx @arsonist-g/claude-desktop-render-patch apply

# 检查状态
npx @arsonist-g/claude-desktop-render-patch status --json

# 恢复最近的备份
npx @arsonist-g/claude-desktop-render-patch restore

# 重新写入已安装的补丁
npx @arsonist-g/claude-desktop-render-patch apply --force --yes

# 自动关闭正在运行的 Claude Desktop
npx @arsonist-g/claude-desktop-render-patch apply --kill --yes
```

可选参数：

| 参数 | 作用 |
| --- | --- |
| `--yes` | 跳过确认 |
| `--force` | 已安装时重新写入 |
| `--no-backup` | 不创建备份，不建议 |
| `--kill` | 自动关闭 Claude Desktop |
| `--restart` | 操作后重新启动 Claude Desktop |
| `--target=<id|path>` | 指定目标安装 |
| `--json` | `status` 输出 JSON |

## 工作原理

1. 读取 `app.asar`，定位 `.vite/build/index.chunk-6aZ703Pj.js` 中创建主视图 `WebContentsView` 的位置。
2. 在 `dom-ready` 后向 `claude.ai` 页面注入 MathJax 与 Mermaid 载荷。
3. 置空对应 V8 编译缓存，避免 Electron 命中旧字节码。
4. 更新 `Claude.exe` 内嵌的 `app.asar` header 哈希。
5. 所有渲染资源放在 `app/resources/third-party-render/`，原 `app.asar` 备份在 `app/resources/.third-party-render-backups/`。

## 支持范围

| 平台 / 安装方式 | 状态 |
| --- | --- |
| Windows Store / MSIX（Claude `2.9939.2`） | 已在本机完成应用、恢复与真实窗口渲染验证 |
| Windows 非 Store 安装 | 代码路径已实现，未在同一版本上实测 |
| macOS / Linux | 代码路径已实现，未实测；修改 app 后可能需要重新签名 |

Claude Desktop 更新后 `app.asar` 结构可能变化。当前补丁只声明支持 `2.9939.2`，遇到新版本会拒绝写入，避免误改。

## 风险与回滚

- 补丁会修改 `app.asar` 和 `Claude.exe`，会破坏 Windows Authenticode 签名。
- 应用补丁前会自动备份原 `app.asar` 和原始 `Claude.exe` 完整性哈希。
- 运行 `restore` 可以恢复；如果应用无法启动，也可以从备份目录手工复制回 `app.asar`。
- 不需要 Cowork / 截图工作区时再考虑使用；修改签名后相关签名校验功能可能受影响。

## 开发

```bash
npm run build
npm test
npm pack --dry-run
```

`npm test` 包含 JS 语法检查、asar 往返测试、模拟安装 / 恢复测试。

## 第三方组件

- Mermaid 12.0.0，MIT。
- MathJax 3.2.2，Apache-2.0。

完整许可文本见 `THIRD_PARTY_NOTICES.md` 与 `data/licenses/`。

## 图表卡片

Mermaid 渲染会显示为带工具栏的卡片：

- `Diagram` 标题和 `mermaid` 类型标签。
- 复制按钮：复制 Mermaid 源码。
- `−` / `＋`：缩小、放大图表。
- `⤢`：打开完整大图模式。
- 没有“重新生成”按钮。

预览默认限制在约 `460px` 高度；内容过长或过宽时只展示局部，并保留展开入口。

- 按住左键拖动预览区域可以平移图表，滚轮也可以平移（平移范围被限制在图表边界内，不会拖出空白）。
- `−` / `＋` 只缩放框内的图，预览框本身的尺寸不变。
- 按钮动作同时挂在 document 捕获阶段的坐标匹配上：即使有别的元素盖在按钮上、或者宿主在 mousedown 后重排 DOM，点击依然命中。
- 卡片上只保留 `复制` 和 `⤢`；`−` / `＋` 只在大图里出现。
- 打开完整大图后，整张图会按比例缩放进画框，画框宽度跟着当前会话列（100%），高度上限等于画框宽度，顶部操作条跟着进入画框。
- 大图里支持 `Ctrl + 滚轮` 缩放，普通滚轮平移，按住左键拖动也可以平移。
- 缩放、平移状态在打开完整大图时会重置，关闭后再回到卡片。

### 流式输出

模型一边输出、DOM 一边变化时不会渲染，等到输出停顿约 `0.4s` 才开始解析：

- 半截的 Mermaid 源码不会先画出一张残缺的图，也不会显示语法错误。
- 渲染前会先用 `mermaid.parse` 校验，校验不过就静默重试，不会把 Mermaid 自带的报错大图插进页面。
- 代码块内容变化后会重新渲染一次，最终图与最终源码一致。
