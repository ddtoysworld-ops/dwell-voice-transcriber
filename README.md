# D'WELL Voice Transcriber

Independent Chrome extension for transcribing WhatsApp Web and Meta Business Suite voice messages. Audio is sent to an authenticated Supabase Edge Function, forwarded to OpenAI, and discarded after the response.

## Packages and service

- `output/qa-0.1.0/` connects to the isolated Supabase test project. It is for acceptance testing only.
- `output/production-0.1.0/` connects to the official Supabase project. Load this directory as an unpacked Chrome extension for staff use.
- `release/dwell-voice-transcriber-0.1.0-production.zip` is the accepted production archive published with this repository. Extract it before using Chrome's `Load unpacked` action.
- The `dwell-voice-transcribe` Edge Function is deployed separately in both projects. Each project needs its own `OPENAI_API_KEY` Edge Function secret; no OpenAI key belongs in the extension.
- The extension authenticates staff through the selected project's Supabase Auth before sending audio. It does not save audio in a database or send chat messages.
- Default transcription model: `gpt-4o-mini-transcribe`.
- The existing D'WELL CRM extension is unchanged.

## Local checks

```powershell
npm test
npm run check
```

## Production setup

1. In official Supabase project `osgqzpdfjdnkzmyzitrm`, open Edge Functions > Secrets and save `OPENAI_API_KEY` from an OpenAI Platform project with available API credit.
2. Confirm `dwell-voice-transcribe` is active in that same project. The test project's secret does not apply to production.
3. Build with `npm run build:production`, then load `output/production-0.1.0/` through Chrome's `Load unpacked` action. Do not load `extension/` directly: its checked-in config is not the production build.
4. Sign in using an official D'WELL staff account. Test a short, non-customer voice message on both WhatsApp Web and Messenger before distributing to staff.
5. For an update to an already-loaded directory, click `Reload` in `chrome://extensions` and refresh the chat page.

Disable the QA extension before enabling the production extension; otherwise both content scripts can add controls to the same chat. The production extension has separate Chrome storage, so sign in again after switching.

The batch button handles voice messages currently loaded in the conversation, in order, and skips completed transcripts. It cannot process older messages that the site has not loaded yet. Never put the OpenAI key in the package, a screenshot, a chat message, or source control.

