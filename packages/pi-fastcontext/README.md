# pi-fastcontext

Pi extension that exposes a `fast_context_search` tool backed by a local [Microsoft FastContext](https://github.com/microsoft/FastContext) llama.cpp server. Returns compact `file:line` citations for read-only codebase search.

## How it works

1. Spawns a mini agentic loop against a locally running llama.cpp server.
2. The FastContext model gets three tools: `GLOB`, `GREP`, `READ` (all scoped to the repo root).
3. Runs up to `maxTurns` tool turns, then forces a `<final_answer>` block.
4. Citations are validated (file exists, line numbers in bounds) and normalised to repo-relative paths.
5. Returns up to 12 `relative/path:START-END — short reason` lines.

## Prerequisites

| Requirement | Details |
|-------------|---------|
| llama.cpp server | Running at `http://127.0.0.1:8772/v1` (default) with a FastContext model loaded |
| Model file | Default: `FastContext-1.0-4B-RL-Q4_K_M.gguf` |

## Tool parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | `string` | Natural-language code search query |
| `cwd` | `string?` | Repository root. Defaults to current pi cwd |
| `baseUrl` | `string?` | OpenAI-compatible base URL. Defaults to config or `http://127.0.0.1:8772/v1` |
| `model` | `string?` | Model ID. Defaults to config or `FastContext-1.0-4B-RL-Q4_K_M.gguf` |
| `maxTurns` | `integer?` | Tool turns before forced finalization (1–8). Default 6 |
| `maxTokens` | `integer?` | Max tokens per model response (128–4096). Default 1400 |
| `includeTranscript` | `boolean?` | Include raw turn-by-turn transcript in tool details. Default false |

## Commands

```
/fastcontext <query>    — run a code search and display results as a notification
```

## Configuration

Global config: `~/.pi/agent/fastcontext.json`

Config resolved in priority order: built-in defaults → user config → project config (`.pi/fastcontext.json`) → env vars → tool call parameters.

| Option | Type | Default | Description |
|---|---|---|---|
| `baseUrl` | string | `http://127.0.0.1:8772/v1` | OpenAI-compatible base URL for the FastContext server |
| `model` | string | `FastContext-1.0-4B-RL-Q4_K_M.gguf` | FastContext model ID |
| `maxTurns` | integer | `6` | Maximum tool-call turns per search (1–8) |
| `maxTokens` | integer | `1400` | Max tokens per model response (128–4096) |

```json
{
  "$schema": "./.pi/agent/fastcontext/config.schema.json",
  "baseUrl": "http://127.0.0.1:8772/v1",
  "model": "FastContext-1.0-4B-RL-Q4_K_M.gguf",
  "maxTurns": 6,
  "maxTokens": 1400
}
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `FASTCONTEXT_BASE_URL` | Override llama.cpp server URL |
| `FASTCONTEXT_MODEL` | Override model ID |
| `FASTCONTEXT_MAX_TURNS` | Override max tool turns |
| `FASTCONTEXT_MAX_TOKENS` | Override max tokens per response |
