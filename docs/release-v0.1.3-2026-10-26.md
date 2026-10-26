# 语音转文字插件 v0.1.3（2026-10-26）

客服仅安装 `release/dwell-voice-transcriber-0.1.3-production.zip`；解压后选择 `production-0.1.3` 文件夹。不要安装源码 ZIP、QA 包或 staging 包。

本版改善 Messenger 多条语音的读取及对应关系，支持部分 AAC 语音无损封装为可识别格式，并保留 WhatsApp 转写、中文翻译、结果收起与批量转写。正式语音函数优先使用 `gpt-transcribe`；仅在文件格式遭拒时尝试一次兼容模型。转写仍可能受第三方页面或服务状态影响，失败时可复制不含语音内容的诊断代码。

正式包 SHA-256：`1232602B451C058196960CD2C35A0BB0A0F9D9E9654D653F8FEE3709BFC6B227`。正式包指向 Supabase 项目 `osgqzpdfjdnkzmyzitrm`，不包含 OpenAI 密钥。

发布前通过 30 项自动化测试、配置及密钥检查、正式包检查；用户已在本机 `0.1.3` 确认 Messenger 与 WhatsApp 各一条语音转写成功。
