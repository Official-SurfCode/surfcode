<div align="center">

<img src="assets/surfcode-logo.gif" alt="SurfCode" width="480">

### Ride the code.

**A beautiful, provider-agnostic AI coding agent for your terminal.**
One keyboard-driven TUI. Any model. Your keys, your machine, no telemetry.

<br>

[![License: MIT](https://img.shields.io/badge/license-MIT-2ea043?style=for-the-badge)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-3c873a?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=for-the-badge&logo=typescript&logoColor=white)](tsconfig.json)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-ff69b4?style=for-the-badge)](CONTRIBUTING.md)

[**Install**](#-install) · [**Quick start**](#-quick-start) · [**Features**](#-features) · [**Providers**](#-any-model-any-provider) · [**Headless**](#-headless--ci) · [**Full docs**](docs/REFERENCE.md)

</div>

<br>

---

## ✨ Why SurfCode?

Most coding agents lock you to one vendor, one model, and one pricing page. SurfCode doesn't.

| | |
| :-- | :-- |
| 🌊 **Provider-agnostic** | OpenAI, Anthropic, Google, OpenRouter, Groq, DeepSeek, Ollama… **232 providers and 9,000+ models** from the [models.dev](https://models.dev) catalog, with an offline snapshot bundled. |
| 🛡️ **You stay in control** | Reads are free, writes and shell commands ask first. A read-only **plan mode** lets the agent look but never touch. |
| 🔒 **Local-first** | Keys, sessions and config never leave your machine. **No telemetry. No background uploads.** |
| ⚡ **Fast and calm** | Alternate-screen TUI that only repaints what changed. Replies land complete; turn on live typing with `/stream on`. |
| 🤖 **Scriptable** | `surf run` gives clean stdout, NDJSON events and deterministic exit codes, so it drops straight into pipes and CI. |

<br>

## 📦 Install

> Requires **Node.js 22+** and a modern terminal (iTerm2, Ghostty, Kitty, WezTerm, Windows Terminal, …).

**From npm**

```bash
npm install -g surfcode
surf --version
```

**Straight from GitHub**

```bash
npm install -g github:Official-SurfCode/surfcode
```

**From source**

```bash
git clone https://github.com/Official-SurfCode/surfcode.git
cd surfcode
npm install        # also builds dist/
npm link           # puts `surf` and `surfcode` on your PATH
```

Both commands, **`surf`** and **`surfcode`**, do the same thing.

<br>

## 🚀 Quick start

```bash
surf
```

The first launch opens the full-screen UI. Then:

```text
/connect      pick a provider and paste a key (ctrl+v)
/model        browse models from the providers you've connected
/help         every command and shortcut
```

Prefer the shell?

```bash
surf auth anthropic                    # hidden key prompt
surf models --provider openai          # browse the catalog
surf run "explain src/core/agent.ts"   # one-shot, no UI
```

Already have `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GEMINI_API_KEY` in your environment? SurfCode finds it and picks a sensible default model on its own.

<br>

## 🧰 Features

<table>
<tr>
<td width="50%" valign="top">

### 🖥️ A TUI worth living in
- Alternate screen, smooth scrolling, markdown and syntax highlighting
- **Six themes**: `aurora` · `dark` · `ember` · `forest` · `violet` · `mono`
- A resizable **file explorer dock** with live previews
- `@file` attachments and `!command` shell passthrough
- Command palette, input history, tab completion

</td>
<td width="50%" valign="top">

### 🔧 Real tool use
- `read` · `write` · `edit` · `ls` · `glob` · `grep` · `bash` · `webfetch` · `todo_write`
- Inline diffs for every edit
- Non-interactive shell with timeouts and capped output
- Project instructions from `SURFCODE.md`, `AGENTS.md` or `CLAUDE.md`

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🧠 Reasoning on tap
- `/effort low|medium|high|auto`, mapped to each provider's native controls
- Gemini 3 `thinkingLevel`, Gemini 2.5 budgets, Anthropic extended thinking, OpenAI `reasoning_effort`
- `/thinking` shows or hides reasoning text

</td>
<td width="50%" valign="top">

### 🎛️ Multi-model orchestration
- `/agent add provider/model` keeps your model as the **head**
- Up to **8 worker models** run in parallel via a read-only `delegate` tool
- Workers never touch your files; the head verifies and synthesizes

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 💬 Side questions, no baggage
- `/btw <question>` answers with the conversation as context
- No tools, and it leaves nothing in the session or usage totals

</td>
<td width="50%" valign="top">

### 📊 Honest usage and cost
- Provider-reported input, output, reasoning and cache tokens
- `/cost` and `/context` show where your budget is going
- `/compact` summarizes history to free context

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🐙 GitHub publishing, on request
- Log in with a token, then ask in plain language
- Create a repo, upload a project, commit and push later
- Never force-pushes, never rewrites history, never deletes a repo
- Nothing is published unless you ask

</td>
<td width="50%" valign="top">

### ☁️ Optional BYOK session sync
- Run the tiny self-hosted sync server, or bring your own HTTPS endpoint
- **Only session records sync.** API keys never leave your machine

</td>
</tr>
</table>

<br>

## 🌊 Any model, any provider

```text
OpenAI · Anthropic · Google · Azure OpenAI · Vertex · OpenRouter · DeepSeek
xAI · Mistral · Groq · Cerebras · Together · Fireworks · DeepInfra · Cohere
Perplexity · Moonshot · Zhipu · GitHub Copilot · Cloudflare Workers AI  …and 200+ more
```

- Providers with a permanent free API tier are tagged **`[FREE API]`** in the picker.
- **Local models just work.** Ollama, llama.cpp, vLLM and LM Studio are auto-detected when running.
- Bring anything OpenAI-compatible with a custom `baseURL`.
- `surf update-models` refreshes the catalog; the bundled snapshot is the offline fallback.

<br>

## ⌨️ Commands you'll use daily

| Command | What it does |
| :-- | :-- |
| `/model` · `/connect` · `/provider` | Switch model, add a key, browse providers |
| `/effort` · `/thinking` · `/stream` | Reasoning depth, visible thoughts, live typing |
| `/plan` · `/build` | Toggle read-only plan mode (also `shift+tab`) |
| `/agent` | Run worker models in parallel |
| `/btw <q>` | Ask a side question without saving it |
| `/explorer` · `/theme` · `/options` | File dock, themes, settings |
| `/sessions` · `/new` · `/compact` · `/export` | Resume, restart, shrink, save as Markdown |
| `/github` | Connect GitHub and publish code |
| `/cost` · `/context` | Tokens, spend and context usage |

<details>
<summary><b>Keyboard shortcuts</b></summary>

<br>

| Key | Action |
| :-- | :-- |
| `enter` | Send prompt |
| `ctrl+j` | New line |
| `esc` | Stop generating / leave dock / close overlay |
| `ctrl+c` | Interrupt (press twice to exit) |
| `tab` | Complete a command or file |
| `shift+tab` | Toggle plan / build mode |
| `ctrl+t` | Cycle themes |
| `ctrl+o` | Focus the file dock |
| `ctrl+←` / `ctrl+→` | Resize the dock |
| `ctrl+v` | Paste from the clipboard |
| `pgup` / `pgdn` | Scroll the transcript |
| `?` | Help (when the prompt is empty) |

</details>

<br>

## 🛡️ Safe by default

Every tool action is classified, and you decide what is allowed.

| Action | Default |
| :-- | :-- |
| `read` · `fetch` | ✅ allow |
| `write` · `shell` | ❓ ask first |
| Outside the workspace | 🚫 off |
| **Plan mode** | 🔒 read-only, nothing can mutate |

- Choose **yes**, **always** or **no** at each prompt. Deny an action for good with `"permissions": { "shell": "deny" }`.
- Destructive shell commands are flagged as high-risk in the prompt.
- `/access full` is an explicit opt-in for trusted machines. A red badge shows while it's on.
- `surf config` redacts keys, tokens and auth headers.

<br>

## 🤖 Headless & CI

```bash
surf run "summarize this repository"
cat error.log | surf run "explain this failure"
surf run --plan "map the auth flow before changing it"
surf run --yes "run the tests and fix failures"
surf run --json --yes "list the files" | jq -c 'select(.type == "result")'
```

Answers stream to **stdout**, tool progress to **stderr**, so pipes stay clean. With `--json` you get one NDJSON event per line. Exit codes are `0` success, `1` error, `130` interrupted.

<br>

## 🩺 Handy CLI

```text
surf                    open the TUI
surf run [prompt]       one-shot headless run
surf auth [provider]    connect a provider or GitHub
surf models [query]     browse the model catalog
surf providers          provider status (--all for the full catalog)
surf sessions           list and manage saved sessions
surf config             inspect or edit configuration
surf doctor             diagnose problems (--network to test connectivity)
surf update-models      refresh the models.dev catalog
```

<br>

## 🏗️ Project layout

```text
src/
  cli.tsx        command-line entry
  cli/           auth, config, sessions, inspect, headless, interactive
  core/          catalog, providers, chat dialects, agent loop, sessions
  tools/         read, write, edit, grep, bash, webfetch, GitHub…
  tui/           Ink UI, rendering, themes, overlays, file explorer
  sync/          self-hosted session sync server
  data/          bundled models.dev snapshot
test/            unit and CLI integration tests (mock SSE servers, no keys needed)
scripts/         catalog updates, logo rendering, asset copying
docs/            full reference
```

<br>

## 🤝 Contributing

Contributions are welcome. The short version:

```bash
npm install
npm run dev          # run from source
npm run typecheck
npm test             # no API keys required
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to add a tool or a new provider dialect.

<br>

## 📚 Documentation

The **[full reference](docs/REFERENCE.md)** covers every setting and flag: configuration, custom endpoints, session sync, multi-model agents, GitHub publishing, JSON event schema, troubleshooting and more.

<br>

## 📄 License

MIT © 2026 Geetank. See [LICENSE](LICENSE).

<div align="center">

<br>

**If SurfCode saves you time, a ⭐ on the repo means a lot.**

</div>
