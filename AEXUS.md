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

Codex、Claude Code、Cline、Kilo Code、DSH、OpenCode、Antigravity 和 Pi 的面板均已通过隐藏窗口实际打开验证。OpenCode 的侧栏由已安装的 `zgy.opencode-vscode-ui` 提供，`sst-dev.opencode` 同时保留其原有终端命令。

## 文件树顺序与项目 Focus

普通拖拽可调整同一父目录下文件和文件夹的显示顺序，项目根目录也支持重排。拖放到条目的上半部插到前面，下半部插到后面；多选条目保持原有相对顺序。排序保存在当前工作区，优先于名称排序；普通跨层级拖拽会被拒绝，排序不会移动磁盘上的文件。

在左栏项目根目录上右键选择 **Focus** 进入项目。顶部左侧显示 **Home** 按钮，点击返回项目主页面；返回后显示前进图标，可重新进入刚才的项目。如果改为 Focus 另一个项目，前进目标会更新为新项目，不会跳回旧项目。工作区原有项目列表与已打开文件保留。IDE 与 ADE 共享同一套项目宇宙、顺序与 `Focus ➔ Home ⇄ Forward` 导航状态。

## SSH 云主机（Cloud Hosts）与远端项目丝滑共存（`aexus-ssh://`）

无需远端预装专有 `vscode-server`，原生基于系统 OpenSSH 多路复用通道与密钥体系实现本地 `file://` 项目与多台 SSH 云主机（`aexus-ssh://<alias>/<remotePath>`）项目在**同一窗口**内丝滑共存：

- **自动搬移原版 VS Code 云主机与历史远端目录**：首次加载及手动同步（`Cloud Hosts: Migrate / Sync Cloud Hosts from VS Code & SSH Config` / `aexus-ade host import-vscode`）时，自动递归解析 `~/.ssh/config` 与全部 `Include` 子配置（遵循 OpenSSH 首匹配优先语义），并从原版 VS Code 的 `settings.json`（`remote.SSH.remotePlatform` / `remote.SSH.configFile`）、`state.vscdb`（`ms-vscode-remote.remote-ssh` 远端目录历史）、`storage.json`、`Project Manager` 及历史 `hosts.json` 完整迁移云主机别名、操作系统类型（`linux` / `macos` / `windows`）、跳板机（`ProxyJump`）、密钥路径及常用远端项目目录（严格不读取或复制任何私钥内容与密码）。
- **IDE 与 ADE 统一 `+` 两步直达“选主机 ➔ 实时路径输入与目录联动选择”流程**：点击 ADE 左栏顶部的 `+`（`Add Project Folder...`）或在 IDE 点击 `+`（`Add Projects...`）时，**第一步直接选择项目所在主机**（列出 `Local (This Computer)` 与全部已保存/已迁移的每一台 SSH 云主机，并支持行内编辑或新建/管理云主机），**第二步自动带出当前远端路径输入框并实时弹出当前路径下的子文件夹列表**：输入子目录名实时高亮匹配、回车或点击进入下级目录、按 `Backspace` 删除路径片段退回上级时零延迟自动弹出上级目录（Windows 主机退至 `/` 还可直接选择 `C:/`、`D:/` 等全盘符），也可随时新建远端目录、选择 VS Code 历史远端目录、点击右侧 `Open` 一键确认当前输入路径，或点返回键切换主机。
- **可视化云主机管理面板（`Cloud Host Studio` / `AdeCloudHostsEditorPane`）**：支持新建、保存、编辑修改（显示名、SSH 别名、IP/域名、用户名、端口、操作系统、私钥路径、`ProxyJump` 跳板机、默认工作目录与备注）、一键连通性延迟检测（`Test Connection`）、删除、从 VS Code 同步以及一键打开远端终端或添加远端项目；生成的 `<userDataDir>/ssh/effective_ssh_config` 让 Aexus 托管主机配置优先于 `~/.ssh/config` 生效，同时完整继承原有跳板机与全局密钥配置。
- **原生远端文件系统、源码变更 Diff 与集成终端直连**：内置 `AexusSshFileSystemProvider`（支持 Linux/macOS POSIX 与 Windows PowerShell 远端读写、目录树、新建、重命名、复制与删除，编辑器 `Cmd+S` 直接保存回云主机磁盘）与 `aexus-ssh-git-head:` 远端 Git 状态及并排 Diff；在云主机项目或其任意子目录上新建集成终端（终端面板 `+`、右键 `Open in Integrated Terminal` 或终端分屏）时，自动通过 `ssh -F <effective_ssh_config> -t` 直连并进入对应的远端项目目录（本地项目仍打开本地 Shell）；同时完整兼容 ADE Coding Agent 会话创建与 `aexus-ade host`（`list` / `info` / `add` / `update` / `remove` / `test` / `browse` / `import-vscode` / `open`）控制面指令。

