# SurfCode

**Ride the code.**

<p align="center">
  <img src="assets/surfcode-logo.gif" alt="Animated blue SurfCode wordmark" width="480">
</p>

SurfCode is a provider-agnostic AI coding agent for the terminal. It pairs a full-screen, keyboard-driven TUI with a complete model catalog, streaming tool use, sessions, permissions, and a clean headless mode for scripts and CI.

```text
  ▀▀▀▓▄▄        ▄▄▄ ▄▄      ▀▀▀▓▄▄       ▀▀▀▓▄▄       ▀▀▀▓▄▄       ▀▀▀▓▄▄         ▀▀▀▓▄▄         ▀▀▀▓▄▄
 ▄██▄░▀██▓▄   ▄███  ▐██▄   ▄██▄░▀██▓▄   ▄██▄░▀██▓▄   ▄██▄░▀██▓▄      ░░▀██▓▄     ▄██▄░▀██▓▄     ▄██▄░▀██▓▄
▀ ▀░░░░░▀██▓ ▐███▌   ███▌▒▀ ▀░░░░░███▓▒▀ ▀░░░░░███▓▒▀ ▀░░░░░███▓  ▄▄█▀ ░▒███▓▄ ▒▀ ▀░░░░░███▓▄ ▒▀ ▀░░░░░███▓
 ░░▐▒▒▄▄▄    █░░▌    ░░░█  ░░▐▒▒▄░ ░░▌  ░░▐▒▒ ░ ▀▀   ░░▐▒▒ ░ ▀░▌ █░░     ░░░░░▌  ░░▐▒▒ ░░░░░░▌  ░░▐▒▒ ░ ▀▀
  ░  ▀▀░░▒▒  ▒▒█   ░▐▒▒▒▒   ░▐▓▓▐▒▌▒▀    ░▐▓▓ ▄▓▀     ░▐▓▓      ▐▒▒▌     ░▐▒▒▒▒   ░▐▓▓  ░▐▒▒▒▒   ░▐▓▓ ▄▓▀
  ▄▓    ▀▓▓█ ▐▓▓▄ ░▒▓▓▓▓▌    █▓▀  ▀▓▓▄    ▀▓█       ▄  ▀▓▀  ▄█▓▄ ▓▓▓▄   ░▒▓▓▓▓▌ ▄  ▀▓▀   ▓▓▓▓▌ ▄  ▀▓▀  ▄▄▄
 ▀▓█▓▄▄ ▓███  ▀███▄▓███▀   ▀███▄  ▓███    ▐█         ▀█▄▀█▄▄▓▓▒▀  ▀███▄▄▄▓███▀   ▀█▄▄▄▄▄▓███▀   ▀█▄▄▄▄▄▓███
   ▀▀  ▀▀▀▀      ▀▀▀▀▀       ▀▀  ▀▀▀▀      ▀▌            ▀▀▀▀▀       ▀▀▀▀▀▀▀        ▀▀▀▀▀▀▀        ▀▀▀▀▀▀▀
```

- **230+ providers, 9,000+ models** from the [models.dev](https://models.dev) catalog, with cached refresh and a bundled offline snapshot. Providers with a permanent no-cost API tier are marked `[FREE API]`. The model picker only lists models from APIs you have connected.
- **Real tool use** — read, write, edit, search, shell, fetch, todos — with inline diffs and a permission model that ranges from read-only to full computer access.
- **Fast by default** — every dialect streams over SSE for reliable tool use, but visual token painting is off unless you ask for it. Replies land complete, the TUI repaints only what changed, and `/stream on` restores live typing when you want it.
- **Reasoning effort on tap** — `/effort low|medium|high|auto` or `--effort`, mapped to native reasoning controls on OpenAI, Anthropic, Google, and OpenRouter. Gemini 3 uses `thinkingLevel`; Gemini 2.5 uses thinking budgets. Low effort on Flash-Lite really means minimal thinking. `auto` keeps the provider default.
- **Multi-model orchestration** — `/agent add provider/model` keeps the current model as the head and runs up to eight worker models in parallel through a read-only `delegate` tool. Workers never touch your files; the head verifies and synthesizes.
- **Side questions without the baggage** — `/btw <question>` answers with the current conversation as context, has no tools, and leaves no trace in the session or usage totals.
- **Accurate usage and cost** — provider-reported input, output, reasoning, cache-read, and cache-write tokens, including DeepSeek and Google cache semantics.
- **Beautiful full-screen TUI** built for long sessions: alternate screen, smooth scrolling, markdown, syntax highlighting, six themes including a pure-black `dark` palette, an always-visible resizable file dock, a single-pane options overlay, a simplified prompt, Unicode icons, a command palette, and a tiny rainbow equalizer that loops in the status bar.
- **GitHub publishing when you ask** — log in with a personal access token, then let the agent create a private or public repository, upload the whole project or selected files, and commit or push later. Nothing is published until you explicitly ask.
- **Headless when you need it** — clean stdout for pipes, NDJSON events for automation, explicit approvals, and deterministic exit codes.
- **Local-first storage** — keys, sessions, and config stay on your machine. No telemetry.
- **Optional BYOK-friendly session sync** — run the tiny self-hosted sync server or point SurfCode at your own HTTPS endpoint. Only session records are uploaded; provider API keys never leave the machine.

---

## Requirements

- Node.js **22 or newer**
- A modern terminal (xterm, iTerm2, Ghostty, Kitty, WezTerm, Windows Terminal, …)
- An API key for at least one provider, or a local OpenAI-compatible server

## Install

```bash
npm install -g surfcode
surf --version
```

The package installs two equivalent commands: **`surf`** and **`surfcode`**.

From source:

```bash
git clone https://github.com/surfcode/surfcode.git
cd surfcode
npm install
npm run build
npm link
```

## Quick start

```bash
surf
```

The first launch opens the interactive UI. Press `/` for commands, or connect a provider:

```text
/connect            pick a provider and paste a key with ctrl+v
/model              browse models from your connected providers
/help               commands, shortcuts, and tips
```

Prefer the shell? Authenticate directly:

```bash
surf auth anthropic          # hidden key prompt, saved to auth.json
surf models --provider openai
surf run "explain src/core/agent.ts"
```

If a provider key already lives in your environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …), SurfCode picks it up automatically. The next start auto-selects a sensible provider and recommended model.

