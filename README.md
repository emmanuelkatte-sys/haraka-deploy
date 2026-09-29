# Haraka SMTP 自动部署模块 (纯净安全版)

本仓库提供 Haraka 高性能 SMTP 邮局的自动化安装、配置与管理资源。
所有后门、外发及未经授权的遥测代码已彻底清除。

## 包含文件
- `configure_haraka.sh`: Haraka 完整单机一键配置脚本（纯净版）
- `configure.sh_haraka.template`: 动态模板（供发信控制台批量部署使用）
- `plugins/log_delivered.js`: 纯净本地投递统计插件（无 Telegram，无收件人泄露）
- `haraka-dkim-sign-stream.js`: 高性能流式 DKIM 签名插件
- `hrkdeploy-go.sh`: VPS 现场自动编译部署发件注入器脚本
- `hrkdeploy.sh`: Shell 版本部署脚本
- `sync_log_delivered.py`: 插件 Base64 嵌入同步脚本
- `repack_haraka_bundle.py`: 离线 Bundle 打包工具
- `bundle_heraka.txt`: 离线包元数据与 SHA256 校验和

## Release 离线安装包
预编译并清理完毕的离线包 `haraka-bundle-v1.4.tar.gz` 存放在本仓库的 [Releases](../../releases) 页面中。
