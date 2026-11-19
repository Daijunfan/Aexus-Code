<p align="center">
  <img src="assets/aexus-logo.png" width="88" alt="Aexus Code 原创几何 DAG 标志" />
</p>

<h1 align="center">Aexus Code</h1>

<p align="center">
  <strong>开源组织化智能体开发环境（ADE）与可视化多智能体控制面 IDE</strong><br/>
  可扩展多级组织架构 · 8 大本机 BYO-CLI 编码引擎 · 确定性 Engineering &amp; Research DAG · 服务端签名能力令牌 · Git Worktree 沙盒 · 免装机原生 SSH 云主机
</p>

<p align="center">
  <a href="https://github.com/Daijunfan/Aexus-Code/actions/workflows/aexus-ci.yml"><img src="https://github.com/Daijunfan/Aexus-Code/actions/workflows/aexus-ci.yml/badge.svg" alt="Aexus Code CI（类型检查、ESLint、ADE 与 CLI 测试）" /></a>
  <a href="https://github.com/Daijunfan/Aexus-Code/releases"><img src="https://img.shields.io/badge/Releases-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-0284c7?style=flat-square" alt="预编译发行版 macOS Linux Windows" /></a>
  <a href="../LICENSE.txt"><img src="https://img.shields.io/badge/License-MIT-0f172a?style=flat-square" alt="MIT License" /></a>
  <a href="https://open-vsx.org/"><img src="https://img.shields.io/badge/Extensions-Open%20VSX-6366f1?style=flat-square" alt="Open VSX 开源扩展市场" /></a>
  <img src="https://img.shields.io/badge/Modes-ADE%20%E2%87%84%20IDE%20Symmetry-2563eb?style=flat-square" alt="ADE IDE 镜像对称" />
  <img src="https://img.shields.io/badge/Native%20Engines-8%20BYO--CLI%20Agents-059669?style=flat-square" alt="8 大本机原生编码引擎" />
</p>

<p align="center">
  <a href="../README.md">English</a> · <strong>简体中文</strong> · <a href="ARCHITECTURE.md">架构总览</a> · <a href="gallery.md">完整图库与视频</a> · <a href="../examples/blueprints/README.md">蓝图模板库</a> · <a href="../SECURITY.md">安全模型</a> · <a href="../CHANGELOG.md">更新日志</a> · <a href="../CONTRIBUTING.md">贡献指南</a> · <a href="../CODE_OF_CONDUCT.md">行为准则</a>
</p>

---

> [!TIP]
> **10 秒零花费预览（`$0.00` 模拟演练），或 `<50ms` 生成可编辑 DAG 脚手架：**
> - **零 Token 模拟互动演练（`$0.00` 花费、零源码改动）**：按 `Cmd/Ctrl+Shift+P` 执行 **`Aexus ADE: Try Interactive Engineering DAG Demo (0 Tokens)`**（或运行 `aexus-ade engineering demo`），预览完整多级编排、点击放行门禁 `U1`，并导出**矢量 SVG** 与 **GitHub PR 验收报告**。
> - **Prompt-to-DAG（`Cmd/Ctrl+K`）**：在画布按 `Cmd/Ctrl+K` 输入一句话，基于**确定性关键词到 DAG 脚手架合成（`<50ms`）**即时生成并行泳道与门禁草图，可直接可视化编辑或交由 `Governor` LLM 进一步深化。
> - **瞬切 `ADE ⇄ IDE`**：随时按 `Alt+Cmd+A`（`Alt+Ctrl+A`）在组织化智能体视图与全功能 `Code - OSS` IDE 之间切换，不重启语言服务与终端。

<p align="center">
  <img src="assets/demos/02-live-dag-choreography.gif" width="100%" alt="Aexus Code 零 Token 模拟互动演示 — 四级 DAG 编排、三路并行 Worktree、返工自愈、门禁审批与 FinOps 看板" />
  <br/>
  <sub><strong>零 Token 模拟互动演示（<code>$0.00</code> 真实花费，确定性编排预览）：</strong>三路并行 Worktree ➔ 返工自愈 ➔ 门禁 <code>U1</code> 审批 ➔ 四层 FinOps · <a href="assets/demos/02-live-dag-choreography.mp4">▶ 观看高清 MP4</a> · <a href="gallery.md">浏览完整图库与 5 段视频 →</a></sub>
