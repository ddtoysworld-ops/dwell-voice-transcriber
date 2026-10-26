# D'WELL 语音转文字插件

这是独立的 Chrome 插件，可将 WhatsApp Web 和 Meta Business Suite 中的语音消息转成文字；非中文语音会同时显示中文翻译。它不会代替现有的 D'WELL CRM 插件。

**[点击下载正式版 v0.1.3 ZIP](https://github.com/ddtoysworld-ops/dwell-voice-transcriber/raw/refs/heads/main/release/dwell-voice-transcriber-0.1.3-production.zip)**

## 客服下载安装

1. 点击上面的“下载正式版”链接。不要点绿色 `Code` 菜单里的 `Download ZIP`，那是源码，不是安装包。
2. 解压 ZIP。Chrome 打开 `chrome://extensions`，开启右上角“开发者模式”，点击“加载已解压的扩展程序”，选择解压后的 **`production-0.1.3`** 文件夹（里面应直接看到 `manifest.json`）。
3. 若该浏览器装过旧版，请先移除或关闭旧版插件，避免重复按钮。
4. 点击插件图标，使用自己的正式客服账号登录。打开 WhatsApp Web 或 Meta Business Suite，并刷新聊天页面；语音下方会出现“转成文字”。
5. 以后更新已加载的文件夹后，也要在 `chrome://extensions` 点击插件的“重新加载”，再刷新聊天页面。

批量转写只处理当前聊天已加载的语音；更早的消息需要先滚动加载。转写结果可展开、收起和复制。

## 隐私与权限

插件通过正式 Supabase 项目 `osgqzpdfjdnkzmyzitrm` 验证客服身份。语音经已登录的 Edge Function 发往 OpenAI 处理；插件不会将语音存入数据库，也不会自动发送聊天消息。OpenAI 密钥只保存在正式项目的 Edge Functions Secrets，**不在安装包、源码或客服电脑内**。请勿在截图、聊天或 GitHub 中公开密钥与顾客语音。

## 开发与验证

`extension/` 是源码，不是正式安装目录。正式包由 `npm run build:production` 生成，测试包由 `npm run build:qa` 生成。提交或发布前运行：

```powershell
npm test
npm run check
node tests/ui-smoke.mjs
node tests/package-smoke.mjs
```

正式项目和隔离测试项目各自需要部署 `dwell-voice-transcribe`，并分别设置 `OPENAI_API_KEY`。不要把测试包交给客服使用。

