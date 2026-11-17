# macOS 安装授权

应用由固定的本地签名证书签名，证书私钥留在登录钥匙串。公开的证书指纹保存在 `~/.config/aexus-code/signing.json`。

`~/.local/share/aexus-code/keychain-access` 是固定签名的本地安装助手。它仅从 `Aexus Code Keychain Bridge` 读取 Aexus 的原有加密密钥，通过匿名管道交给安装版应用。安装版在 Node 模式中调用 `keychain-storage.node`，用同一把密钥恢复自己的 Safe Storage 记录并立即校验读取。所有钥匙串操作均关闭系统交互，整个过程不创建窗口，也不保存登录密码。

Bridge 记录本身由登录钥匙串加密，仅授权 Aexus 应用及固定的本地签名助手读取。它保留更新前后的同一把加密密钥，使已保存的扩展凭据可以继续解密。安装时应用必须已退出。

通过 `scripts/aexus-install.sh` 安装。安装助手及其签名身份必须保持稳定；不要在未迁移现有 Bridge 授权的情况下重新编译覆盖助手。C / Objective-C 文件为安装助手的源码，首次授权迁移在本机完成，不打包进编辑器，也不读取其他服务的凭据。
