# Aexus Code

基于 Microsoft 官方 [VS Code 1.146.0](https://github.com/microsoft/vscode/releases/tag/1.146.0) 的 macOS Apple Silicon 开发基线。上游提交：`69047191fc427f2f92828279aae1d90d8eeda7ab`，本地开发分支：`aexus/main`。

## 开发与构建

构建工具安装在本仓库忽略目录 `.build/toolchain/`：Node.js `24.22.1`、pnpm `12.16.0`。以下包装脚本让命令使用这些版本，不修改系统 Node.js。

```sh
# 安装依赖（初次安装或依赖发生变化时）
./scripts/aexus-env.sh pnpm install --frozen-lockfile

# 编译开发版
./scripts/aexus-env.sh pnpm run build-fast

# 从当前源码运行
./scripts/aexus-env.sh ./scripts/code.sh

# 持续编译，修改源码后在应用中执行 Developer: Reload Window
./scripts/aexus-env.sh pnpm run watch

# 构建独立 macOS arm64 应用
./scripts/aexus-env.sh pnpm run gulp vscode-darwin-arm64

# 退出已运行的 Aexus Code 后，后台签名并安装（不自动打开窗口）
./scripts/aexus-install.sh
```

独立应用临时输出到相邻目录 `../VSCode-darwin-arm64/Aexus Code.app`。安装校验成功后，脚本会删除该构建副本及 `.build/electron/Aexus Code.app` 开发运行副本，唯一保留 `/Applications/Aexus Code.app` 的最新版本，不保留旧版或备份应用包。安装副本不会随着源码修改自动更新，需要重新构建并安装。单独运行源码产生的临时应用包，也必须在开发验证结束后清理。

签名使用本机 ad-hoc 开发签名，未做 Apple Developer ID 签名或公证。包装脚本也会让 Node.js 下载遵循已有的 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量。

## 修改入口

- `product.json`：应用名称、Bundle ID、URL 协议、独立数据目录。
- `resources/aexus/icon.svg`：黑底白色应用图标的矢量源文件。
- `resources/darwin/code.icns`：macOS 应用图标。
- `src/vs/workbench/`：工作台界面与功能。
- `src/vs/editor/`：编辑器核心。
- `extensions/`：内置扩展。

用户设置保存在 `~/Library/Application Support/Aexus Code`，扩展目录为 `~/.aexus-code/extensions`。安装脚本同步整个应用包并删除旧包中多余的文件，不修改这些用户数据目录。上游 MIT 许可及版权声明保留。

## 已安装插件与右侧栏

顶部插件图标只列出已安装的用户插件，每个插件显示一次，不包含搜索、调试、源码管理、Outline、Timeline 或扩展市场等内置工具。有面板的插件在右侧栏打开；没有面板的插件进入自身的已安装详情页。插件同时提供主侧栏和原生右侧栏时，优先打开当前可用的原生右侧面板。

右侧标题区提供统一的插件切换按钮和项目标识。Coding Agent 显示自身实际绑定的项目；普通插件显示 IDE 当前选中的项目，ADE 模式显示当前项目或子会话所属项目。点击项目标识可选择项目；IDE 中仅更新当前 Coding Agent 的项目绑定，其余插件的绑定保留。只有一个工作区项目时自动识别，多项目未选择时显示“无项目”，避免误用第一个根目录。

已同步原版 VS Code 的有效市场插件并补齐全部 8 大本机 Coding Agent 扩展，保留 Aexus 原有的 Prettier 和较新 Codex。应用启动时自动从原版 VS Code 非破坏性迁移网络代理（`http.*`）与 Coding Agent 相关用户配置、`state.vscdb` 中非密钥的扩展全局状态（严格排除 `secret://` 密钥条目）、`globalStorage` 扩展数据与缺失的 Coding Agent 扩展；已有设置与更新状态保持不变。同时将 `http.proxy` / `http.proxySupport` / `http.noProxy` / `http.systemCertificatesNode` 与标准 CLI `PATH` 自动透传至扩展宿主（`NativeLocalProcessExtensionHost`）及 `aexus-agents` 拉起的所有子引擎进程。

Codex、Claude Code、Cline、Kilo Code、DSH、OpenCode 和 Antigravity 的面板已通过隐藏窗口实际打开验证。OpenCode 的侧栏由已安装的 `zgy.opencode-vscode-ui` 提供，`sst-dev.opencode` 同时保留其原有终端命令。

## 文件树顺序与项目 Focus

普通拖拽可调整同一父目录下文件和文件夹的显示顺序，项目根目录也支持重排。拖放到条目的上半部插到前面，下半部插到后面；多选条目保持原有相对顺序。排序保存在当前工作区，优先于名称排序；普通跨层级拖拽会被拒绝，排序不会移动磁盘上的文件。

在左栏项目根目录上右键选择 **Focus** 进入项目。顶部左侧显示 **Home** 按钮，点击返回项目主页面；返回后显示前进图标，可重新进入刚才的项目。如果改为 Focus 另一个项目，前进目标会更新为新项目，不会跳回旧项目。工作区原有项目列表与已打开文件保留。IDE 与 ADE 共享同一套项目宇宙、顺序与 `Focus ➔ Home ⇄ Forward` 导航状态。

## ADE（Agent Development Environment）Phase 1

ADE 与 IDE 呈镜像对称架构（单分支同目录协作，无需 Git Worktree）：

- **左边栏（Agent 调度中心 `AdeProjectsView`）**：
  - **顶置全局 `✦ Secretary`**：常驻左栏顶部（Home 与 Focus 下均可见），具备实时视口与全树感知能力（自动感知当前模式、Home/Focus 状态、活跃项目、活跃编辑器与实时会话层级树），拥有操作 ADE 内全部要素（项目、视图、引擎、会话树、职级、热拔插、归档、草稿与自身会话）的完备接口，并严格限定仅操作 ADE（禁止切换或操作 IDE 模式视图）。
  - **`Projects` 项目会话树 + `Archived` 归档过滤**：展示项目文件夹与多路并行主理会话（Focus 模式下仅聚焦单项目根并自动展开会话树，不在左栏混杂源码目录或引擎内部默认子代理），支持一键切换查看已归档会话。
  - **四级职级体系与下属直控能力**：建立清晰的 `Governor（L1）➔ Manager（L2）➔ Employee（L3）➔ Worker（L4 最低级）` 职级梯队。新建顶层会话时可显式选定职级，在会话内新建子会话自动降一级分配（`Governor ➔ Manager ➔ Employee ➔ Worker`，底层 `Worker` 不再向下嵌套）；支持将下级会话拖拽到同项目或跨项目的任意上级会话或项目文件夹下实现热拔插改派（或右键 **Change Supervisor...**），系统自动级联调整职级并保持 `Worker` 100% 原生干净上下文；上级会话可通过直属下级列表与以自身为根的组织树 API 实时查看与调度整支下属团队。
  - **四大原生会话动作**：文件夹级无缝行内重命名（`F2` / 右键 `Rename...`）、团队整树归档与恢复（`Archive / Restore`）、从侧栏移除但保留引擎历史（`Remove from Sidebar`）、以及连同底层引擎原生历史一并彻底销毁（`Delete Permanently`），支持右键 `Copy Role & Subordinate API Prompt` 与 `Change Supervisor...`。
- **右边栏（`Project Inspector`：`Changes` + `Files`）**：进入 ADE 自动打开项目级源码变更（点击直接打开 ADE Diff）与项目源码文件树；切回 IDE 时自动恢复此前右侧栏面板。
- **全量等价控制面 CLI（`aexus-ade`）**：通过 `0600` 本地鉴权 Unix Socket（`~/.aexus-code/ade-control.sock`）暴露完备的 ADE 控制指令：`status`、`view`（`status` / `--archived` / `--inspector` / `--refresh`）、`project`（`list` / `add` / `select` / `remove` / `delete` / `focus` / `home` / `forward` / `move` / `changes` / `files` / `open-file` / `open-diff`）、`engine`（`list` / `sessions`）、`session`（`list` / `info` / `subordinates` / `tree` / `create` / `attach` / `connect` / `open` / `select` / `close` / `mark-read` / `draft` / `rename` / `role` / `move` / `reorder` / `send --wait` / `history` / `stop` / `archive` / `unarchive` / `detach` / `delete`）以及 `secretary`（`status` / `open` / `engine` / `reset` / `send --wait` / `history` / `stop` / `draft` / `mark-read`），自动注入编排进程与集成终端 `PATH`（安装包内置于 `Contents/Resources/app/bin/aexus-ade`）。
- **8 大本机 Coding Agent 原生引擎聚合（`extensions/aexus-agents`）**：原生直连 **Codex**（`codex`）、**Claude Code**（`claude`）、**Kilo Code**（`kilo`）、**OpenCode**（`opencode`）、**DeepSeek Harness**（`dsh`）、**Google Antigravity**（`agy`）、**Cline**（`cline`）与 **Pi**（`pi`），完整支持会话发现、挂载（`attach`）、创建、历史加载、流式对话、中断与永久物理删除；同时通过 `nativeRoleBridge`、`extHostRolePreload`（在原生扩展宿主按窗口作用域零延迟同步快照与会话绑定）、`agy --hub` ConnectRPC 本地代理（拦截 `StartCascade` 与 `SendUserCascadeMessage` 注入 `append_prompt_sections`）、`codex app-server` `thread/inject_items`、`claude` stream-json、`dshRolePreload`、`kilo` / `opencode` / `cline` 请求体注入及 `pi --mode rpc` 将实时职级、上下级树与 `aexus-ade` 直控规范自动同步注入这 8 大原生扩展 UI 会话并绑定原生会话标签，且严格保证纯 `Worker` 角色上下文 100% 原生干净。

## Copilot 清理与扩展市场

已移除内置 Copilot 扩展、CLI shim、SDK/CAPI 依赖、微软内置 Agent 执行后端、Copilot 订阅/令牌请求、连接器授权后端、登录引导、订阅状态面板，以及扩展市场中的 Copilot 专用迁移规则。构建和安装不再携带这些组件。通用编辑器、Extension Host、扩展 API 及其兼容类型保留；源码中的上游协议名称、历史注释或许可证提及不代表重新接入 Copilot。

侧边栏使用官方 Visual Studio Marketplace 的公开目录，支持搜索、详情、安装和卸载；也保留本地 VSIX 安装。已按本版本实际存在的 API 提案过滤官方扩展兼容清单。专有扩展的产品限制、账户登录和各自许可仍由发布者决定，不能保证所有微软专有扩展都能在自编译产品中运行。

市场功能的技术接入不等于获得使用授权：[微软 FAQ](https://code.visualstudio.com/docs/supporting/FAQ#_i-cant-access-the-visual-studio-marketplace-from-product--fill-in-the-blank--why-not)明确限制第三方 Code OSS 分叉访问官方市场。公开发行前需要处理这项授权，或改用适用于分叉产品的市场。

## 已完成的验证

- 核心源码和构建工具类型检查通过，构建计划的 18 项测试通过。
- macOS arm64 独立应用构建、ad-hoc 签名及安装副本签名校验通过。
- 官方市场安装 `esbenp.prettier-vscode@12.4.0` 成功，扩展签名验证返回 `Success`，校验保持开启。
- 安装版 Extension Host 实际加载 Prettier、执行格式化并保存文件；集成终端执行命令并正常退出。运行验收记录位于 `.build/runtime-verification.json`。


图标轮廓取自[官方图标包](https://code.visualstudio.com/assets/branding/visual-studio-code-icons.zip)中的 `vscode-alt.svg`，按要求使用相同轮廓、纯白填充和黑色背景。图标不因源码采用 MIT 许可而自动获得品牌授权；[微软品牌使用说明](https://code.visualstudio.com/brand)对将其用作自有产品图标有限制，公开发行前需另行处理。
