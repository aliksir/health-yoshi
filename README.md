> 日本語版は [README.ja.md](README.ja.md) を参照してください。
> Part of the [neko-HQ](https://github.com/aliksir/neko-hq) ecosystem.

# health-yoshi

Service health checker with Telegram notification. Zero dependencies.

Monitors HTTP services and sends Telegram alerts when failures are detected. Designed for periodic execution via cron or Windows Task Scheduler (`schtasks`).

## Features

- **Zero dependencies** -- uses only Node.js built-in APIs (`fetch`, `node:fs`, `node:test`)
- **Concurrent checks** -- all services are checked in parallel
- **Retry with delay** -- configurable retry count and delay per check
- **Network outage detection** -- suppresses Telegram alerts when all services are down (likely a local network issue, not individual service failures)
- **Telegram notifications** -- sends alerts on partial failures with detailed error info
- **Secret management** -- supports `SECRET_REF:ENV_VAR_NAME` pattern and environment variable overrides for credentials
- **schtasks-friendly** -- always exits with code 0 for compatibility with Windows Task Scheduler
- **JSON output** -- structured results on stdout for piping or logging

## Installation

```bash
git clone https://github.com/aliksir/health-yoshi.git
cd health-yoshi
```

No `npm install` needed -- zero dependencies.

### Global install (optional)

```bash
npm link
# Now available as: health-yoshi
```

## Configuration

Create or edit `config.json` in the project root:

```json
{
  "services": [
    {
      "name": "my-app",
      "url": "http://localhost:3000",
      "timeout": 5000
    },
    {
      "name": "my-api",
      "url": "http://localhost:8080/health",
      "timeout": 3000
    }
  ],
  "retryCount": 2,
  "retryDelayMs": 1000,
  "telegram": {
    "botToken": "SECRET_REF:HEALTH_YOSHI_BOT_TOKEN",
    "chatId": "SECRET_REF:HEALTH_YOSHI_CHAT_ID"
  }
}
```

### Config fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `services` | array | yes | -- | List of services to monitor |
| `services[].name` | string | yes | -- | Display name for the service |
| `services[].url` | string | yes | -- | URL to check (HTTP GET) |
| `services[].timeout` | number | yes | -- | Timeout in milliseconds |
| `retryCount` | number | no | `2` | Number of retries on failure |
| `retryDelayMs` | number | no | `1000` | Delay between retries (ms) |
| `telegram.botToken` | string | yes | -- | Telegram Bot API token |
| `telegram.chatId` | string | yes | -- | Telegram chat ID for alerts |

### Telegram credentials

Credentials can be provided in three ways (in order of priority):

1. **Environment variables** (highest priority): `HEALTH_YOSHI_BOT_TOKEN` and `HEALTH_YOSHI_CHAT_ID`
2. **SECRET_REF pattern**: set `"botToken": "SECRET_REF:MY_ENV_VAR"` in config.json -- the value of `MY_ENV_VAR` will be used at runtime
3. **Plain text**: set the token directly in config.json (not recommended)

## Usage

```bash
# Using default config.json
node bin/health-yoshi.mjs

# Using a custom config file
node bin/health-yoshi.mjs --config /path/to/my-config.json

# If globally installed
health-yoshi --config /path/to/my-config.json
```

### Output example

```json
{
  "timestamp": "2026-06-07T12:00:00.000Z",
  "total": 3,
  "healthy": 2,
  "unhealthy": 1,
  "networkOutage": false,
  "notified": true,
  "results": [
    { "name": "my-app", "url": "http://localhost:3000", "ok": true, "status": 200, "error": null, "latencyMs": 42 },
    { "name": "my-api", "url": "http://localhost:8080", "ok": true, "status": 200, "error": null, "latencyMs": 15 },
    { "name": "my-db", "url": "http://localhost:5432", "ok": false, "status": null, "error": "Timeout after 5000ms", "latencyMs": 5001 }
  ]
}
```

### Telegram alert example

When partial failures are detected, health-yoshi sends a message like:

```
--- health-yoshi alert ---
1/3 service(s) DOWN

[FAIL] my-db
  URL: http://localhost:5432
  Error: Timeout after 5000ms

Checked at: 2026-06-07T12:00:00.000Z
```

When **all** services are down, no Telegram notification is sent (network outage heuristic).

### Periodic execution (Windows Task Scheduler)

```cmd
schtasks /create /tn "health-yoshi" /tr "node C:\path\to\health-yoshi\bin\health-yoshi.mjs" /sc minute /mo 5
```

### Periodic execution (cron)

```bash
*/5 * * * * node /path/to/health-yoshi/bin/health-yoshi.mjs >> /var/log/health-yoshi.log 2>&1
```

## Options

| Option | Description |
|--------|-------------|
| `--config <path>` | Path to config.json (default: `./config.json` in project root) |

## Testing

```bash
npm test
# or directly:
node --test tests/health.test.mjs
```

## Requirements

- **Node.js 18+** (uses global `fetch` API and `node:test`)

## License

MIT