---

## The TUI

SurfCode renders in the terminal's alternate screen, the same way vim and htop do. Your shell scrollback is restored when you exit.

The welcome wordmark uses a native ANSI reveal and shimmer, so it animates instantly with no video runtime. The animated README banner is a blue motion lockup generated deterministically with SVG + ImageMagick: `npm run logo:render`. An optional Manim path is available for higher-resolution renders with the same layout and motion. A tiny rainbow equalizer sits in the bottom-right corner of the status bar in every chat and keeps looping while idle, even in the `mono` theme.

### Commands

| Command | What it does |
| --- | --- |
| `/model [query]` | Switch to a model from a connected provider |
| `/connect` | Connect a provider and save its API key |
| `/provider` | Browse every provider |
| `/theme [name]` | Change the theme (`aurora`, `dark`, `ember`, `forest`, `violet`, `mono`) |
| `/explorer [width]` | Focus the file dock (also `ctrl+o`); optionally set its width |
| `/options` | Open settings and toggles (alias: `/settings`) |
| `/effort [level]` | Set reasoning effort (`low`, `medium`, `high`, `auto`) |
| `/stream [on\|off]` | Toggle live token painting (off by default) |
| `/access [full\|safe]` | Toggle full computer access |
| `/agent [status\|on\|off\|add\|remove\|clear\|head]` | Run worker models in parallel under the head model |
| `/thinking` | Show or hide reasoning text |
| `/verbose` | Expand or collapse tool output |
| `/plan` / `/build` | Toggle read-only plan mode |
| `/clear` | Clear the visible conversation |
| `/new` | Start a fresh session |
| `/sessions` | Resume a previous session |
| `/sync [push\|pull]` | Sync sessions with your self-hosted endpoint |
| `/stop` | Stop the AI reply in flight |
| `/compact` | Summarize history to free context |
| `/btw <question>` | Ask a side question without saving it |
| `/github [status\|login\|logout]` | Connect GitHub and publish code when asked |
| `/context` | Show context-window usage |
| `/cost` | Show session tokens and cost |
| `/export [path]` | Export the conversation as Markdown |
| `/init` | Ask the agent to create a `SURFCODE.md` project guide |
| `/help` | Commands and keyboard shortcuts |
| `/quit` | Save and exit |

`/effort` stores the level in your config so it survives restarts. `auto` leaves the provider's own behavior untouched. Effort maps to `reasoning_effort` on OpenAI-compatible endpoints that support it, OpenRouter's `reasoning.effort`, Anthropic extended-thinking budgets, and Google's native controls: Gemini 3 and newer use `thinkingLevel` (`minimal` for Flash-Lite on low), while Gemini 2.5 uses `thinkingBudget` and can disable thinking entirely on Flash and Flash-Lite. Other providers also get matching instructions in the system prompt. Thought summaries are only requested when reasoning is visible (`/thinking`).

`/btw` opens an ephemeral panel. It sends the committed conversation as context, runs with no tools, and never adds the question or answer to the session, timeline, or usage. It is safe to use while the main agent is working, and closing the panel cancels an in-flight side answer.

### Live rendering