</p>

---

## 为什么构建 Aexus Code？

现有 AI 研发工具通常不得不在「闭源单线程 IDE」、「脱离编辑器的外部 Worktree 终端壳」与「脱离真实代码库与 Git 的云端节点画布」之间妥协。

**Aexus Code** 基于开源 `Code - OSS`（`1.146.0`）打造，采用 **MIT 开源协议**，默认接入开源 **[Open VSX](https://open-vsx.org/)** 扩展市场并彻底移除微软闭源 Copilot 遥测，在一个本地优先的桌面窗口中融合全功能 **IDE** 与可扩展的 **组织化智能体开发环境（ADE）**：

1. **组织与职级工作室（"Everything is Extensible"）**——内置 **5 套组织预设**（`企业四级`、`敏捷三级创业团队`、`AI 科研实验室`、`红蓝安全审计`、`双层扁平蜂群`），支持填空式自定义职级、`{{variables}}` 提示词模板、**职级 × 固定内核 API 权限矩阵**，以及全 8 大引擎统一的服务端 HMAC 签名能力令牌（`AEXUS_ADE_SESSION_TOKEN`）。
2. **8 大本机 BYO-CLI 编码引擎（默认安全模式）**——使用你自己的本机 CLI 与订阅直连 **Claude Code**、**Codex**、**Google Antigravity**、**Kilo Code**、**OpenCode**、**DeepSeek Harness**、**Cline** 与 **Pi**。交互式会话默认运行在各引擎的安全审批模式，全自动模式需显式开启（`aexus.ade.autonomousMode`）。
3. **确定性 Engineering & Research DAG 护栏**——支持 **SHA-256 哈希锁定的 `verify:` 预审查命令**、**`files:` 作用域串行化**、**`max_concurrency` + 关键路径调度**、**支路隔离的红色熔断器**、**Git 原生累计 Diff** 与 **零 Token 优先的两阶段 Watchdog**。
4. **四层 FinOps、可配置定价与预算护栏**——优先采用引擎上报费用，缺失时基于可自定义费率表（`aexus.ade.pricing`）实时估算 `$USD` 与缓存节省，并支持 **订阅制（`$0` 边际费用）模式**；配合**派发前预算准入 + 回合后超限自动停机暂停**，杜绝僵尸节点与失控消耗。
5. **Smart Calm 极简侧栏、按职级过滤的 Inbox 与免装机 SSH 云主机**——侧栏默认采用紧凑悬停绽放徽章（支持一键切换完整徽章视图），统一 `ADE Inbox` 内置动态职级筛选胶囊，并支持在同一窗口混排本地 `file://` 与免远端 `vscode-server` 的 `aexus-ssh://` 云主机项目。

---

## 核心旗舰能力

### 1. 组织与职级工作室（"Everything is Extensible"）

不再被绑死在单一固定组织结构里。Engineering 与 Research DAG 通过 4 个**结构化工作树槽位**（`orchestrator`、`segment_owner`、`reviewer`、`executor`）动态映射至当前生效的组织配置——无论是 2 级、3 级、4 级还是完全自定义的职级梯队，DAG 流水线均可无障碍运行：

<p align="center">
  <img src="assets/15-org-role-studio-matrix.png" width="100%" alt="组织与职级工作室 — 5 套内置预设、职级×固定内核 API 权限矩阵、纯净 Worker 零权限锁定与 Smart Calm 侧栏" />
  <br/>
  <sub><strong>组织与职级工作室（"Everything is Extensible"）：</strong>5 套内置预设、实时 <code>职级 × 固定内核 API</code> 权限矩阵（含 <code>High Privilege</code> 高危标记）、叶子 Worker 永久 <code>Pure · 0</code> 锁定，以及 Smart Calm 极简侧栏层级树。</sub>
</p>

| 内置组织预设 | 职级梯队（顶层 → 叶子纯净执行器） | 工作树槽位映射（`orch / seg / rev / exec`） |
| :--- | :--- | :--- |
| **`default-4tier`** *（默认）* | `Governor (L1)` → `Manager (L2)` → `Employee (L3)` → `Worker (L4 Pure)` | `governor / manager / employee / worker` |
| **`startup-3tier`** | `Tech Lead (L1)` → `Reviewer (L2)` → `Builder (L3 Pure)` | `tech-lead / tech-lead / reviewer / builder` |
| **`research-lab`** | `Principal Investigator (L1)` → `Research Lead (L2)` → `Peer Critic (L3)` → `Experimenter (L4 Pure)` | `governor / manager / employee / worker` |
| **`security-audit`** | `Audit Director (L1)` → `Lead Auditor (L2)` → `Verifier (L3)` → `Scanner (L4 Pure)` | `governor / manager / employee / worker` |
| **`flat-swarm`** | `Coordinator (L1)` → `Agent (L2 Pure)` | `coordinator / coordinator / coordinator / agent` |

- **填空式自定义职级与 `{{variables}}` 模板**：在具备原生脏状态追踪（`isDirty` / `Cmd/Ctrl+S` 保存与回滚、职级 ID 重命名自动迁移活跃会话）的编辑器中自由定制名称、颜色、图标与提示词变量（`{{rank.name}}`、`{{rank.tier}}`、`{{project.name}}`、`{{supervisor.label}}`、`{{hierarchy.ladder}}` 等）。
- **职级 × 固定内核 API 权限矩阵**：可视化配置每个职级可调用的内核原语（`session.*`、`project.*`、`host.access`、`inbox.post`、`engineering.read/design/review/control`，以及独立拆分的高危权限 `engineering.integrate` 与 `engineering.destroy`）。
- **服务端签名能力令牌与纯净 Worker 隔离**：每个编排会话均持有主进程内存签发的 HMAC-SHA256 `AEXUS_ADE_SESSION_TOKEN`；服务端严格从令牌推导调用方职级（杜绝伪造 `secretary` 或清空环境变量越权）。纯净执行职级（`Worker` / `Builder` / `Agent`）不仅剥离控制面元数据与 `PATH` 中的 `aexus-ade`，还会注入显式服务端拒绝令牌。
- **零预热首轮内联注入 + 提示词哈希缓存失效 + 自动压缩恢复**：彻底告别「锁输入框单独预热」——职级契约在首轮对话内联注入，仅在发送成功后提交状态；工作室修改提示词或权限导致 SHA-256 哈希变化时下一轮自动重注；检测到引擎上下文压缩（`compact_boundary` / `context_compacted`）时自动恢复契约上下文。
- **防恶意仓库提示词注入**：`aexus.ade.organization` 为 `application` 级受限配置（`restricted: true`），自动忽略克隆仓库中 `.vscode/settings.json` 的工作区覆盖。

---

### 2. 确定性 DAG 护栏、装甲嵌套双壳舱与 6 套蓝图模板

右键任意顶层编排者（`Governor` / `Tech Lead` / `Coordinator`）开启 **`Engineering`** 或 **`Research`**，即可启动与 Mermaid + Markdown 双向同步的可视化流水线：

<p align="center">
  <img src="assets/14-living-pods-interactive-demo.png" width="100%" alt="装甲嵌套双壳任务舱、三段式对抗流水线、Worktree 泳道与人工发布门禁（零 Token 模拟演练预览）" />
  <br/>
  <sub><em>零 Token 模拟演练预览：</em>外层 <code>EMPLOYEE · L3</code> 验收壳四边包裹内层 <code>WORKER · L4</code> 纯净执行核，整体嵌于自动切分的 <code>MGR · L2</code> 泳道中。</sub>
</p>

- **SHA-256 哈希锁定的 `verify:` 预审查命令**：Worker 完成编码后、唤醒审查者前，先在独立进程组（POSIX `/bin/sh -c`，超时整组清理不留孤儿进程）执行构建/测试校验。所有 `verify:` 命令均按项目以 SHA-256 哈希锁定，首次引入或被智能体修改时必须经人工显式确认才会运行。
- **`files:` 作用域串行化与 `max_concurrency` 关键路径调度**：为节点声明文件所有权 glob（如 `files: src/server/**`），`shared` 模式下存在交集的节点自动串行避免写冲突；`max_concurrency` 控制最大并行数并沿关键路径优先调度。
- **支路隔离红色熔断器 & 零 Token 优先的两阶段 Watchdog**：连续正式失败演进为浅琥珀（`failure_1`）→ 深琥珀（`failure_2`）→ 红色熔断（`failure_3`），**仅暂停故障支路**并唤醒顶层编排者与 `ADE Inbox`，健康兄弟支路继续推进。节点卡顿时 Watchdog 第一阶段在**零 Token 消耗**下本地巡检进程与 Git 活跃度，必要时再进入第二阶段升级处理。
- **Git 原生累计节点与段级 Diff**：Git 仓库内直接基于 `git status --porcelain=v2 -z` 与 `git diff` 追踪改动（遵循 `.gitignore`，无 12,000 文件截断盲区），在节点审查卡与有向局部打回 `User Gate` 中呈现清晰累计 Diff。
- **四层 FinOps 与预算护栏**：支持**派发前准入检查 + 回合后超限自动停机暂停**（通过 `pauseTree` 停止活跃引擎并干净复位运行中节点至 `idle`），支持自定义 `aexus.ade.pricing` 费率与 **订阅制 `$0` 模式**。

| 内置蓝图模板（6 套全部齐备） | 模式 | 并行泳道 | 默认隔离 | 内置护栏字段 | 适用场景 |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **[`feature-ship`](../examples/blueprints/feature-ship.md)** | Engineering | `3×` 并行 | `worktree` | `max_concurrency` / `files:` / `verify:` | 契约先行的全栈功能交付：后端/前端/测试并行 + 发布门禁 |
| **[`bug-hunt-fix`](../examples/blueprints/bug-hunt-fix.md)** | Engineering | `2×` 并行 | `shared` | `max_concurrency` / `files:` / `verify:` | 最小复现驱动的精准排障 + 分作用域修复与回归测试 |
| **[`security-audit-swarm`](../examples/blueprints/security-audit-swarm.md)** | Engineering | `3×` 并行 | `worktree` | `max_concurrency` / `files:` / `verify:` | 鉴权、IPC 与供应链三轨并行安全审计与补丁收敛 |
| **[`safe-migration`](../examples/blueprints/safe-migration.md)** | Engineering | `2×` 并行 | `worktree` | `max_concurrency` / `files:` / `verify:` | 行为基线锁定、并行重构、回滚门禁与旧代码清理 |
| **[`deep-research-lab`](../examples/blueprints/deep-research-lab.md)** | Research | `3×` 并行 | `shared` | `max_concurrency` / `files:` / `verify:` | 多轨假设探索、反证基线、定量基准与同行评审报告 |
| **[`arch-teardown`](../examples/blueprints/arch-teardown.md)** | Research | `2×` 并行 | `shared` | `max_concurrency` / `files:` / `verify:` | 系统并发与开发体验双轨架构拆解，产出可执行 RFC |

---

### 3. 安全 Git Worktree 沙盒、Smart Calm 侧栏与按职级过滤 Inbox

<table>
  <tr>
    <td width="50%">
      <img src="assets/16-smart-calm-and-inbox-ranks.png" width="100%" alt="按职级过滤的 ADE Inbox（All / Gov / Mgr / Emp / Wrk）与填空式职级提示词编辑器" />
      <p align="center"><sub><strong>按职级过滤 <code>ADE Inbox</code> &amp; 填空式职级提示词编辑器</strong></sub></p>
    </td>
    <td width="50%">
      <img src="assets/11-worktree-merge-workbench.png" width="100%" alt="按泳道隔离的 Git Worktree 沙盒与合并/清理工作台" />
      <p align="center"><sub><strong>独立 <code>aexus-eng/*</code> Git Worktree 沙盒与合并/清理工作台</strong></sub></p>
    </td>
  </tr>
</table>

- **安全的 Git Worktree 生命周期**：DAG 蓝图与运行态保存在仓库外部的 `~/.aexus-code/engineering/` 与 `~/.aexus-code/research/`。开启 `worktree` 模式时，并行泳道使用独立的 **`aexus-eng/*` Git 分支**，合并前执行脏工作树预检、避免破坏性 `-B` 强行重置或默认 `-D` 删分支、保留用户自身的 `git config user.name/email`（附带 `Co-authored-by` 尾注），且 Worktree 创建失败时会显式暂停并发送 Inbox 告警，绝不静默降级并行写入共享根目录。
- **Smart Calm 极简侧栏**：会话行默认展示紧凑悬停绽放徽章以降低视觉干扰，顶部提供**一键切换完整徽章视图**按钮，并在最上方常驻具备视口感知能力的 **`✦ Secretary`**。
- **按职级过滤的 `ADE Inbox`**：统一收信箱自动根据当前组织预设动态渲染职级过滤胶囊（如 `All | Governor | Manager | Employee` 或 `All | Tech Lead | Reviewer`），并与画布门禁实时同步。

---

### 4. 免远端装机 SSH 云主机（`aexus-ssh://`）与 `ADE ⇄ IDE` 镜像对称

<table>
  <tr>
    <td width="50%">
      <img src="assets/05-cloud-host-studio.png" width="100%" alt="免远端装机多系统 SSH 云主机中心与 VS Code 历史配置迁移" />
      <p align="center"><sub><strong>免装机多系统 SSH 云主机中心（Linux / macOS / Windows）</strong></sub></p>
    </td>
    <td width="50%">
      <img src="assets/07-ide-mirror-symmetry.png" width="100%" alt="ADE 与 IDE 镜像对称模式 — 本地与 SSH 混合资源管理器与双端集成终端" />
      <p align="center"><sub><strong>瞬切 <code>ADE ⇄ IDE</code> 镜像对称与本地/远端混合终端</strong></sub></p>
    </td>
  </tr>
</table>

- **零远端后台**：在同一窗口直接编辑远端文件、查看 `HEAD` Diff 并打开远端 SSH 集成终端，**无需在目标服务器安装或升级 `vscode-server`**。
- **透明的 SSH 传输说明**：在 **macOS / Linux 上使用 OpenSSH `ControlMaster` 连接复用**，在 **Windows 上使用直连 OpenSSH**（Windows OpenSSH 不支持 Unix Socket 复用）。后台文件与 Git 传输使用 **`BatchMode=yes`**，要求已配置密钥或 `ssh-agent` 免交互鉴权（Aexus Code 从不读取或复制私钥内容）。
- **无损迁移 VS Code 配置**：通过 `aexus-ade host import-vscode` 递归解析 `~/.ssh/config`（含 `Include`）及 VS Code 远端目录历史。
- **更多界面截图与高清短视频**：请前往 [`docs/gallery.md`](gallery.md) 查看执行甘特图、浅色主题、节点审查卡、Prompt-to-DAG 浮条及全部 5 段 HD MP4 演示。

---

## 8 大本机原生 Coding Agent 引擎

所有引擎均在本机运行（`requiresCopilotSignIn: false`），共用统一的隔离环境构造器（`runtime.ts`）与首轮内联角色同步机制（`extension.ts`）：

| 引擎名称 | 会话标识 | 默认 CLI | 协议与默认安全模式 |
| :--- | :--- | :--- | :--- |
| **Claude Code** | `aexus-claude` | `claude` | 双向 `stream-json` · 默认 `acceptEdits` · 实时 Token 捕获与压缩重置 |
| **Codex** | `aexus-codex` | `codex` | `app-server` JSON-RPC（`thread/inject_items`）· 默认 `workspace-write` + `on-request` |
| **Google Antigravity** | `aexus-antigravity` | `agy` | 本机 `--hub` ConnectRPC 桥接 · 默认 `ask` |
| **Kilo Code** | `aexus-kilo` | `kilo` | ACP 运行时桥接 · 默认 `ask` |
| **OpenCode** | `aexus-opencode` | `opencode` | 原生面板 + ACP 生命周期 · 默认 `ask` |
| **DeepSeek Harness** | `aexus-dsh` | `dsh` | 原生适配器 + 可关闭角色桥接 · 默认 `ask` |
| **Cline** | `aexus-cline` | `cline` | `--acp` 流式协议 · 默认 `ask` |
| **Pi** | `aexus-pi` | `pi` | `--mode rpc` 结构化事件流与思考进度 · 默认安全模式 |

> [!NOTE]
> 针对第三方扩展的角色同步桥接（`nativeRoleBridge`）已在 [`SECURITY.md`](../SECURITY.md) 中完整披露，可随时通过设置 `aexus.ade.nativeExtensionRoleBridge.enabled: false` 或环境变量 `AEXUS_ADE_DISABLE_NATIVE_ROLE_BRIDGE=1` 关闭。

---

## `aexus-ade` 本地控制面 CLI

Aexus Code 仅监听按实例隔离的本地 `0600` Unix Socket（macOS/Linux：`~/.aexus-code/ade-control.<pid>.sock`）或本机 Windows Named Pipe（`\\.\pipe\aexus-ade-control-*`），由**单实例 32 字节令牌**（人类 CLI）与**服务端签名会话级 HMAC 能力令牌**（`AEXUS_ADE_SESSION_TOKEN`，编排智能体专用）双重鉴权：

```bash
# 0. 一键体检 8 大引擎、Git Worktree 与 OpenSSH（失败退出码 1，--strict 警告退出码 2）
aexus-ade --version
aexus-ade doctor --project .
eval "$(aexus-ade completion zsh)"   # 同时支持 bash | fish

# 1. 查看/切换组织预设或打开「组织与职级工作室」
aexus-ade role list
aexus-ade role presets
aexus-ade role preset startup-3tier
aexus-ade role studio

# 2. 启动 0 Token 模拟演示，或发起真实 Worktree 并行 DAG + $5 预算上限
aexus-ade engineering demo
GOV_ID=$(aexus-ade session create --project my-app --engine claude --role governor --title "Release Lead" --no-open --json | jq -r .id)
aexus-ade engineering init --governor "$GOV_ID" --open
aexus-ade engineering template apply --governor "$GOV_ID" --template feature-ship --preset balanced --isolation worktree --max-budget-usd 5
aexus-ade engineering run --governor "$GOV_ID"

# 3. 审批人工门禁、合并隔离 Worktree 分支并导出 GitHub PR 验收报告
aexus-ade inbox list --unread-only
aexus-ade engineering gate --governor "$GOV_ID" --node U1 --verdict pass
aexus-ade engineering worktrees merge --governor "$GOV_ID"
aexus-ade engineering report --governor "$GOV_ID" --out ./pr-verification-report.md
```

| 命令组 | 核心子命令 |
| :--- | :--- |
| `doctor` / `completion` | `doctor [--project <path>] [--strict] [--json]` · `completion <bash\|zsh\|fish>` · `--version` *（无需启动窗口即可独立运行）* |
| `role` *（别名 `roles`、`org`）* | `list` / `schema` · `apis` / `primitives` · `presets` · `preset <id>` · `reset` · `studio [rankId]` |
| `status` / `mode` / `view` | `status` · `mode [get \| set <ade\|ide>]` · `view [--archived] [--inspector <changes\|files\|hide>] [--refresh]` |
| `project` | `list` · `add <path\|host:/path>` · `select` · `remove` · `delete` · `focus` · `home` · `forward` · `move` · `changes` · `files` · `open-file` · `open-diff` |
| `host` *（别名 `cloud-host`）* | `list` · `info` · `add` · `update` · `remove` · `test` · `browse` · `import-vscode` · `open` |
| `engine` | `list` · `sessions <engine> [--project <p>] [--limit <n>]` |
| `session` | `list` · `info` · `subordinates` · `tree` · `create` · `attach` · `connect` · `open` · `select` · `close` · `send [--wait]` · `history` · `mark-read` · `draft` · `reorder` · `rename` · `role` · `move` · `stop` · `archive` · `unarchive` · `detach` · `delete` |
| `secretary` | `status` · `open` · `engine` · `reset` · `send [--wait]` · `history` · `stop` · `draft` · `mark-read` |
| `engineering` | `list` · `init` · `open` · `demo` · `generate --prompt "<goal>"` · `template <list\|apply>` · `blueprint <get\|apply\|validate>` · `run` · `pause` · `resume` · `stop` · `reset` · `configure` · `worktrees <merge\|cleanup>` · `report [--out <file>]` · `diff` · `reports` · `status` · `review` · `gate` · `watchdog-action` · `remove` |
| `inbox` | `list [--unread-only]` · `post` · `resolve` · `mark-read` |

---

## 生态定位与架构取舍对比

不同工具针对不同工作流做了取舍，以下聚焦于公开可验证的架构设计差异：

| 架构维度 | **Aexus Code** | 闭源商业 AI IDE *（如 Cursor、Windsurf）* | 外部 Worktree / 看板启动器 *（如 Vibe Kanban、Conductor）* | IDE 内部智能体插件 *（如 Cline、Roo Code）* | 独立图编排工作室 *（如 LangGraph Studio、Dify）* |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **开源协议与扩展源** | MIT · [Open VSX](https://open-vsx.org/) | 闭源商业 | 混合开源 / 商业 | 开源插件 | 混合开源 / 托管服务 |
| **原生桌面 IDE 内核** | 完整 `Code - OSS`（`ADE ⇄ IDE`） | 闭源 VS Code 分叉 | 编辑器/终端外部启动壳 | 依赖宿主 IDE | 独立 Web / 服务端界面 |
| **多引擎 BYO-CLI 编排** | 8 大本机原生 CLI 同屏混搭 | 以自有运行时为主 | 外部 CLI 窗格启动 | 单一插件运行时（多模型 API） | API / SDK 图节点 |
| **可扩展组织架构与内核权限** | 自定义职级 + 服务端签名能力令牌 | 固定代理 / 子代理模式 | 人工任务分配 | 自定义模式提示词 | 代码编写图角色 |
| **可视化 DAG + `verify:` + Worktree** | 内置双壳 DAG、`files:`、`verify:` 与 Worktree | 后台代理（无可视化 DAG） | 看板 + Worktree（脱离原生 LSP/Diff） | 顺序 / 模式循环 | 通用图（脱离 Git Worktree） |
| **免装机多根 SSH（`aexus-ssh://`）** | 原生 OpenSSH（零远端守护进程） | 需远端服务插件 | 偏本机 | 依赖宿主 IDE | 服务端托管 |

---

## 下载发行版或从源码构建

### 方式一：直接下载预编译发行版 *（最快体验）*

前往 **[GitHub Releases](https://github.com/Daijunfan/Aexus-Code/releases)** 下载由 [`.github/workflows/release.yml`](../.github/workflows/release.yml) 在版本标签上自动构建的产物与 `SHA256SUMS.txt`：
- **macOS（`arm64` Apple Silicon / `x64` Intel）**：`.dmg` 与 `.zip` *（说明：未配置 Apple Developer ID 密钥的构建采用 ad-hoc 签名，首次启动请执行 `xattr -dr com.apple.quarantine "/Applications/Aexus Code.app"` 或通过访达右键 → 打开。）*
- **Linux（`x64`）**：`.tar.gz`
- **Windows（`x64`）**：`.zip`

> **扩展市场说明**：Aexus Code 默认接入开源 **[Open VSX Registry](https://open-vsx.org/)**（`open-vsx.org/vscode/gallery`，遵循与 VSCodium 一致的开源合规策略），同时支持本地 `.vsix` 安装；微软限制仅限官方闭源构建运行的专有扩展不包含在内。

### 方式二：从源码构建

#### 前置要求
- **Node.js `24.22.1`**（与 [`.nvmrc`](../.nvmrc) 保持一致）及 **`pnpm@12.16.0`**（可通过 `nvm`/`fnm`/`mise` + `corepack enable && corepack prepare pnpm@12.16.0 --activate` 准备）。
  - `./scripts/aexus-env.sh`（macOS/Linux）与 `.\scripts\aexus-env.ps1`（Windows）会自动检测可选的 `.build/toolchain` 目录、对照 `.nvmrc` 校验当前 Node 版本并清理代理/Electron 环境变量——但**不会**自动为你下载 Node。
- **本机编译工具链**：Xcode Command Line Tools（macOS）、`build-essential` 与 X11/libsecret 头文件（Linux）或 Visual Studio 2022 C++ Build Tools + Windows 11 SDK（Windows），以及 Python 3、Git、OpenSSH。

#### 快速开始（macOS / Linux）

```bash
# 1. 安装依赖并快速转译核心与 extensions/aexus-agents
./scripts/aexus-env.sh pnpm install
./scripts/aexus-env.sh pnpm run build-fast

# 2. 体检本机 8 大编码 CLI、Git Worktree 与 OpenSSH
#    （提示：在 build-fast 之前也可直接运行：node --experimental-strip-types extensions/aexus-agents/src/adeCli.ts doctor）
./extensions/aexus-agents/bin/aexus-ade doctor

# 3. 从源码启动开发版
./scripts/aexus-env.sh ./scripts/code.sh

# 4a. macOS 打包并安装至 /Applications/Aexus Code.app（自动识别 arm64/x64，可用 AEXUS_ARCH=x64 覆盖）
ARCH=$(uname -m | sed 's/x86_64/x64/')
./scripts/aexus-env.sh pnpm run gulp "vscode-darwin-${ARCH}"
./scripts/aexus-install.sh   # 本地签名与钥匙串助手均为可选，缺失时自动降级 ad-hoc 签名

# 4b. Linux 打包（输出至 ../VSCode-linux-x64）
./scripts/aexus-env.sh pnpm run gulp vscode-linux-x64
```

#### 快速开始（Windows PowerShell）

```powershell
# 1. 安装依赖并快速转译
.\scripts\aexus-env.ps1 pnpm install
.\scripts\aexus-env.ps1 pnpm run build-fast

# 2. 体检本机编码 CLI、Git 与 OpenSSH
.\extensions\aexus-agents\bin\aexus-ade.ps1 doctor

# 3. 从源码启动开发版
.\scripts\aexus-env.ps1 .\scripts\code.bat

# 4. 打包并安装至 %LOCALAPPDATA%\Programs\Aexus Code
.\scripts\aexus-env.ps1 pnpm run gulp vscode-win32-x64
.\scripts\aexus-install.ps1
```

---

## 坦诚的局限性与非目标（Honest Limitations & Non-Goals）

我们希望在第一屏就把真实边界说清楚：

- **从源码构建体量较大**：作为完整的 `Code - OSS` Electron 桌面端，源码依赖与构建产物约占用 8–12 GB 磁盘空间，首次安装需要数分钟。只想快速试用请优先下载 GitHub Releases 预编译包。
- **macOS 发行版签名**：在尚未接入 Apple Developer ID 签名与公证前，macOS 构建包使用 ad-hoc 签名，首次打开需手动放行 Gatekeeper 隔离属性。
- **Prompt-to-DAG 是确定性脚手架，不是黑盒魔法**：`Cmd/Ctrl+K` 通过关键词规则在 `<50ms` 内零 Token 搭好并行泳道与门禁框架，更深度的任务拆解仍建议可视化调整或交由 `Governor` LLM 细化。
- **SSH 要求密钥鉴权且 Windows 无多路复用**：`aexus-ssh://` 后台文件与 Git 传输使用 `BatchMode=yes`（不支持交互输入密码或非缓存 2FA），且 Windows 客户端无法使用 Unix Socket `ControlMaster`，远端文件操作延迟高于 macOS/Linux。
- **FinOps 费用在引擎未上报时为估算值**：CLI 未返回 `total_cost_usd` 时，系统依据 Token 数与 `aexus.ade.pricing` 费率表估算并标注 `estimated`（包月订阅用户可开启 `aexus.ade.pricing.subscriptionMode` 切换为 `$0` 边际模式）。预算护栏在派发新回合前准入拦截，并在回合结束超限时立即停机暂停，因此已在运行中的单回合仍可能轻微超出阈值。
- **非目标**：不提供托管云端 SaaS IDE、不中转或加价转售模型 API Token，也不捆绑微软闭源 Copilot 或 Visual Studio Marketplace。

---

## 社区、安全与开源许可

- **架构与贡献**：请参阅英文架构文档 [`docs/ARCHITECTURE.md`](ARCHITECTURE.md)、[`CONTRIBUTING.md`](../CONTRIBUTING.md) 与 [`CHANGELOG.md`](../CHANGELOG.md)。
- **安全模型与威胁边界**：请参阅 [`SECURITY.md`](../SECURITY.md)，完整了解默认安全模式、服务端能力令牌、防仓库提示词注入、SHA-256 `verify:` 锁定、SSH 边界及第三方扩展角色桥接的关闭方式。
- **开源许可与合规声明**：基于 Microsoft [`Code - OSS`](https://github.com/microsoft/vscode) 衍生开发并遵循 **[MIT License](../LICENSE.txt)**，完整保留上游版权声明。Aexus Code 使用原创几何标识（`docs/assets/aexus-logo.svg`）并接入开源 [Open VSX Registry](https://open-vsx.org/)。
