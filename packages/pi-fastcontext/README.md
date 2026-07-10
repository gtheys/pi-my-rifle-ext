# pi-fastcontext

Pi extension that exposes a `fast_context_search` tool backed by a local [Microsoft FastContext](https://github.com/microsoft/FastContext) llama.cpp server. Returns compact `file:line` citations for read-only codebase search.

## Configuration

Global config: `~/.pi/agent/fastcontext.json`

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

## Usage

The `fast_context_search` tool is registered automatically and available to the agent. Use the `/fastcontext` command for a quick one-off query:

```
/fastcontext <search query>
```