SSE transport is always on so tool calls, usage, and retries stay reliable. **Visual** streaming is a separate setting and is off by default: the reply appears as one finished block instead of repainting every token. Turn it on with `/stream on` (or `"streaming": true`), and off again with `/stream off`. While a turn is active the TUI uses a slow animation tick; `/stream on` raises the repaint rate only for the live message.

Provider errors fail fast. Quota and rate-limit (`429`) responses are not retried behind your back, and long provider paragraphs are shortened to one line in the timeline, so a missing quota is visible immediately instead of after a minute of silence.

### File explorer

The VS Code-like two-pane file dock is always visible in the chat view on terminals at least 57 columns wide. The tree loads lazily — only folders you expand are read — and skips build/vendor directories such as `.git`, `node_modules`, `dist`, and framework caches. The lower pane previews the highlighted file automatically with line numbers, detects binary files, and caps very large files.

Resize the dock with `ctrl+←` / `ctrl+→` from anywhere, or `[` / `]` while the dock has focus. The width is saved as `explorerWidth` in config. `ctrl+o` or `/explorer` moves keyboard focus into the dock; `esc` returns to the prompt. `/explorer 40` sets an explicit width.

| Key | Action |
| --- | --- |
| `ctrl+o` | Focus or leave the file dock |
| `↑` / `↓` | Move through entries |
| `→` or `enter` | Open or collapse a folder |
| `←` | Collapse the folder, or jump to its parent |
| `enter` on a file | Attach `@path` to the prompt |
| `a` | Attach `@path` to the prompt |
| `r` | Refresh the tree |
| `[` / `]` | Resize the dock while focused |
| `esc` | Return to the prompt |

### Options

`/options` (or `/settings`) opens one settings list: theme, model, provider, mode, reasoning effort, live streaming, explorer width, thinking text, tool output, full computer access, agent mode, and GitHub. Use `↑`/`↓` to move, `←`/`→` or `enter` to change a value, and `g` to connect GitHub. Changes save immediately and the overlay stays open; model, provider, and theme rows open their pickers.

The `dark` theme fills the entire frame with true black (`#000000`) and keeps each element on its own vivid accent: blue for chrome, teal for your prompt, violet for SurfCode, pink for code, green for success, amber for warnings, and rose for errors.

### Full computer access

`/access full` is an explicit opt-in for unattended or local-machine work. It:

- changes every permission action to `allow`
- allows file tools to read and write outside the workspace
- keeps plan mode read-only

`/access safe` restores your normal permission policy. The status bar shows a red `full access` badge while it is active. The same setting is available as `"fullAccess": true` and applies to headless runs. In headless mode, `--yes` on its own only upgrades `ask` actions and still honors explicit `deny` rules; full access is a separate, stronger opt-in.

### Multi-model agent mode

The current model is the **head**. Add one or more workers with a `provider/model` reference:

```text
/agent add google/gemini-3.5-flash-lite
/agent add anthropic/claude-haiku-4-5
/agent status
```

Adding the first worker turns agent mode on. The head receives a read-only `delegate` tool and can send up to eight independent tasks at once; all selected workers start in parallel, and their answers and usage return to the head for synthesis. Workers have no tools and cannot edit files, so all real tool work stays with the head. Use `/agent remove <n|provider/model>`, `/agent clear`, or `/agent off` to change the lineup, and `/agent head provider/model` (or `/model`) to choose the head. Workers are stored in `agents.workers` in config. If a worker's key is missing, it is skipped with a warning instead of blocking the turn.

### GitHub publishing

Connect once, then ask the agent in plain language. In the TUI:

```text
/github login
/github status
/github logout
```

`/github login` opens a masked prompt; paste with `ctrl+v` and press enter. The token is validated against GitHub before it is saved under the `github` key in `auth.json`. `GITHUB_TOKEN` or `GH_TOKEN` also work without saving anything. `surf auth github` provides the same flow from the shell, with `--key`, `--env`, `--remove`, and `--json` options.