## ADE（Agent Development Environment）Phase 1

ADE 与 IDE 呈镜像对称架构（单分支同目录协作，无需 Git Worktree）：

- **左边栏（Agent 调度中心 `AdeProjectsView`）**：
  - **顶置全局 `✦ Secretary`**：常驻左栏顶部（Home 与 Focus 下均可见），具备实时视口与全树感知能力（自动感知当前模式、Home/Focus 状态、活跃项目、活跃编辑器与实时会话层级树），拥有操作 ADE 内全部要素（项目、视图、引擎、会话树、职级、热拔插、归档、草稿与自身会话）的完备接口，并严格限定仅操作 ADE（禁止切换或操作 IDE 模式视图）。
  - **`Projects` 项目会话树 + `Archived` 归档过滤**：展示项目文件夹与多路并行主理会话（Focus 模式下仅聚焦单项目根并自动展开会话树，不在左栏混杂源码目录或引擎内部默认子代理），支持一键切换查看已归档会话。
  - **四级职级体系与下属直控能力（严格区分 `Employee [L3] ≠ Worker [L4]`）**：建立清晰的 `Governor（L1）➔ Manager（L2）➔ Employee（L3）➔ Worker（L4 最低级）` 职级梯队。其中 **`Employee（L3）` 绝不是 `Worker（L4）`**：`Employee（L3）` 属于正式编排管理与验收职级（持有 `aexus-ade` 下属控制 API，负责调度、管理并验收下级 `Worker` 产出，在 Engineering 工程树中专职单节点验收与汇报撰写、绝不亲自写业务代码），而 **`Worker（L4）`** 位于 `Employee` 之下，是唯一不注入任何编排提示词与 API、不可再向下嵌套子会话的 **100% 原生纯净编码执行层**。新建顶层会话时可显式选定职级，在会话内新建子会话自动降一级分配（`Governor ➔ Manager ➔ Employee ➔ Worker`）；支持将下级会话拖拽到同项目或跨项目的任意上级会话或项目文件夹下实现热拔插改派（或右键 **Change Supervisor...**），系统自动级联调整职级并保持 `Worker` 100% 原生干净上下文；编排角色（`Governor` / `Manager` / `Employee` / `Secretary`）在创建时即自动锁定输入框进行短暂的角色与 API 说明文档预热阅读，后续用户发消息零文档拼接负担。
  - **四大原生会话动作**：文件夹级无缝行内重命名（`F2` / 右键 `Rename...`）、团队整树归档与恢复（`Archive / Restore`）、从侧栏移除但保留引擎历史（`Remove from Sidebar`）、以及连同底层引擎原生历史一并彻底销毁（`Delete Permanently`），支持右键 `Copy Role & Subordinate API Prompt` 与 `Change Supervisor...`。
