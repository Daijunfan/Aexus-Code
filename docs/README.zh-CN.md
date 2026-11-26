<p align="center">
  <img src="assets/aexus-logo.png" width="88" alt="Aexus Code 黑白标志" />
</p>

<h1 align="center">Aexus Code</h1>

<p align="center">
  <strong>开源轻量跨机多智能体编排环境（ADE）与镜像对称 IDE</strong><br/>
  单文件夹 1..N Project 页面 · 单父节点汇报树与连通子树部门 · 45 个双向 HMAC <code>ade_*</code> CLI · 四象限跨主机动态存储 · 8 大原生 BYO-CLI 引擎
</p>

<p align="center">
  <a href="https://github.com/Daijunfan/Aexus-Code/actions/workflows/aexus-ci.yml"><img src="https://github.com/Daijunfan/Aexus-Code/actions/workflows/aexus-ci.yml/badge.svg" alt="Aexus Code CI" /></a>
  <a href="https://github.com/Daijunfan/Aexus-Code/releases"><img src="https://img.shields.io/badge/Release-v1.1.0%20%C2%B7%20macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-0284c7?style=flat-square" alt="预编译发行版 v1.1.0" /></a>
  <a href="../LICENSE.txt"><img src="https://img.shields.io/badge/License-MIT-0f172a?style=flat-square" alt="MIT License" /></a>
  <a href="https://open-vsx.org/"><img src="https://img.shields.io/badge/Extensions-Open%20VSX-6366f1?style=flat-square" alt="Open VSX 开源扩展市场" /></a>
  <img src="https://img.shields.io/badge/Modes-ADE%20%E2%87%84%20IDE%20Symmetry-2563eb?style=flat-square" alt="ADE IDE 镜像对称" />
  <img src="https://img.shields.io/badge/Native%20Engines-8%20BYO--CLI%20Agents-059669?style=flat-square" alt="8 大本机原生编码引擎" />
</p>

<p align="center">
  <a href="../README.md">English</a> · <strong>简体中文</strong> · <a href="ARCHITECTURE.md">架构总览</a> · <a href="gallery.md">视觉图集</a> · <a href="../SECURITY.md">安全模型</a> · <a href="../CHANGELOG.md">更新日志</a> · <a href="../CONTRIBUTING.md">贡献指南</a> · <a href="../CODE_OF_CONDUCT.md">行为准则</a>
</p>

<p align="center">
  <img src="promo/aexus-01-flagship-command-center-dark.png" width="100%" alt="Aexus Code ADE 指挥中心" />
</p>

## 核心设计概览

