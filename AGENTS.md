# VS Code Agents Instructions

## Aexus Code 安装硬性规则

只保留最新的一个 Aexus Code 应用包，唯一保留位置为 `/Applications/Aexus Code.app`。安装与校验成功后，立即删除旧版、备份、构建输出和测试运行目录中的重复应用包，不保留回滚副本。构建或测试临时生成的应用包在任务结束前必须清理。通过 `scripts/aexus-install.sh` 安装，全程后台处理，不主动打开窗口。源码、用户设置和已安装扩展不是旧应用包，不得随应用清理删除。

验收不得触发应用窗口、浏览器、登录或钥匙串授权提示。打包后的 APP 会把传入的 `runner.cjs` 当作待打开文件，不得用这种方式尝试隐藏窗口。安装版只做不启动界面的检查；需要真实面板验证时，使用确保窗口不可见的源码运行时。授权密码不得写入代码、配置、日志或文档。

This file provides instructions for AI coding agents working with the VS Code codebase.

For detailed project overview, architecture, coding guidelines, and validation steps, see the [Copilot Instructions](.github/copilot-instructions.md).