Create a token at [github.com/settings/tokens](https://github.com/settings/tokens). A classic token needs the `repo` scope. For a fine-grained token, grant **Contents** read/write and **Administration** read/write so the agent can create repositories and push code; organization repositories also need the organization's approval. A Copilot-only token may not have publishing scopes.

The agent has four publishing tools:

| Tool | Action |
| --- | --- |
| `github_status` | Check the token source, branch, origin, dirty state, and commit count |
| `github_create_repo` | Create a private or public repository and point `origin` at it (an existing origin is left alone unless you ask to replace it) |
| `github_upload` | Stage, commit, and push the whole workspace or selected paths |
| `github_commit` | Commit and push later changes |

`github_create_repo` requires an explicit `private: true` or `private: false`; if you did not say which, the agent asks first. `github_upload` with no file list stages every workspace change except common build/vendor directories (`node_modules`, `dist`, `build`, caches, virtualenvs, and similar); pass files or directories for a selective upload. These are publish actions, so the agent uses them only when you explicitly ask. They never force-push, rewrite history, or delete a repository.

The token is never included in the model's tool output, config, sessions, remote URLs, or command-line arguments. Git authenticates through a temporary `GIT_ASKPASS` helper, and errors are redacted before they reach the transcript.

### Keys

| Key | Action |
| --- | --- |
| `enter` | Send prompt |
| `ctrl+j` | Insert newline |
| `esc` | Stop generating / leave explorer / close overlay |
| `/stop` | Stop the current reply and keep the partial text |
| `ctrl+c` | Interrupt; press twice to exit |
| `pgup` / `pgdn` | Scroll the transcript |
| `ctrl+u` / `ctrl+d` | Half-page scroll |
| `tab` | Complete a command or file |
| `up` / `down` | Input history |
| `shift+tab` | Toggle plan/build mode |
| `ctrl+t` | Cycle themes |
| `ctrl+o` | Focus or leave the file explorer dock |
| `ctrl+←` / `ctrl+→` | Resize the file explorer dock |
| `[` / `]` | Resize the dock while it is focused |
| `ctrl+v` | Paste from the system clipboard |
| `?` | Help when the input is empty |

### Input tricks

- `@path/to/file` attaches a file to the prompt with completion.
- `!command` runs a shell command and adds the output to the session.
- `ctrl+v` pastes clipboard text, code blocks, or API keys. It works in the main prompt, the API-key overlay, and the GitHub token prompt, so `/connect` and `/github login` never require exposing a secret in shell history.
- Paste multiline text directly; `ctrl+j` inserts a newline.
- `SURFCODE.md`, `AGENTS.md`, `CLAUDE.md`, and `.surfcode/instructions.md` in the workspace become project instructions automatically.

### Plan mode

Plan mode is read-only. The agent can inspect files, search, and fetch, but write/shell tools are blocked. Use it to scope a change before switching to build mode with `shift+tab` or `/build`.

### Permissions

Each tool action is classified as `read`, `write`, `shell`, or `fetch`:

- `read`/`fetch` default to **allow**
- `write`/`shell` default to **ask**
- Choose **yes**, **always** (allow for the rest of the run), or **no** when prompted. In the TUI, **always** also saves the action to config.
- Deny an action entirely in config with `"permissions": { "shell": "deny" }`

Plan mode is a second layer of protection on top of permissions. `/access full` bypasses all approval prompts and allows paths outside the workspace; plan mode still blocks mutations while it is active. Use `/access safe` to restore the policy above.

---

## Providers

SurfCode ships with a compact snapshot of models.dev. `surf update-models` (or `surf models --refresh`) downloads the latest catalog and caches it locally; the bundled snapshot remains the offline fallback. `surf doctor` warns when the cache is more than 24 hours old.

### Built-in provider support

The catalog covers OpenAI, Anthropic, Google, Azure OpenAI, Google Vertex, Amazon Bedrock gateways, OpenRouter, DeepSeek, xAI, Mistral, Groq, Cerebras, Together, Fireworks, DeepInfra, Vercel AI Gateway, GitHub Copilot, Moonshot, Zhipu, Alibaba, MiniMax, Cohere, Perplexity, Ollama Cloud, and many more.

HTTP dialects are selected automatically:

| Dialect | Used by |
| --- | --- |
| `openai` | OpenAI-compatible APIs (most providers) |
| `anthropic` | Anthropic and Anthropic-compatible gateways |
| `google` | Google Generative Language API |
| `azure` | Azure OpenAI deployments |
| `google-vertex` | Vertex AI Gemini / Anthropic |

`surf providers` shows what is connected. `surf providers --all` shows the full catalog.

Providers with a permanent, rate-limited no-cost API tier are marked `[FREE API]` in `surf providers`, `surf auth`, and the interactive provider picker: Google, Groq, Mistral, OpenRouter, and Cloudflare Workers AI. The badge means the provider offers free inference, not that every model is free; model availability and limits change. Trial credits and local runtimes do not get the badge.

### Local servers

Ollama, llama.cpp, vLLM, and LM Studio are supported out of the box and discovered automatically when running:

```bash
ollama serve
surf
```

Local providers are keyless by default. `surf providers --connected` shows servers that responded.

### API keys

```bash
surf auth                              # status for configured + popular providers
surf auth anthropic                    # hidden prompt
surf auth openai --key sk-...          # non-interactive (mind your shell history)
surf auth google --env                 # show supported environment variables
surf auth openrouter --remove          # delete the saved key
surf auth github                       # hidden prompt for a publisher token
surf auth github --env                 # show GITHUB_TOKEN / GH_TOKEN status
surf auth github --remove              # forget the saved GitHub token
```

Keys are stored in `auth.json` with mode `600`. They are never written into sessions or printed in full. Environment variables are read first-class and are never copied to disk. `surf config` redacts API keys and headers. In the TUI, press `ctrl+v` while the key prompt is open to paste from the system clipboard; the key stays masked and never enters shell history.

GitHub publishing uses a separate `github` entry in `auth.json`, with `GITHUB_TOKEN` and `GH_TOKEN` as fallbacks. It is never used as a model provider key. See [GitHub publishing](#github-publishing) for scopes and the approval flow.

### Session sync (BYOK)

Session sync is optional, self-hostable, and deliberately **session-only**. The payload contains `SessionRecord` objects (messages, model choice, cwd, usage). Provider API keys, `auth.json`, provider settings, and environment variables are never uploaded.

Run the built-in tiny sync server, or point SurfCode at an HTTPS endpoint that implements the same protocol:

```bash
# Option A: self-hosted store on this machine
surf sync serve --port 8787
# prints a generated token; pass --token to use your own

# Configure the client
surf sync setup --url http://127.0.0.1:8787 --token <token> --auto
surf sync status
surf sync                # push and pull
surf sync push
surf sync pull
surf sync disable
```

The server stores sessions under `~/.local/share/surfcode/sync-server` by default; pass `--data-dir` to change it. It speaks plain HTTP, so keep it on localhost or put it behind a TLS reverse proxy before exposing it. Remote endpoints must use HTTPS; HTTP is accepted only for localhost. The sync bearer token is stored in config and redacted by `surf config`.

Conflicts use last-write-wins by each session's `updatedAt`, with a monotonic server cursor for pulls. `--auto` pushes and pulls after each completed turn; without it, use `/sync` in the TUI or `surf sync`.

The HTTP contract is intentionally small and easy to reimplement:

```http
POST /v1/sync
Authorization: Bearer <token>
Content-Type: application/json

{ "since": 12, "pull": true, "sessions": [/* SessionRecord[] */] }
```

The response is `{ "accepted": 1, "cursor": 13, "sessions": [/* changed SessionRecord[] */] }`. `GET /v1/health` reports `{ "ok": true }`.

Set both `SURFCODE_SYNC_URL` and `SURFCODE_SYNC_TOKEN` to inject the endpoint and token and opt in automatically, without writing either value to config. Cursor updates only write `sync.cursor` and `sync.lastSyncAt`.

### Custom OpenAI-compatible endpoints

Any gateway that speaks the OpenAI chat-completions API can be added as a custom provider:

```jsonc
{
  "customProviders": {
    "my-gateway": {
      "name": "My Gateway",
      "baseURL": "https://gateway.example.com/v1",
      "dialect": "openai",
      "env": ["MY_GATEWAY_API_KEY"],
      "models": [
        {
          "id": "my-coder",
          "name": "My Coder",
          "context": 128000,
          "output": 16384,
          "tool_call": true,
          "reasoning": true
        }
      ]
    }
  }
}
```

Then:

```bash
surf auth my-gateway --key ...
surf models --provider my-gateway
surf -p my-gateway -m my-coder
```

Useful provider settings:

| Setting | Purpose |
| --- | --- |
| `baseURL` | API base URL (required for custom providers) |
| `dialect` | `openai`, `anthropic`, `google`, `azure`, `google-vertex` |
| `apiKey` | Key in config (prefer `surf auth` or env vars) |
| `headers` | Extra HTTP headers |
| `extraBody` | Extra JSON merged into each request body |
| `timeout` | Request timeout in milliseconds |
| `retries` | Extra attempts after the first request (default `2`) |
| `retryDelay` | Base exponential backoff in milliseconds (default `600`) |
| `keyless` | No API key required |
| `deployment` | Azure deployment name |
| `project` / `location` | Vertex AI project and region |
| `apiVersion` | Azure API version |

You can also override a built-in provider's endpoint under `providers.<id>` without defining a new provider.

---

## Headless mode

`surf run` streams the answer to **stdout** and tool progress to **stderr**, so pipes stay clean.

```bash
surf run "summarize this repository"
surf run -m openai/gpt-5 "refactor the parser"
cat error.log | surf run "explain this failure"
surf run --yes "run the tests and fix failures"
surf run --plan "map the auth flow before changing it"
surf run --json --yes "run tests and fix failures"
```

- Pass a prompt, use `-` to force stdin, or pipe text with no prompt.
- `--yes` auto-approves actions that would otherwise ask. Explicit `deny` rules still apply.
- `"fullAccess": true` (or `/access full` in the TUI) allows every action, including paths outside the workspace, and is honored by headless runs. Use it deliberately.
- If `agents.enabled` is true with workers configured, headless runs resolve the same workers and give the head model the parallel `delegate` tool.
- Without a TTY, permission prompts are denied rather than guessed. Use `--yes` for unattended runs.
- `--no-save` avoids writing a session; otherwise the run is saved and can be resumed.
- `--quiet` suppresses tool progress and the final summary.
- `--reasoning` streams reasoning to stderr (or as JSON events).
- `--effort low|medium|high|auto` overrides the saved effort for one run; `auto` keeps the provider default.
- When sync is enabled with `auto`, completed headless runs push their saved session. Disable auto-sync if CI should have no network side effects.

### Sessions

```bash
surf run --continue "keep going"        # most recent session in this directory
surf run --session ses_abc123 "next"    # a specific session id or prefix
```

### JSON events

`--json` emits one JSON object per line (NDJSON). Text deltas are streamed, and the final `result` event contains the complete answer and usage.

| Event | Fields |
| --- | --- |
| `session` | `sessionId`, `provider`, `model`, `resumed` |
| `notice` | `message` |
| `text` | `delta` |
| `reasoning` | `delta` (only with `--reasoning`) |
| `tool_start` | `id`, `name`, `arguments` |
| `tool_result` | `id`, `name`, `durationMs`, `isError`, `output` |
| `usage` | cumulative `usage` |
| `result` | `text`, `usage`, `aborted`, `sessionId`, `durationMs` |
| `error` | `message`, optional `hint` |

Example:

```bash
surf run --json --yes "list the files" | jq -c 'select(.type == "result")'
```

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Error (bad config, provider failure, no prompt, …) |
| `130` | Interrupted (ctrl+c / aborted run) |

---

## CLI reference

```text
surf [prompt...]                 open the TUI, optionally with a prompt
surf run [prompt...]             one-shot headless run
surf auth [provider|github]      connect or inspect providers and GitHub
surf models [query...]           browse the model catalog
surf providers [query...]        list provider status
surf config                      inspect or edit configuration
surf sessions                    list, show, resume, or delete sessions
surf sync [action]               sync sessions or run the self-hosted store
surf doctor                      diagnose the installation
surf update-models               refresh the models.dev catalog
```

Global flags:

```text
--cwd <dir>        working directory for tools and sessions
--home <dir>       override config/data location (also SURFCODE_HOME)
--no-color         disable ANSI color
-p, --provider     provider id
-m, --model        model id or provider/model
--plan             read-only plan mode
--effort <level>   reasoning effort: auto | low | medium | high
--theme <name>     aurora | dark | ember | forest | violet | mono
-c, --continue     resume the latest session in this directory
-s, --session      resume a saved session
-P, --print        force headless output
-y, --yes          auto-approve tool actions
--json             NDJSON events (headless)
--quiet            suppress progress (headless)
--no-save          do not persist a headless session
```

### `surf models`

```bash
surf models                        # top recommended chat models
surf models claude                 # search names, ids, providers
surf models --provider anthropic
surf models --all --limit 100      # include embeddings, audio, image models
surf models --refresh              # pull models.dev first
surf models --json
```

### `surf providers`

```bash
surf providers                     # connected + popular defaults
surf providers --all               # every provider
surf providers --connected         # only ready providers
surf providers ollama              # search
surf providers --json              # includes freeApi on every provider
```

`--json` exposes `freeApi: true` for providers with a permanent no-cost tier.

### `surf config`

```bash
surf config                        # effective config, secrets redacted
surf config path                   # config file path
surf config get theme
surf config get permissions.shell
surf config set theme ember
surf config set permissions.shell allow
surf config set providers.anthropic.baseURL https://proxy.example.com
surf config edit                   # $VISUAL / $EDITOR
surf config validate
```

Values are parsed as JSON when possible, so `true`, `0.7`, `["a"]`, and `{...}` work. Comments in the JSONC file are preserved.

### `surf sessions`

```bash
surf sessions                      # current workspace
surf sessions --all
surf sessions show ses_abc123      # transcript
surf sessions show ses_abc123 --full
surf sessions resume ses_abc123    # open the TUI in that session
surf sessions rm ses_abc123        # confirms first
surf sessions rm ses_abc123 --yes
```

### `surf sync`

```bash
surf sync setup --url https://sync.example.com --token <token> --auto
surf sync                         # push and pull
surf sync push
surf sync pull
surf sync status
surf sync enable
surf sync disable
surf sync serve --port 8787       # self-hosted store
surf sync serve --host 0.0.0.0 --data-dir /srv/surfcode  # behind a TLS reverse proxy
```

`setup` enables sync; `--auto` additionally syncs after every completed turn. Use an HTTPS URL for remote hosts. The built-in server binds to `127.0.0.1` by default and should only be exposed remotely through a TLS reverse proxy.

### `surf doctor`

```bash
surf doctor
surf doctor --network
surf doctor --json
```

Checks Node version, config parsing, directory permissions, credential-file mode, catalog freshness, selected model resolution, workspace writability, and optionally models.dev connectivity.

### `surf update-models`

```bash
surf update-models
surf update-models --url https://internal.example.com/models.json
```

---

## Configuration

Config lives at the platform config directory (use `surf config path`):

| Platform | Default location |
| --- | --- |
| Linux | `~/.config/surfcode/config.json` |
| macOS | `~/Library/Preferences/surfcode/config.json` |
| Windows | `%APPDATA%\surfcode\Config\config.json` |

Run `surf config path` for the exact path on your machine. Sessions live separately in the platform data directory (Linux `~/.local/share/surfcode/sessions`, macOS `~/Library/Application Support/surfcode/sessions`, Windows `%LOCALAPPDATA%\surfcode\Data\sessions`); set `SURFCODE_HOME` to relocate both config and data.

```jsonc
{
  "version": 1,

  "provider": "anthropic",
  "model": "claude-sonnet-4-5",
  "theme": "aurora",
  "mode": "build",

  "permissions": {
    "read": "allow",
    "write": "ask",
    "shell": "ask",
    "fetch": "allow"
  },

  "maxSteps": 40,
  "maxTokens": 8192,
  "temperature": 0.2,
  "effort": "auto",
  "showReasoning": false,
  "verboseTools": false,
  "streaming": false,
  "explorerWidth": 34,
  "fullAccess": false,
  "agents": {
    "enabled": false,
    "workers": []
  },
  "allowOutsideWorkspace": false,

  "sync": {
    "enabled": false,
    "auto": false,
    "url": "https://sync.example.com",
    "token": "<sync bearer token>",
    "cursor": 0
  },

  "providers": {
    "openai": {
      "baseURL": "https://api.openai.com/v1"
    }
  },

  "customProviders": {
    "my-gateway": {
      "name": "My Gateway",
      "baseURL": "https://gateway.example.com/v1",
      "dialect": "openai",
      "env": ["MY_GATEWAY_API_KEY"],
      "models": [
        { "id": "my-coder", "name": "My Coder", "context": 128000, "output": 16384 }
      ]
    }
  }
}
```

`streaming` only controls visual token painting in the TUI; provider traffic always streams. `explorerWidth` is the preferred dock width in columns (clamped so the chat keeps room); resize it live with `ctrl+←/→` or `[`/`]`. `fullAccess` bypasses approvals and the workspace boundary, while `allowOutsideWorkspace` allows outside paths but still asks for `write`/`shell` according to `permissions`. `agents.workers` is a list of `{ "provider": "...", "model": "..." }` objects used by `/agent` and headless runs.

Environment overrides:

| Variable | Effect |
| --- | --- |
| `SURFCODE_PROVIDER` | Override provider |
| `SURFCODE_MODEL` | Override model |
| `SURFCODE_THEME` | Override theme |
| `SURFCODE_HOME` | Config + data directory |
| `SURFCODE_SYNC_URL` | Session sync endpoint |
| `SURFCODE_SYNC_TOKEN` | Session sync bearer token |
| `SURFCODE_MODELS_URL` | Alternate models.dev-compatible catalog URL |
| `SURFCODE_DEBUG` | Print stack traces on unexpected errors |

### Provider credentials in the environment

SurfCode uses each provider's documented environment variables from models.dev, including:

```text
ANTHROPIC_API_KEY      OPENAI_API_KEY        GOOGLE_API_KEY
OPENROUTER_API_KEY     DEEPSEEK_API_KEY      XAI_API_KEY
MISTRAL_API_KEY        GROQ_API_KEY          CEREBRAS_API_KEY
TOGETHER_API_KEY       FIREWORKS_API_KEY     DEEPINFRA_API_KEY
AZURE_API_KEY          GITHUB_TOKEN          OLLAMA_API_KEY
```

Run `surf auth <provider> --env` to see the exact variables for any provider.

---

## Tools

| Tool | Action | Notes |
| --- | --- | --- |
| `read` | read | Numbered lines, binary detection, output limits |
| `write` | write | Creates directories, full-file writes |
| `edit` | write | Exact string replacement with diff output |
| `ls` | read | Directory listing |
| `glob` | read | Fast file matching |
| `grep` | read | Content search with context |
| `bash` | shell | Non-interactive shell, timeouts, output caps |
| `webfetch` | fetch | Fetch URLs and convert HTML to text |
| `github_status` | read | Token source, branch, origin remote, and dirty state |
| `github_create_repo` | shell | Create a private or public repository; asks first |
| `github_upload` | shell | Commit and push the workspace or selected files |
| `github_commit` | shell | Commit and push later changes |
| `todo_write` | read | Maintain the visible task list |

Shell commands run in the workspace in a non-interactive environment and are killed on timeout or abort. Output is truncated deterministically so it cannot blow up the context window.

---

## Development

```bash
npm install
npm run dev            # tsx src/cli.tsx
npm run typecheck
npm test
npm run build          # dist/cli.js + bundled catalog
npm run models:update  # regenerate src/data/models.json
npm run logo:render    # deterministic SVG GIF for the README (~50KB)
npm run logo:render -- manim  # optional: render the Manim scene instead
```

Project layout:

```text
src/
  cli.tsx              command-line entry and command wiring
  cli/                 auth, config, sessions, inspect, headless, interactive
  core/                catalog, providers, chat dialects, agent loop, sessions, sync client
  sync/                self-hosted session sync server
  tools/               tool implementations
  tui/                 full-screen Ink UI, rendering, themes, overlays, icons
  data/models.json     compact models.dev snapshot
test/                  unit + CLI integration tests with a mock SSE server
manim/                 optional Manim version of the README wordmark
scripts/               catalog updates, logo rendering, asset copying
assets/                rendered README animation
```

The test suite starts local mock SSE servers and exercises all streaming dialects, retries, fail-fast `429` handling, stream cancellation, usage variants, the full headless path, tool calls, session persistence, JSON events, session sync auth/push/pull conflict handling, the simplified prompt, the resizable file dock, parallel worker delegation, GitHub token handling and local commit/push, and inspection commands. No live provider keys are required.

The TUI is designed for a monospace font with box-drawing and Unicode icon coverage. [JetBrains Mono](https://www.jetbrains.com/lp/mono/) is a good default; on Konsole, choose it in **Settings → Edit Current Profile → Appearance**.

### Adding a tool

1. Implement a `ToolDefinition` in `src/tools/`.
2. Export it in `createTools()`.
3. Set `readOnly` and the permission `action`.
4. Add a renderer branch in `src/tui/render.ts` if the output needs a custom card.

### Adding a dialect

1. Add the dialect to `Dialect` in `src/core/types.ts`.
2. Implement the streaming adapter in `src/core/chat/`.
3. Dispatch it from `src/core/chat/index.ts`.
4. Map it in `inferDialect()`.

---

## Security

- API keys live in `auth.json` (mode `600`) or the environment. SurfCode never writes API keys into sessions.
- Config directories and session files are created with private permissions where the platform supports it.
- `surf config` and `surf config get` redact API keys, authorization headers, tokens, and passwords.
- Destructive shell commands are marked high-risk in approval prompts.
- Plan mode blocks all mutating tools.
- `allowOutsideWorkspace` is off by default; file tools stay inside the workspace unless enabled.
- Full computer access (`fullAccess` / `/access full`) is off by default. When enabled, it allows every tool action and paths outside the workspace, so only use it on machines and repositories you trust. Plan mode remains read-only.
- `/agent` workers receive conversation context but no tools. Their requests use the same saved credentials and are never shown with keys in the transcript.
- GitHub publishing uses a personal access token stored under `github` in `auth.json` (mode `600`) or `GITHUB_TOKEN`/`GH_TOKEN`. It is never written to config or sessions, never printed in full, and never added to a remote URL or command-line argument. Pushes use a temporary `GIT_ASKPASS` helper, and git errors are redacted.
- Repository creation, uploads, commits, and pushes are approval-gated tools. SurfCode uses them only when you explicitly ask, never force-pushes or rewrites history, and has no repository-deletion tool.
- Permission prompts are never auto-approved in headless mode. Without a TTY, an `ask` action is denied; use `--yes` deliberately.
- Session sync is opt-in. If enabled, only `SessionRecord` data is uploaded to your endpoint; provider keys, auth files, provider settings, and environment variables are excluded. Remote sync endpoints must use HTTPS.
- `surf config` redacts the sync bearer token just like provider keys.
- No telemetry, no background uploads. Network access is limited to the provider you choose, URLs fetched by the `webfetch` tool, models.dev when you refresh the catalog, and your configured sync endpoint when sync is enabled.

---

## Troubleshooting

**`No API key for …`**  
Run `surf auth <provider>`, export the provider's environment variable, or add a `baseURL`/`keyless` custom provider.

**`interactive UI needs a terminal`**  
Use `surf run "…"` in scripts, CI, or when piping output.

**A provider is connected but not listed as ready**  
Its endpoint may be missing. Azure needs `AZURE_RESOURCE_NAME`, Vertex needs `GOOGLE_VERTEX_PROJECT`, and proprietary providers may need a custom gateway URL.

**Local model server not detected**  
Start the server first, then run `surf providers --connected`. If it uses a non-standard port, set `providers.ollama.baseURL` (or the matching local provider) to its `/v1` endpoint.

**Models changed upstream**  
Run `surf update-models`, or `surf models --refresh`.

**Something is misconfigured**  
Run `surf doctor --network` and `surf config validate`.

---

## License

MIT © 2026 Geetank. See [LICENSE](LICENSE).