**Aexus Code**（`v1.1.0`）基于开源 `Code - OSS`（`1.146.0`）打造，采用 **MIT 协议**，默认接入开源 **[Open VSX](https://open-vsx.org/)** 扩展市场并移除微软闭源 Copilot 遥测，在一个本地优先的桌面工作台中融合完整原生 **IDE（`IDE`）** 与轻量跨机多智能体编排环境 **ADE（`ADE`）**：

1. **左栏 `Workspace Folder -> 1..N Project` 与强制双向连线画布** —— 在本地 `file://` 或免装机 `aexus-ssh://` 云端文件夹下无上限创建多个独立 Project 编排页面（支持左右分屏对照）。画布渲染单父节点汇报树（`344×188` 员工节点 + `276×164` 共享白板），配备恒定像素双端自适应箭头、严格维持 3000ms 的跨级弧长接力流光粒子、连线悬停最近传递时间提示以及点击全量历史与单张详情面板。
2. **全套 45 个独立 `ade_*` CLI 与全双工双向 HMAC-SHA256 鉴权** —— 员工会话通过 4 大模块共 45 个 `ade_*` 命令完成全部协作，底层走本地 `0600` Unix Socket 或云端 SSH StreamLocal 反向隧道，基于纯内存 `ADE_AGENT_TOKEN` 完成双向挑战-响应验签与宿主通道强绑定，磁盘零明文密钥。
3. **零隐式提示词污染与按需只读模块手册** —— 彻底清除隐式系统提示词拼接与扩展宿主 Preload 劫持；工作区仅放置精简路由指南 `AGENTS.md`，员工通过 `ade_sysprompt_path` 按需读取外部 `0444` 只读文档（`ticket.md`、`orchestration.md`、`whiteboard.md`）。
4. **形式化连通子树部门、两级白板鉴权与无损销毁归档** —— 严格执行单向层级管辖、分支截断连通子树部门、员工删除时白板 100% 无损向上过户，以及 `ade_destroy` 本地 `archived_detail_gzip` 压缩归档 + 远端物理文件墓碑彻底清理。
5. **四象限跨主机动态存储与免装机 SSH 云主机** —— 自动在本地 Mac 与云主机之间调度 Ticket 详述与白板文件备份（同云主机本机直拷零绕回、SSH 三重完整性门禁、字典序双机信号量防 AB-BA 死锁、多跳 CAS 在线搬迁），无需安装 `vscode-server` 且绝不修改全局 `~/.ssh/config`。
6. **8 大原生 BYO-CLI 引擎与 60fps 双路实时流式输出** —— 支持 **Claude Code**、**Codex**、**Google Antigravity**、**Kilo Code**、**OpenCode**、**DeepSeek Harness**、**Cline** 与 **Pi**，按员工独占守护进程槽位（`ade:<projectId>:<agentId>`），物理拆分保上下文 `interruptTurn`（`killTree: false`）与彻底清场 `disposeAgentRuntime`（`killTree: true`），无论聊天窗已打开还是中途双击点开均实时流式可见。

## 45 个 `ade_*` CLI 命令总览

| 模块 | 命令列表 | 核心职责 |
| :--- | :--- | :--- |
| **0. Base（3）** | `ade_whoami` · `ade_sysprompt_path` · `ade_sysprompt_update` | 身份与计数自检、获取当前机器 `0444` 模块手册真实绝对路径、增量查看文档版本变更。 |
| **1. Ticket（7）** | `ade_create` · `ade_destroy` · `ade_edit` · `ade_list` · `ade_get` · `ade_detail` · `ade_history` | 上下级双人绑定非阻塞任务令牌（`queue` / `steer`）、长文详述读写、历史任务链查询与归档销毁。 |
| **2. Orchestration（15）** | `ade_host_list` · `ade_engine_list` · `ade_model_list` · `ade_agent_list` · `ade_agent_create` · `ade_agent_edit` · `ade_agent_move` · `ade_agent_delete` · `ade_dept_create` · `ade_dept_edit` · `ade_dept_delete` · `ade_dept_member` · `ade_dept_members` · `ade_dept_info` · `ade_wb_grant` | 主机/引擎/模型探测、下属节点增删改移、嵌套连通子树部门划分与下级白板单独授权。 |
| **3. Whiteboard（20）** | `ade_wb_list` · `ade_wb_my_perm` · `ade_wb_members` · `ade_wb_create` · `ade_wb_config` · `ade_wb_delete` · `ade_wb_tags` · `ade_wb_tag_manage` · `ade_wb_post_msg` · `ade_wb_upload_file` · `ade_wb_items` · `ade_wb_get_msg` · `ade_wb_download` · `ade_wb_edit_item` · `ade_wb_delete_item` · `ade_wb_manage_item` · `ade_wb_note_send` · `ade_wb_note_unread` · `ade_wb_note_detail` · `ade_wb_unread_all` | 部门一板制共享消息、独立跨机文件备份与下载、受控标签池、所有者置顶管理与 `<=300` 字自适应内联留言（17 个单白板接口顶层恒带 `unread_count`）。 |

## 快速开始与源码构建

```bash
# 1. 安装依赖并快速转译核心与扩展（自动生成 45 个 ade_* 启动器）
./scripts/aexus-env.sh pnpm install
./scripts/aexus-env.sh pnpm run build-fast

# 2. 编译并运行 8 引擎扩展与 45 CLI 单元门禁测试
(cd extensions/aexus-agents && ./../../scripts/aexus-env.sh npm run compile && ./../../scripts/aexus-env.sh npm test)

# 3. 从源码启动开发版（按 Alt+Cmd+A / Alt+Ctrl+A 瞬切 ADE ⇄ IDE）
./scripts/aexus-env.sh ./scripts/code.sh
```

## 架构文档与开源许可

- **架构、图集与安全模型**：[`docs/ARCHITECTURE.md`](ARCHITECTURE.md) · [`docs/gallery.md`](gallery.md) · [`SECURITY.md`](../SECURITY.md) · [`CONTRIBUTING.md`](../CONTRIBUTING.md) · [`CHANGELOG.md`](../CHANGELOG.md)。
- **开源许可**：基于 Microsoft [`Code - OSS`](https://github.com/microsoft/vscode) 衍生开发并遵循 **[MIT License](../LICENSE.txt)**。