- **右边栏（`Project Inspector`：`Changes` + `Files`）**：进入 ADE 自动打开项目级源码变更（点击直接打开 ADE Diff）与项目源码文件树；切回 IDE 时自动恢复此前右侧栏面板。
- **全量等价控制面 CLI（`aexus-ade`）**：通过 `0600` 本地鉴权 Unix Socket（`~/.aexus-code/ade-control.sock`）暴露完备的 ADE 控制指令：`status`、`view`（`status` / `--archived` / `--inspector` / `--refresh`）、`project`（`list` / `add` / `select` / `remove` / `delete` / `focus` / `home` / `forward` / `move` / `changes` / `files` / `open-file` / `open-diff`）、`engine`（`list` / `sessions`）、`session`（`list` / `info` / `subordinates` / `tree` / `create` / `attach` / `connect` / `open` / `select` / `close` / `mark-read` / `draft` / `rename` / `role` / `move` / `reorder` / `send --wait` / `history` / `stop` / `archive` / `unarchive` / `detach` / `delete`）以及 `secretary`（`status` / `open` / `engine` / `reset` / `send --wait` / `history` / `stop` / `draft` / `mark-read`），自动注入编排进程与集成终端 `PATH`（安装包内置于 `Contents/Resources/app/bin/aexus-ade`）。
- **8 大本机 Coding Agent 原生引擎聚合（`extensions/aexus-agents`）**：原生直连 **Codex**（`codex`）、**Claude Code**（`claude`）、**Kilo Code**（`kilo`）、**OpenCode**（`opencode`）、**DeepSeek Harness**（`dsh`）、**Google Antigravity**（`agy`）、**Cline**（`cline`）与 **Pi**（`pi`），完整支持会话发现、挂载（`attach`）、创建、历史加载、流式对话、中断与永久物理删除；同时通过 `nativeRoleBridge`、`extHostRolePreload`（在原生扩展宿主按窗口作用域零延迟同步快照与会话绑定）、`agy --hub` ConnectRPC 本地代理（拦截 `StartCascade` 与 `SendUserCascadeMessage` 注入 `append_prompt_sections`）、`codex app-server` `thread/inject_items`、`claude` stream-json、`dshRolePreload`、`kilo` / `opencode` / `cline` 请求体注入及 `pi --mode rpc` 将实时职级、上下级树与 `aexus-ade` 直控规范自动同步注入这 8 大原生扩展 UI 会话并绑定原生会话标签，且严格保证纯 `Worker` 角色上下文 100% 原生干净。
- **ADE Engineering & Research 工作流引擎与可视化 DAG 画布（一等双模式）**：
  - **Governor 一对一工程/研究树映射与拓扑锁定**：右键顶层 `Governor` 点击 `Engineering` 初始化或聚焦专属工作流画布；也可通过 `Open ADE Research...` 或 `aexus-ade engineering init --tree-type research` 创建与 Engineering 完全对等的一等 `Research` 树（`treeType: 'research'`，蓝图持久化于 `~/.aexus-code/research/<governor-id>/`，内置问题界定、文献综述、基线基准与评估标准导向的起始蓝图）。若已有自由子会话，支持迁出为独立会话或删除清理；蓝图保存后在左栏自动预创建 `Governor ➔ Manager ➔ Employee ➔ Worker` 完整结构并严格锁定拖拽、改派与手动增删，底层 CLI 进程按首次唤醒或点击懒加载拉起。
  - **极大无分支路径（Maximal Non-Branching Path）Manager 自动切分**：100% 算法自动切分分叉前、合流后与 `user_gate` 边界，蓝图持久化于 `~/.aexus-code/engineering/<governor-id>/blueprint.md` 与 `state.json`（Research 树对应 `research/` 目录），零污染用户项目仓库；支持单根目录单 Worker 快照 Diff 提取与可选 Git Worktree 沙盒并行隔离。
  - **四级状态机、三级失败熔断、局部打回与 Watchdog**：仅允许用户运行按钮或 `✦ Secretary` 启动执行；`Worker（L4）` 保持 100% 纯净业务上下文，递增汇报由 `Employee（L3）` 验收通过后生成并沿拓扑去重透传；Employee 内部打回 1–2 次保持绿灯原会话增量返工，第 3 次唤醒段 `Manager（L2）` 清空重试状态给予第 4 次指导机会；Manager 二次验收正式判定失败呈现三级色彩演进（浅琥珀 `failure_1` ➔ 深琥珀 `failure_2` ➔ 红色熔断 `failure_3` 唤醒 `Governor` 评估并投递收信箱）；独立 `user_gate` 用户验收节点等待期间在卡片上内联渲染 `✓ Approve` 与 `Rollback…` 按钮，支持一键通过或按有向路径交集精准局部打回（绝不重置无关并行支路）；内置 `aexus.ade.engineering.watchdogTimeoutMinutes`（默认 10 分钟）流式输出心跳看门狗。
  - **标准 Editor Tab 可视化画布（`AdeEngineeringEditorPane`）、v2 嵌套双壳任务舱与四层 Token 遥测**：打开画布自动居中缩放适配全图；任务节点采用 **v2 嵌套双壳（Nested Dual-Shell）任务舱**——外层 **`EMPLOYEE · L3`** 验收壳在上下左右四边物理包裹内层凹陷的 **`WORKER · L4`** 执行核，并整体嵌于自动切分的 **`MGR · L2`** 段框内，运行中呈现活跃子角色呼吸光效与实时阶段耗时徽章（`Worker · Ns` / `Emp Audit · Ns` / `Mgr Review · Ns`）；`user_gate` 等待验收时呈现醒目金色盾牌与内联审批/打回按钮；连线支持悬停中点 `×`、双击与右键快速删除，拖拽节点时提供吸附对齐辅助线（按住 `Alt` 关闭吸附）；输出端口旁的 1 键 `+` 快速派生手柄可追加并自动连线下游任务（`Alt+单击` 追加 `User Gate`），画布内所有编辑支持 `Cmd+Z` / `Shift+Cmd+Z` 完整撤销重做与 `Draft` 状态徽章；浮动 **DAG MAP** 小地图支持点击/拖动镜头导航；工具栏 Token 胶囊打开 **四层 Token 与遥测分析卡**，按 `Governor · L1` / `Manager · L2` / `Employee · L3` / `Worker · L4` 拆解总 Token、回合、输入、输出与缓存读写；`Logs` 面板支持按角色（`All` / `Worker` / `Employee` / `Manager` / `Gates & Alerts`）过滤，事件中的 `[nodeId]` 可点击并直接将镜头飞至对应节点；右键（Right-Click）节点/引擎即在紧邻位置弹出专属浮动卡片（鼠标悬停绝不自动弹出，且输入聚焦期间后台流式刷新零丢字、零抢焦点），内含 `Worker | Employee | Mgr | Spec | Report` 五栏（支持一键 `Apply to All Unlocked Roles` 批量同步全图未锁定角色的引擎/模型/思考强度、查看验收汇报与语法着色（`+` / `-` / `@@`）的内联源码 Diff 并点击直开文件、单节点或全树 `Reset` 解锁重跑，`User Gate` 卡片内嵌上游递增汇报供就地审批或精准打回）；顶栏内置 `Blueprint`（Markdown 源码直编校验）与 `Logs`（实时事件时间线）浮层面板；全树与单节点分角色 Token 计数支持回合中增量流式刷新（零重复累加），并在 `aexus-ade engineering`（含 `init --tree-type <engineering|research>` / `init --open` / `blueprint get|apply|validate` / `configure` / `reset` / `diff` / `reports` / `remove`）与 `aexus-ade inbox` 提供 100% 闭环的控制面接口。

