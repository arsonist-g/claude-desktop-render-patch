# Open project in Claude Desktop

给 Windows 资源管理器加一个右键菜单项：右键文件夹 → **Open project in Claude Desktop**，直接把该文件夹作为项目在 Claude Desktop 里打开。

对标 ChatGPT 桌面版的 `Open project in ChatGPT`。

## 安装

在这台机器上请用整机作用域（见下面的「生效时机」）。脚本会自己弹 UAC：

```powershell
.\open-project\install.ps1 -Scope Machine
```

也可以双击 `OpenProjectInClaude.cmd`，它同样走整机作用域并自提权。

只装当前用户（不需要管理员）：

```powershell
.\open-project\install.ps1
```

菜单文字可以改：

```powershell
.\open-project\install.ps1 -Scope Machine -Label "在 Claude Desktop 中打开项目"
```

## 卸载

```powershell
.\open-project\uninstall.ps1
```

会同时清理 HKCU 和 HKLM 两处，并删掉抽出来的图标文件。清理 HKLM 和 `ProgramData` 需要管理员，没提权时会跳过并警告。

## 效果

| 项目 | 值 |
| --- | --- |
| 菜单文字 | `Open project in Claude Desktop`（可用 `-Label` 改） |
| 图标 | 安装时从 `claude.exe` 抽出 256×256 全彩图标，拼成 16/20/24/32/48/256 六个尺寸的 32 位 ico，存到 `%ProgramData%\ClaudeOpenProject\` |
| 排序 | `Position=Top`，排在右键菜单最前面 |
| 生效位置 | 文件夹、文件夹空白处、磁盘根目录 |

图标之所以要抽出来，是因为 Claude 装在 `C:\Program Files\WindowsApps\Claude_<版本>\...`，升级后目录会变；存成固定路径的 `.ico` 后，Claude 升级不会让菜单图标消失。

图标文件名带内容哈希（`claude-<hash8>.ico`）：一是绕开资源管理器的图标缓存，二是每次重新安装会自动清掉旧文件。

注意不能图省事用 `Icon.ExtractAssociatedIcon` 抽图 —— 它只给一个 16 色的 32×32 图标，菜单按 16×16 取图时会被降成灰白色。所以这里先用 `PrivateExtractIcons` 取 256×256 全彩，再自己拼多尺寸 ICO。

## 生效时机

| 作用域 | 写入位置 | 何时出现在右键菜单 |
| --- | --- | --- |
| `Machine` | `HKLM\Software\Classes\...` | 立即 |
| `User` | `HKCU\Software\Classes\...` | 本机实测无效，见下 |

本机（Windows 11 25H2 / 26200）实测：**用户级动词根本不出现**，重启也没用。所以请用 `-Scope Machine`。

## 排查记录（本机）

同一台机器上做过的对照，都指向「HKCU 的 `Directory\shell` 动词不生效」：

| 实验 | 结果 |
| --- | --- |
| 新加 `notepad.exe "%V"` 测试项 | 不出现 |
| 新加与 VSCode 逐字节同形的键（同 exe、同 Icon） | 不出现 |
| 一次写入 `Directory` / `Folder` / `AllFilesystemObjects` / `Directory\Background` 四个 class | 全部不出现 |
| 把已有的 `HKCU\...\Directory\shell\VSCode` 键改名移走 + 重启 Explorer | 菜单里「通过 Code 打开」**依然在** |
| 把该键的显示文字改成 `ZZZZ Live Test` | 菜单仍显示旧文字 |
| 完整重启电脑（Fast Startup 关闭）后复查 | 上面的现象全部照旧 |
| 菜单里其余条目来源 | 全部来自 `HKLM\Software\Classes` 或打包应用（ChatGPT / Windows Terminal） |

结论：这台机器上 shell 读取的是一份不跟随注册表变化的用户级动词快照，写 HKCU 加不进去；HKLM 那部分正常。

## 它做了什么

写入三个位置（每个都是 `标签 / Icon / Position / MultiSelectModel / command`）：

| 注册表位置 | 生效场景 |
| --- | --- |
| `<Classes>\Directory\shell\OpenProjectInClaudeDesktop` | 右键文件夹 |
| `<Classes>\Directory\Background\shell\OpenProjectInClaudeDesktop` | 右键文件夹里的空白处 |
| `<Classes>\Drive\shell\OpenProjectInClaudeDesktop` | 右键磁盘根目录（`D:\` 之类） |

`<Classes>` 是 `HKCU\Software\Classes`（`-Scope User`）或 `HKLM\Software\Classes`（`-Scope Machine`）。

启动命令：

```text
"C:\Users\<用户名>\AppData\Local\Microsoft\WindowsApps\claude-desktop.exe" "claude://code/new?folder=%V"
```

`claude-desktop.exe` 是 Claude 的 MSIX 执行别名，指向当前版本，Claude 升级后不用重装这个右键项。

## 为什么用深链

Claude Desktop 自己带了「Open in Claude Code」右键项，但代码里对 **MSIX 安装**和**第三方部署**（`deploymentMode: 3p`）是主动关掉的。实测启动日志会打印：

```text
fileHandler: folder verb ignored (entry points off)
```

`--os-entry=folder_verb` 收得到参数但不执行。`claude://code/new?folder=<路径>` 深链不受这个开关影响，实测可用，所以走深链。

## 已知限制

- 要进 Windows 11 第一层（新式）右键菜单得做稀疏包（Sparse Package），本工具没做。
- 路径里的空格、中文都支持，已在 `D:\Dev\Temp\claude probe space` 上实测。
- 路径里带 `&` 的极端情况没测，理论上会被当成 URL 参数分隔符。
- 只在 Windows 上有效。

## 验证记录

- 注册表写入/回读：三处键值正确（含 `Icon`、`Position=Top`）。
- 图标抽取：`System.Drawing.Icon.ExtractAssociatedIcon` 从 `claude.exe` 得到 32×32 图标，落盘 `.ico` 头正确（`00 00 01 00`）。
- 深链端到端：用注册表里的原样命令行打开 `D:\Dev\Temp\claude probe space`，Claude Desktop 弹出针对该路径的 “Trust this workspace?” 对话框，确认文件夹被正确传递。
- 冷启动：只做静态确认（主进程 ready 时遍历 `process.argv` 分发 `claude://`），没有关掉正在运行的 Claude 去实测。
