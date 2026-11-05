# dsh-onebot

> **English | [中文](README.md)**

A QQ channel for DeepSeek Harness. 给 DeepSeek Harness 加上 QQ 通道。

This plugin turns dsh into a QQ bot (**OneBot 11 protocol**, compatible with NapCat / Lagrange / LLOneBot / go-cqhttp).
Like [dsh-vision](https://github.com/dsh-external/dsh-vision), it ships as an external plugin: **zero Python, pure
TypeScript, a native Cordis plugin** mounted into the dsh host process, with no core code changes.

```
User(QQ) ←→ NapCat ←→ dsh-onebot plugin ←→ dsh Agent (one per chat)
                        ├─ Reverse WS server / forward WS client (auto-reconnect)
                        ├─ Inbound: CQ parsing, image download, speech-to-text (STT), reply/forward expansion
                        └─ Outbound: sends via the model's qq_* tools, per-character pacing
```

## Architecture

![dsh-onebot — QQ channel architecture](docs/dsh-onebot-architecture-en.png)

> Interactive version (dark/light theme toggle + guided views): [docs/dsh-onebot-architecture.html](docs/dsh-onebot-architecture.html); vector version: [docs/dsh-onebot-architecture-en.svg](docs/dsh-onebot-architecture-en.svg).

## Features

| Category | Capability |
|---|---|
| Connection | Reverse WS (NapCat ws-reverse dials in, default port 8643) or forward WS (plugin dials out, default `ws://127.0.0.1:3001`); auto-reconnect with backoff (2s → 60s) |
| Inbound | Private/group chats; the payload is a **JSON array of records** (ascending time, last record = the current message, the rest = the group window before it; a record carries qq/nickname/id/time/message, plus role for owner/admins); the group window is cut from `get_group_msg_history` by a persisted `{time,id}` watermark, marks "更早的消息已省略" when the anchor slid out of history, and never injects an already-injected message twice; segment arrays only (no CQ-string layer); @/reply trigger detection (fail-closed: replies count only when replying to the bot itself, verified through `get_msg` and reused for quote expansion); media segments are backfilled with file names inside the media directory (the full path prefix is stated in the system prompt; images from 4 sources url/base64/file/hash with auto-shrink at `inboundImageMaxPx`, GIFs untouched; files via the dual channel `get_private_file_url` + `get_file` base64/url fallback) and become an explicit "not fetched" note when the bytes cannot be had; quotes and merged forwards expand in place into a quoted record and node records according to `quoteExpandDepth` / `forwardExpandDepth` (default 0 = id only), with `forwardExpandCount` capping the nodes per expansion (the outer layer's unused budget is split evenly across nested forwards); face segments carry their Chinese name; a poke wakes the bot and pokes between other members join the window |
| Voice | ffmpeg to 16 kHz WAV + whisper transcription (openai-whisper / whisper.cpp / custom command); **non-blocking**: the voice message enters the turn as a `record` segment with a media file name right away, and the transcript follows as a `（语音转写：…）` supplement when done (default timeout 60s); failure, timeout or an empty transcript keeps the `record` segment as the final state |
| Outbound | **The model's `qq_send_*` tool calls are the only way to speak**: the turn's assistant text is never auto-sent (no tool call = no message); merged forwards via `qq_send_forward` (group/private); per-character pacing (base 300ms + 60ms/char + ±30% jitter, see the three config keys below); typing indicator (`set_input_status`, private chats only) |
| Commands | Slash commands (admin only): `/new` fresh session, `/session` list switchable historical sessions and switch back by number, `/model` view/switch the current session's model (`--default` changes the deployment default; the bare form renders a two-level numbered list); long-lived per-chat-type models live in the settings page "Private chats"/"Group chats" blocks as dropdowns (`modelPrivate` / `modelGroup`); `/compact` forwards the host's context-compaction command; every other slash text goes to the model |
| Tools | `qq_send_message` (the general outlet: text/image/voice/video/file segments), `qq_send_text`, `qq_send_image` (≤9 images, path or URL), `qq_send_voice`, `qq_send_video`, `qq_send_file`, `qq_send_forward`, `qq_send_poke` (poke a user), `qq_list_stickers` (list a pack's summaries and captions, optional 4×4 contact sheet), `qq_send_sticker` (send by pack + summary), `qq_collect_sticker` (batch collect; plain images need a summary and caption), `qq_remark_sticker` (batch edit summaries/captions), `qq_napcat_api` (20 allowlisted actions), `qq_end_turn` (end the turn), `qq_create_schedule` / `qq_list_schedules` / `qq_delete_schedule` / `qq_update_schedule` (group/DM schedules with the same rules as dsh `schedule_*`: delay, absolute time, interval, daily, weekly, cron), `qq_group_history`, `qq_model` (inspect the effective model and the configured designation; switch the current session's or the deployment-default model/thinking level); guarded file editing `code_safe_edit`/`code_safe_rollback`/`code_list_backups` moved to the standalone plugin **dsh-safe-edit** — see Safe editing below |
| Permissions | Admin allowlist (`ONEBOT_ALLOWED_USERS`), dm/group policies (open/allowlist/disabled), group @-mention gating, restricted users soft limit (`[受限用户:仅问答]`) |
| Sessions | One persistent Agent per QQ chat (stable derived session id), auto-resumed after restart; mounted into presets/workspaces via `agentPreset`/`workspacePath`; mapping flushed to disk at the end of every turn |
| Ops | Hot reload: **config overrides** and **insert additions/removals** in the profile-level patch take effect hot — the plugin fiber restarts in place within seconds (the host process is not restarted; cost: one second-level QQ bridge reconnect, in-flight turns interrupted); touch / no-content-change triggers nothing; changes to the bundle's built-in patch, repo templates, deployment-copy patch files, or the root `cordis.yml` do **not** hot-reload; temp media TTL cleanup |
| Prompt | Injects QQ platform notes automatically (plain-text output, `[图片]`/`[语音]` placeholders for incoming images/voice, tool & command guidance, host interaction cards banned); injected into **each QQ chat agent's own scope**, invisible to Web sessions |

## Compatibility

| Item | Requirement |
|---|---|
| dsh | ≥ 0.1.5-rc.1 (`engines.dsh`: full 0.1.5/0.1.6/0.1.7 lines + 0.2.0 line ≥0.2.0-rc.1; @deepseek-ai/* peer deps same range, JsonValue provided by dsh-util-values) |
| Node.js | ≥ 22 |
| OneBot 11 impl | NapCat / Lagrange / LLOneBot / go-cqhttp (reverse or forward WebSocket) |
| Optional deps | Voice transcription needs ffmpeg + whisper CLI |

Last verified: 2026-11-01 (`npx tsc --noEmit` clean; vitest 406 tests green).

## Installation

**Prerequisites**: dsh (≥0.1.5-rc.1) on PATH; NapCat or another OneBot 11 implementation running.

### npm install (published channel — pick this OR the source install below; do not mix)

```sh
dsh plugin --profile web add dsh-onebot-qq
```

(or install from the Plugins page in the web UI.) Then:

1. Write two lines into `pnpm-workspace.yaml` in the profile directory
   `<DSH_HOME>/profiles/web/` (pnpm 12 no longer reads a project-level `.npmrc`, see
   `docs/npm-e2e-report.md` D1):

   ```yaml
   autoInstallPeers: false
   hoist: false
   ```

   — this stops pnpm from pulling stale standalone `@deepseek-ai/*` copies from the registry.
   npm/pnpm version difference: this is required for pnpm 12 users only (pnpm 12 no longer
   reads `.npmrc`); npm users are unaffected — npm's default peer auto-install pulls registry
   versions that now satisfy the peer range (`docs/npm-e2e-report.md` §1 #2).
   Runtime peer unification is done by the host's resolver layer: any
   `@deepseek-ai/*` import declared in the package's peerDependencies is intercepted by the host
   and redirected to the same instance in the host install tree — no npm overrides needed.
2. Merge the two `insert` lines from the bundled `cordis.patch.yml` template into the
   profile-level `<DSH_HOME>/profiles/web/cordis.patch.yml`: main entry
   `name: 'dsh-onebot-qq'`, host-plane line
   `name: 'dsh-onebot-qq/settings-remote'`; config overrides must sit on the
   top-level line with the same id (see the template header for details).
3. **Never** hand-write any `@deepseek-ai/*` dependency into the profile's package.json — a
   hand-written copy overrides the host install tree as the interception target, causing a
   version-skewed dual-package.
4. If the compatibility gate rejects the install (dsh version outside the peer range), use the
   official escape hatch `dsh plugin allow-version ... --accept-risk` to opt in explicitly.

### Option 2: install from source (git clone)

```sh
git clone <repo> ~/dsh-plugins/dsh-onebot
cd ~/dsh-plugins/dsh-onebot
npm install --include=dev
./scripts/build.sh          # link host @deepseek-ai packages + tsc src/ → lib/
```

> **A deployment copy must carry the full node_modules link set** (produced by `scripts/link-host.sh`): `files`
> packages only `lib/`, but the runtime peer deps `@deepseek-ai/*` are symlinked to the host install — copying
> `lib/` alone fails to mount (the plugin entry fails loudly with an explicit "peer dependency resolution failed"
> error). When the host has no `dsh` on PATH (e.g. the fnOS app form), use the escape hatch:
> `DSH_ROOT=<host node_modules path> ./scripts/build.sh`.

**Building against an fnOS app-form host**: the dsh installed from the fnOS App Center has no `dsh` CLI on PATH,
so `build.sh`'s auto-discovery (PATH binary → npx store) fails with an explicit `cannot locate the dsh install`.
Point `DSH_ROOT` at the host node_modules root explicitly (it must contain `@deepseek-ai/`; a wrong path errors
out instead of silently falling back):

```sh
DSH_ROOT=<fnOS app data dir>/node_modules ./scripts/build.sh
```

After building, place the deployment copy (`lib/` + the full node_modules link set) at the target location and
mount it; a runtime copy missing the link set fails to mount the same way (see above).

Mount it in `~/.dsh/config.yaml` (create it if missing):

```yaml
- insert:
    - id: dsh-onebot
      name: '$HOME/dsh-plugins/dsh-onebot/lib/index.js'
      config:
        mode: reverse        # reverse = NapCat dials in; forward = plugin dials out
        port: 8643
        # accessToken: 'token-matching-NapCat'  # required: reverse mode refuses to start with an empty token (M0 hardening)
        # botQQ: ''          # leave empty to learn automatically from meta events
        adminUsers: ['<your-QQ-number>']   # required: at least one admin, otherwise private chats & slash commands are unavailable
```

> **You must configure at least one admin on first setup** (`adminUsers` or the `ONEBOT_ALLOWED_USERS` env var):
> `dmPolicy: open` (default) only allows admins to DM, and slash commands are admin-only too; with no admin,
> nobody can talk to the bot.
> For development you can temporarily set `allowAllUsers: true` (or `ONEBOT_ALLOW_ALL_USERS=true`) to allow everyone.

Restart dsh (`dsh web` or however you start it); the log line `[dsh-onebot] mounted` means it loaded.

**NapCat side (required, pick one of two modes)**:

- **reverse mode (NapCat dials into dsh, recommended)**: in NapCat's network settings add a **WebSocket client**,
  set "report URL" to dsh's WS address `ws://<dsh-host-ip>:<port>/ws` (e.g. `ws://192.168.1.100:8643/ws`),
  and set "token" to the same value as the plugin's `accessToken`; when dsh and NapCat are on different machines
  `127.0.0.1` won't work.
- **forward mode (dsh dials out to NapCat)**: enable the **WebSocket server** in NapCat's network settings
  (listens on `0.0.0.0:3001` by default), set the plugin's `url` to `ws://<napcat-host-ip>:3001`
  (`ws://127.0.0.1:3001` works on the same machine), tokens must match on both sides.

Tokens must match on both sides; for the message report format, choose **"array"** (the plugin parses segment
arrays first; CQ strings are only a fallback). After configuring, restart dsh. `[dsh-onebot] mounted` in the log
plus a successful NapCat connection means you're ready.

**Deployment requirements**: NapCat must be on a LAN **reachable from dsh** (same subnet / routable).
The WS connection, image downloads and file resolution all depend on this network path; when NapCat and dsh are
not on the same machine, enable the **"file-to-URL" switch** on the NapCat side so `get_file` returns a downloadable
http(s) url (otherwise it returns a container-local path the plugin cannot access).

## Configuration

The full schema lives in the `Config` of [src/index.ts](src/index.ts) (schemastery-validated, every key has a
default). Common options:

| Key | Default | Description |
|---|---|---|
| `mode` | `reverse` | `reverse`/`forward` |
| `host` / `port` | `127.0.0.1` / `8643` | reverse listen address; for cross-machine deployment (NapCat dialing in from another machine), explicitly set this to `0.0.0.0` |
| `url` | `ws://127.0.0.1:3001` | forward target |
| `reconnectMaxAttempts` | `100` | reconnect give-up limit: auto-reconnect stops after this many consecutive failures (the log includes the limit and recovery guidance); `0` = unlimited retries (backoff capped at 60s) |
| `accessToken` | empty | OneBot token; **required in reverse mode** — the plugin refuses to start when left empty (fail-closed); may stay empty in forward mode |
| `botQQ` | empty | bot QQ (empty = auto-learned) |
| `ignoreSelf` | `true` | Ignore messages sent by the bot itself (prevents self-loops) |
| `requireMention` | `true` | groups respond to an explicit @ or a reply to the bot; reply-only triggers verify the original author through `get_msg.sender.user_id`. Replies to others, unknown authors and lookup failures do not trigger (fail-closed). Explicit @bot remains independent of quote lookup |
| `recentMessages` | `50` | total records injected per @ (including the current message; the "更早的消息已省略" note does not count; `0` = current message only, range 0–100). Groups cut backwards from the current message by the watermark; private chats carry only the current message |
| `quoteExpandDepth` | `0` | quote auto-expansion depth: `0` = no expansion, the `reply` segment keeps only `id` (the model can fetch it with `get_msg`); `1` = expand one quoted message, and quotes/forwards inside it use their own remaining depth; and so on |
| `forwardExpandDepth` | `0` | merged-forward auto-expansion depth: `0` = no expansion, the `forward` segment keeps only `id` (the model can fetch it with `get_forward_msg`); `1` = expand one level of nodes, and quotes/forwards inside them use their own remaining depth; and so on |
| `forwardExpandCount` | `20` | maximum nodes expanded per merged forward (shared across the nested tree): the outer layer expands up to this count first; when it has fewer nodes, the unused budget is split evenly across the nested forwards |
| `sleepMode` | `window` | dormancy mode: `window` = the daily `sleepStart`/`sleepEnd` range; `peak` = peak-priced hours (Beijing time, weekdays 9:00–12:00 and 14:00–18:00) |
| `sleepStart` / `sleepEnd` | empty | dormancy range (HH:MM, Asia/Shanghai wall clock, may cross midnight such as `23:30`–`08:00`); empty = disabled, both ends must be set and differ. While dormant nothing is answered; each chat hands its first wake per spell to the model for one goodbye, then stays quiet |
| `dedupWindowSeconds` | `300` | inbound message dedup window (seconds, W2-②): within the window a redelivered message with the same message_id in the same chat is processed only once; later duplicates are silently skipped with a debug log; applies only to message events that trigger reply handling (notice/meta events never reach this gate); `0` disables dedup |
| `traceEnabled` | `false` | decision tracing (W1): mints a traceId per inbound message and carries it through inbound → agent turn → outbound; decision events (dedup / whitelist / @-gate and every previously silent drop, each with a Chinese reason) append one JSON line to `mediaDir/qq-trace.jsonl` (4MiB rename rotation, keeps `qq-trace.1/2.jsonl`; identical failure causes are rate-limited to one line per 5 minutes; async queued writes never block the pipeline); default OFF — no traceIds, no file, zero behavior difference |
| `traceLevel` | `debug` | trace event level (W1): `debug` records every decision event; `warn` records only ok:false (rejected/failed/dropped) events |
| `logLevel` | `info` | console log gate (debug < info < warn < error): messages below the configured level are dropped. `debug` prints everything (incl. debug lines); `info` routine info (mount, connection, meta events — default); `warn` warnings and errors only; `error` errors only |
| `recordInbound` | `false` | inbound recording (W1): appends every inbound event — including gate-skipped ones, with the decision reason current at that moment — to `mediaDir/qq-inbox.jsonl` in a replayable one-JSON-per-line shape (2MiB rename rotation, keeps `qq-inbox.1/2.jsonl`; injected frames are never re-recorded, so no inject→record→replay feedback loop); pure bypass: write failures only warn (rate-limited) and never affect the reply path |
| `inboxRedact` | `false` | recording redaction (W1): masks every 6+ digit run (QQ/group numbers and similar) to its first 3 digits + `****` before the line is written (numeric id fields handled too), so recordings can be shared for offline replay (`npm run replay`) |
| `injectEnabled` | `false` | event injection channel (W1, **DEBUG-ONLY**): when on, the bridge polls `mediaDir/qq-inject.jsonl` every `injectIntervalMs` and feeds each new line (one OneBot message-event JSON per line) through the **real inbound pipeline** (trace events tagged `stage=inject`); lines that already existed at startup are skipped and reported. Trust boundary: injection is a debug channel, disabled by default — do not enable in production |
| `injectDryRun` | `true` | inject dry-run (W1, **strongly keep `true`**): every outbound WRITE triggered by an injected round (sends/recalls, **including the asynchronous agent turn's final reply** — intercepted at the outbound action layer) is counted with its original text in the trace stream and never reaches real QQ; a real message to the same chat clears the interception immediately (never collaterally intercepting real users); `false` = injected rounds really send, isolated environments only |
| `injectIntervalMs` | `2000` | inject queue poll interval (ms, W1; minimum 500) |
| `steerEnabled` | `false` | how a new message is handled while the chat's task is running (steer switch): on = submit it as a supplementary instruction into the running turn (read at the agent's next step) for every message shape (text / image / file / voice / quoted / merged forward); off (default) = queue it as the next turn after the current task ends. Neither path sends a notice. Without a running task this switch has no effect. Editable in the settings page behavior group; applies after a hot restart |
| `steerAllMembers` | `false` | steer eligibility (active while the steer switch is on): on = every member may steer; off (default) = admins only. Messages from senders without eligibility take the queue path. Editable in the settings page behavior group; applies after a hot restart |
| `steerAllowRestricted` | `true` | restricted-member steer (active while the steer switch is on): on (default) = group members under the soft limit (non-admin with `restrictedMemberPrefix` on) may also steer; off = restricted members always take the queue path. Editable in the settings page behavior group; applies after a hot restart |
| `thinkingPrivate` | `default` | thinking effort for new private-chat sessions; `default` follows the deployment default. A dropdown in the settings page; its options come from the selected private-chat model's capabilities and refresh when the model changes |
| `thinkingGroup` | `default` | thinking effort for new group-chat sessions; same rules as `thinkingPrivate` |
| `modelPrivate` | `''` | model for private chats, `<provider>/<model>`; empty = deployment default. Chosen with a two-level provider → model dropdown in the settings page "Private chats" block |
| `modelGroup` | `''` | model for group chats, `<provider>/<model>`; empty = deployment default. Same rules as `modelPrivate` |
| `dmPolicy` | `open` | DM policy: `open`(admins only)/`allowlist`/`disabled` |
| `groupPolicy` | `open` | group policy: `open`(everyone)/`allowlist`/`disabled` |
| `restrictedMemberPrefix` | `true` | Prefix non-admin group messages with `[受限用户:仅问答]` (soft restriction) |
| `adminUsers` | `[]` | admin QQ numbers; or the `ONEBOT_ALLOWED_USERS` env var. **At least one is required**, otherwise DMs (`dmPolicy=open`) and slash commands are unavailable to everyone |
| `allowFrom` / `groupAllowFrom` | `[]` | allowlisted users/groups |
| `sendErrorNotice` | `true` | Send an error notice to the user when a turn fails |
| `outboundIntervalBaseMs` | `300` | fixed gap between two consecutive outbound messages in one chat (ms) |
| `outboundIntervalPerCharMs` | `60` | extra gap per character of the message (ms/char) |
| `outboundIntervalJitterPct` | `30` | random jitter applied to the computed gap (0–100, i.e. ±that percentage) |
| `sttEnabled` | `true` | voice transcription (needs ffmpeg + whisper CLI) |
| `sttEngine` | `auto` | STT engine: `auto` (auto-detects whisper-cli/whisper/mlx_whisper)/`openai`/`whisper-cpp`/`custom` |
| `sttModel` | `small` | whisper model |
| `sttCommand` | empty | Program name/path for the `custom` engine |
| `sttArgs` | `[]` | Argument templates for the `custom` engine; `{file}` and `{out}` are substituted |
| `sttTimeoutMs` | `60000` | voice transcription timeout in ms: on timeout the `[语音]` placeholder is kept; `<=0` falls back to the built-in 60s |
| `mediaDir` | `<dsh-home>/media/onebot` | inbound media / mapping file directory |
| `tempTtlHours` | `6` | Retention for inbound temporary media files (hours), auto-cleaned on expiry |
| `inboundImageMaxPx` | `2048` | inbound image long-edge limit (px): larger images are proportionally shrunk before reaching the vision model (transparent PNGs preserved, GIFs untouched); `<=0` disables |
| `outboundImageMaxBytes` | `8388608` | outbound image segment size cap (bytes): tool sends over this are rejected with the reason returned to the model |
| `maxVoiceBytes` | `15728640` | Outbound voice size cap (bytes) |
| `maxFileBytes` | `20971520` | Outbound video/file size cap (bytes) |
| `inboundFileMaxBytes` | `20971520` | inbound QQ file size cap (bytes): oversized file segments are rejected with a notice |
| `allowPrivateHosts` | `false` | allow downloads from private/loopback addresses (skips only the private-network check; the protocol allowlist and size limits still apply); enable only in trusted setups such as a local reverse proxy |
| `agentPreset` | empty | agent preset for sessions (empty = default) |
| `workspacePath` | empty | workspace for sessions (empty = host process cwd; when unconfigured the plugin warns once at startup recommending an explicit value — the host exposes no programmable default-workspace query). The per-chat override is persisted to the mapping file and survives restarts |
| `chatIdleEvictDays` | `7` | idle-session eviction (days): when a chat has had no activity for longer than this, its in-memory agent is cleaned up before the next inbound message is processed (the session is flushed to disk first and the mapping is kept, so a later message from the same chat resumes the original session); `0` = disabled |

`dedupWindowSeconds` is a tuning key configured through the profile patch `config` override and is not exposed on the settings page; the three quote/forward expansion keys are available in the settings page's behavior group.

> **BREAKING (M0 security hardening)**: in reverse mode an empty `accessToken` refuses to start (fail-closed); the `host` default changed from `0.0.0.0` to `127.0.0.1` (loopback only) — cross-machine deployments must explicitly configure `host: 0.0.0.0`.

Env vars: `ONEBOT_ALLOWED_USERS` (comma-separated admins), `ONEBOT_ALLOW_ALL_USERS=true` (development).

### Reply-trigger lookup cost and diagnostics

With `requireMention` enabled, each valid reply without an explicit @ triggers one `get_msg` lookup after the group-policy and dedup gates, provided the bot identity is known. This includes members replying to one another. When `quoteExpandDepth` is on, accepted replies reuse the response for quote expansion; depth 0 performs no expansion lookup. There is no cross-message cache; caching can be considered if high-traffic groups reveal a bottleneck.

Reply IDs must be exactly representable decimal integers (negative IDs are supported); invalid IDs skip the query. When tracing is enabled, the `mention` stage distinguishes invalid IDs, failed lookups or empty responses, missing authors, non-bot authors and ordinary unmentioned messages. For explicit @, private messages and disabled mention gating, an invalid quote skips only its expansion, not the message itself.

## Record · Replay · Inject (W1)

| Capability | Switches (default) | Usage |
|---|---|---|
| Inbound recording | `recordInbound` (**false**) + `inboxRedact` (false) | When on, every inbound event is appended to `mediaDir/qq-inbox.jsonl` as one replayable JSON line (gate-skipped events carry the decision reason; 2MiB rename rotation); pure bypass — write failures only warn (rate-limited) |
| Offline replay | no switch needed | After `npm run build`: `npm run replay -- <inbox.jsonl> [--media-dir <dir>] [--limit <n>] [--require-mention] [--bot-qq <qq>] [--admin <qq>] [--out report.json]` — feeds the recording through the **real inbound pipeline** (forced dry-run: no websocket, all outbound writes intercepted and counted) and prints each message's traceId + decision-chain summary; does not require the host process. Replay gates come from the CLI args (fully open by default) — pass the production policy to reproduce its drop decisions |
| Event injection | `injectEnabled` (**false**) + `injectDryRun` (**true**) + `injectIntervalMs` (2000, min 500) | **DEBUG-ONLY**: append one OneBot message-event JSON line to `mediaDir/qq-inject.jsonl` (a copied `qq-inbox.jsonl` line works), the bridge polls and feeds it through the real pipeline; under dry-run every outbound write of the round (including the async agent reply) is intercepted with its original text in the trace stream (`stage=inject`) and never reaches real QQ. Lines that predate startup are skipped and reported |

## Settings page

The dsh Web GUI settings page exposes this plugin's configuration visually (a host-plane Remote
`onebotSettings` that writes the config override of the `dsh-onebot` entry in the profile-level
`cordis.patch.yml` — the same persistence layer as a hand-edited patch and the host's native settings page).

### Six groups, 39 keys

The page splits into "Private chats" and "Group chats" blocks: that chat type's admission (policy/allowlist),
model, thinking effort, and extra prompt all live in its block; global keys stay under "Connection",
"Permissions", "Behavior", and "Diagnostics". Model and thinking effort are dropdowns (the model is a two-level
provider → model dropdown; the level list is recomputed from the selected model's capabilities).

| Group | Keys |
|---|---|
| connection | `mode`, `host`, `port`, `url`, `accessToken`, `botQQ`, `workspacePath` |
| private | `modelPrivate`, `thinkingPrivate`, `extraPromptPrivate`, `dmPolicy`, `allowFrom` |
| group | `modelGroup`, `thinkingGroup`, `extraPromptGroup`, `requireMention`, `groupPolicy`, `groupAllowFrom` |
| permissions | `adminUsers`, `allowAllUsers` |
| behavior | `sendErrorNotice`, `outboundIntervalBaseMs`, `outboundIntervalPerCharMs`, `outboundIntervalJitterPct`, `recentMessages`, `quoteExpandDepth`, `forwardExpandDepth`, `forwardExpandCount`, `steerEnabled`, `steerAllMembers`, `steerAllowRestricted`, `sleepMode`, `sleepStart`, `sleepEnd` |
| diagnostics | `traceEnabled`, `recordInbound`, `inboxRedact`, `injectEnabled`, `injectDryRun` |

`accessToken` is a password-style input in the settings page; snapshots redact it on return (no plaintext echo);
the write side still lands in the patch file as plaintext.

### Priority vs. patch config

**schema defaults ← bundle/base patch (inherited layer) ← profile override line (what the settings page writes)**;
within the same layer, later patch entries win. Settings-page keys and a hand-edited patch are the same line in
the same layer — there are no two competing priorities. Keys outside the 39 (media/STT/performance/
`agentPreset` and other low-frequency keys) get no UI; hand-edit the patch in the same config line.

### How changes take effect

Every save (settings page or a hand edit of the same override line) = the plugin fiber restarts in place within
seconds; the host process and Web GUI are not restarted. Cost: one second-level QQ bridge reconnect and in-flight
turns interrupted (session mappings/history are unaffected). A save identical to the current override line is a no-op and triggers no restart; if a write makes
the plugin fail to activate, the patch file rolls back automatically and the old config keeps running.

## Session workspace selection

Each QQ session picks its working directory at creation time, in this order (written into the session meta and
frozen for the session's lifetime):

1. The chat settings' `workspacePath` override (persisted to the mapping file, survives `/new` resets)
2. The configured `workspacePath`
3. The host process cwd (`process.cwd()`)

The settings page's workspace picker fills the configured path into the form; saving applies to new sessions only.

Sessions attach to GUI workspaces as follows: a new workspace is auto-created only when the session cwd equals
the configured `workspacePath` (or the host cwd when unset); legacy sessions carrying a foreign cwd are attached
only when a workspace already owns that path, never auto-created.

## Slash commands quick reference (admin only)

| Command | Purpose |
|---|---|
| `/new` | Start a fresh session (context cleared, old session enters the switchable list) |
| `/session [number]` | List the switchable historical sessions of this chat (bare form numbered; each entry has a content preview, created and retired timestamps, truncated id; unreadable entries show "(content unreadable)" without affecting the rest). Reply with a number to switch back: the current session retires into the list, the target session is restored with its history (including per-chat settings); you can switch back and forth. The list persists across restarts (stored with the chat state in chat-sessions.json, max 20 per chat) |
| `/model [--default] <provider> <model>` | View/switch the current session's model; `--default` changes the deployment default. The bare form renders a two-level numbered list: reply with a number to pick a provider, then a number to pick the model |
| `/compact` | Forward the host's context-compaction command (`@deepseek-ai/dsh-command-compact`) to the current session |

The `/session` switchable list persists per chat in the media directory's chat-sessions.json, together with
the chat mapping and per-chat settings (one file, one atomic-write discipline; missing file = fresh,
corrupted file kept in memory; max 20 per chat, deduped, newest first). Each entry renders a content preview (the first real user input
of that session's event log: kind 'user' or QQ messages authored by this plugin first, falling back to any
user/message; all text blocks joined, the QQ inbound `<user_message>` wrapper and trusted prefixes outside the
join boundary (`[受限用户:仅问答]` / `[HH:MM nickname(QQ)]` — incomplete wrappers or empty bodies fall back
verbatim) stripped, folded to newlines and truncated to ≤40 code points, never splitting an emoji; with no user
input found it shows "(no conversation content)"), the created time (the session header's createdAt, omitted if
unavailable), the retired time, and a truncated id (first 8 + … + last 8 chars, keeping both ends recognizable).
Previews come from a cold read of the first 24 events via sessionPersistence's read handle (no write ownership,
closed right after reading); a missing/corrupted/unreadable log only degrades that entry to "(content unreadable)",
the rest and the switch-back feature are unaffected. After a successful switch the target session is un-retired;
restart-resume and post-eviction reactivation find it through the normal path. If resuming the target fails, its
id is hard-retired immediately and removed from the list, and the chat falls back to creating a new session on
the next message — it never gets stuck. Sessions retired due to corruption (collision/resume failure) never
enter the list and can never be switched back to.
Serial-number replies resolve against a snapshot of the list the command just printed and stay valid for
5 minutes (an expired snapshot asks you to list again); a purely numeric argument is read as an index only while
such a list is live, otherwise the original parameter semantics apply. Slash text outside the routed table is
not intercepted and goes to the model.

## Safe editing (code_safe_edit)

Guarded host-file editing is provided by the **standalone plugin dsh-safe-edit** (`~/dsh-plugins/dsh-safe-edit/`,
split out of this plugin on 2026-08-18, registered globally across all channels). Three tools; the approach
draws on [irmia_devkit_open](https://github.com/irmia2026/irmia_devkit_open)'s safe_edit (AGPL-3.0, an
independent clean TypeScript implementation). Tools and boundaries: see the dsh-safe-edit repo/docs:

- `code_safe_edit`: read → path allowlist → **auto backup** → match (exact → strip line-number prefix →
  whitespace-aligned / Aider-style) → replace → syntax check (`node --check` for js/cjs/mjs) →
  **auto-rollback on failure**
- `code_safe_rollback` / `code_list_backups`
- Boundaries follow the session sandbox policy: `danger-full-access` unrestricted, `workspace-write` limited to
  the session workspace, `read-only` denied; with no policy service it falls back to `safeEditRoot`
  (default `/Users/mario/workspace`)
- The model may prefer this tool (the `code-safe-edit` skill guides all channels; the QQ platform notes guide
  built-in read/edit conventions without binding to a specific tool name)

## dm / group access policies (pick on first setup)

Private (`dmPolicy`) and group (`groupPolicy`) chats each have three options:

| Option | dmPolicy (private) | groupPolicy (group) |
|---|---|---|
| `open` | **Admins only** can DM (`adminUsers`/`ONEBOT_ALLOWED_USERS`; with `allowAllUsers: true` everyone can) | **All groups** can chat (messages gated by `requireMention`: @ or reply-to-bot required; group members get the `[受限用户:仅问答]` soft limit) |
| `allowlist` | Only the **`allowFrom`** QQ numbers can DM (admin not required) | Only the **`groupAllowFrom`** groups can chat |
| `disabled` | All DMs rejected | All group chats rejected |

**Recommended setups**:
- Just for yourself → `dmPolicy: open` + configure `adminUsers` (only you can DM);
- A few friends → `dmPolicy: allowlist` + `allowFrom: ['QQ1','QQ2']`;
- Group-only bot → `groupPolicy: open` (with the default `requireMention: true`, members must @ the bot);
- Only specific groups → `groupPolicy: allowlist` + `groupAllowFrom`.

## Permissions & data

- **Network**: opens a WebSocket to the OneBot 11 gateway (reverse listen or forward dial-out); inbound
  images/files are downloaded from the QQ CDN.
- **Files**: inbound media and chat mappings are written to `<dsh-home>/media/onebot/` (`mediaDir`,
  expired files cleaned after 6 hours); session data is persisted by the dsh host.
- **System calls**: voice transcription invokes local ffmpeg and whisper CLI (disable with `sttEnabled: false`).
- **Sensitive info**: `accessToken` and the admin allowlist live in the dsh config, never in logs.
- **No telemetry**: nothing is collected; no third-party services are called besides your configured OneBot
  gateway and the image CDN.

## Platform notes injected into the model

- QQ does not render Markdown → output plain text (numbered/dashed lists, inline backticks).
- **You must call `qq_send_message` (or another `qq_send_*` tool) to speak**: the turn's assistant text is never auto-sent to QQ; send the content first when replying.
- Send images/files/voice/video with the `qq_send_*` tools; merged forwards with `qq_send_forward`.
- Incoming images/voice/video are annotated in the text as `[图片]`/`[语音]`/`[视频]` placeholders (paths never enter the text); when no vision tool is available, say so honestly.
- Group messages carry a `[HH:MM nickname(QQ)]` prefix; restricted-user messages carry a `[受限用户:仅问答]`
  prefix (answer only, no file/terminal/config operations).
- This channel is QQ and the host has no Web interaction cards: do not call `ask_user_question` / `exit_plan_mode` (confirmation cards are Web-only and would stall the conversation); ask and confirm in plain text.
- Slash commands are intercepted by the plugin (4 of them, admin only); every other slash text (including paths) goes to the model.
- Edit host files with the built-in read/edit (line-level hash anchors, dsh-better-edit auto-undo); never overwrite whole files with write (it clears the undo history).

## Uninstall

1. Remove the dsh-onebot insert entry from `~/.dsh/profiles/<profile>/cordis.patch.yml`;
2. Restart dsh; `[dsh-onebot] mounted` gone from the log means it's unloaded;
3. Optional: delete the plugin directory and leftover media under `<dsh-home>/media/onebot/`.

## Development

```sh
./scripts/build.sh                                                   # compile src/ → lib/
./node_modules/.bin/vitest run --no-file-parallelism --pool=threads   # full suite: unit + real WS peer + full pipeline
```

Lessons ported from the source DEVLOG:

- **CQ unescaping**: NapCat escapes `&` in URLs to `&amp;`; unescape before downloading (the root cause of CDN 403s).
- **Fail-closed @ detection**: when the bot's QQ is unknown, group messages are treated as un-mentioned and never
  auto-replied.
- **Fail pending actions on disconnect**: reject all in-flight actions immediately on WS close to avoid 10-30 s
  stalls and leaks.
- **Dedupe reconnects**: only one reconnect task per concurrent disconnect, preventing dual WS connections.
- **int(target) fallback**: chat_id parsing runs inside try/catch so a bad target can't crash the host.
- **Temp media 6h cleanup**: write-only-without-delete would pile up forever.

## Troubleshooting

| Symptom | Cause & fix |
|---|---|
| Group chat not responding | With `requireMention: true`, @ or reply-to-the-bot is required; make sure botQQ was learned from events or configured explicitly. Reply-only triggers also require `get_msg` to confirm the bot as the original author; explicitly @ the bot if the original message is unavailable or lookup fails |
| Image download 403 | NapCat escapes `&` in URLs to `&amp;` (parsing unescapes automatically); if it still fails, check the media download line in the log |
| File receive fails | NapCat on a different machine needs the "file-to-URL" switch on, otherwise `get_file` returns an unreachable container path; confirm dsh ↔ NapCat network connectivity |
| Crash loop / tool registration conflict | The same plugin file inserted twice (double instance); check the patch has no duplicate entries |
| Voice never gets a transcript (stays `[语音]`) | ffmpeg or whisper unavailable, or transcription timed out: install and restart, raise `sttTimeoutMs`, or set `sttEnabled: false` |
| Plugin fails to mount / peer dependency resolution failed | The deployment copy lacks the full node_modules link set: copying `lib/` alone is not enough — the runtime peer deps `@deepseek-ai/*` must be linked to the host install via `scripts/link-host.sh`; the plugin entry fails loudly with an explicit error, fix the link set per the message and restart |
| `build.sh` reports `cannot locate the dsh install` | The host has no `dsh` on PATH (e.g. the fnOS app form) and no npx store was found: set `DSH_ROOT=<host node_modules path>` and re-run `./scripts/build.sh` (the directory must contain `@deepseek-ai/`; a wrong path errors out instead of silently falling back) |
| Settings-page / patch change doesn't take effect | Troubleshoot in order: ① make sure you edited a **watched file** — the profile-level `<DSH_HOME>/profiles/web/cordis.patch.yml` or the home-level `<DSH_HOME>/cordis.patch.yml` (repo patch templates, deployment copies, and the bundle's built-in patch are not watched; sync your change into one of the above); ② the content must actually change (touching a file with identical content is a no-op); ③ check the host log for activation failures — an insert-added entry that fails to activate (e.g. a missing peer) errors out explicitly and stays inactive until a restart retries it; ④ the settings page's persistence layer is the profile-level `dsh-onebot` override line — editing anywhere else (e.g. settings.yaml, which the host has deprecated and renames away) has no effect |
| Where are the logs | dsh host logs; historical root causes & fixes in [DEVLOG.md](DEVLOG.md) |

## Development record

Full timeline / root causes / fixes: [DEVLOG.md](DEVLOG.md) (ported from the Hermes onebot plugin's DEVLOG convention).

## License

BSD-3-Clause