## Copilot 清理与扩展市场

已移除内置 Copilot 扩展、CLI shim、SDK/CAPI 依赖、微软内置 Agent 执行后端、Copilot 订阅/令牌请求、连接器授权后端、登录引导、订阅状态面板，以及扩展市场中的 Copilot 专用迁移规则。构建和安装不再携带这些组件。通用编辑器、Extension Host、扩展 API 及其兼容类型保留；源码中的上游协议名称、历史注释或许可证提及不代表重新接入 Copilot。

侧边栏使用官方 Visual Studio Marketplace 的公开目录，支持搜索、详情、安装和卸载；也保留本地 VSIX 安装。已按本版本实际存在的 API 提案过滤官方扩展兼容清单。专有扩展的产品限制、账户登录和各自许可仍由发布者决定，不能保证所有微软专有扩展都能在自编译产品中运行。

市场功能的技术接入不等于获得使用授权：[微软 FAQ](https://code.visualstudio.com/docs/supporting/FAQ#_i-cant-access-the-visual-studio-marketplace-from-product--fill-in-the-blank--why-not)明确限制第三方 Code OSS 分叉访问官方市场。公开发行前需要处理这项授权，或改用适用于分叉产品的市场。

## 已完成的验证

- Node 单元测试套件全部通过，覆盖 ADE 核心服务、控制面协议、云主机迁移、Engineering / Research 蓝图解析与四级状态机。
- 44+ 项 Chromium 环境下的 ADE 浏览器测试通过，覆盖嵌套双壳任务舱四边物理包裹、1 键快速派生、撤销/重做、DAG MAP 小地图、四层 Token 遥测分析与 User Gate 内联审批等真实 DOM 交互。
- 14 项角色桥接与提示词洁净度测试通过，验证 8 大原生引擎的职级同步与纯 `Worker` 上下文 100% 干净。
- ESLint、TypeScript 类型检查与 `valid-layers-check` 模块分层校验全部通过。
- 在隐藏窗口中完成 Retina 视觉验收并通过。
- macOS arm64（`darwin-arm64`）独立应用构建、本地 ad-hoc 签名、安装副本签名校验及运行时加载验证通过。
- 官方市场安装 `esbenp.prettier-vscode@12.4.0` 成功，扩展签名验证返回 `Success`，校验保持开启。
- 安装版 Extension Host 实际加载 Prettier、执行格式化并保存文件；集成终端执行命令并正常退出。


图标轮廓取自[官方图标包](https://code.visualstudio.com/assets/branding/visual-studio-code-icons.zip)中的 `vscode-alt.svg`，按要求使用相同轮廓、纯白填充和黑色背景。图标不因源码采用 MIT 许可而自动获得品牌授权；[微软品牌使用说明](https://code.visualstudio.com/brand)对将其用作自有产品图标有限制，公开发行前需另行处理。
