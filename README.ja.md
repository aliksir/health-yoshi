> English version: [README.md](README.md)
> [neko-HQ](https://github.com/aliksir/neko-hq) エコシステムの一部です。

# health-yoshi (日本語)

Telegram 通知付きサービスヘルスチェッカー。ゼロ依存設計。

HTTP サービスを監視し、障害検知時に Telegram でアラートを送信します。cron や Windows タスクスケジューラ（`schtasks`）による定期実行を想定しています。

## 特徴

- **ゼロ依存** -- Node.js 組み込み API のみ使用（`fetch`、`node:fs`、`node:test`）
- **並行チェック** -- 全サービスを並列でチェック
- **リトライ機能** -- 失敗時のリトライ回数と間隔を設定可能
- **ネットワーク障害検知** -- 全サービスがダウンしている場合は Telegram 通知を抑制（個別サービスの障害ではなくネットワーク障害の可能性が高いため）
- **Telegram 通知** -- 部分障害時に詳細なエラー情報付きでアラートを送信
- **シークレット管理** -- `SECRET_REF:ENV_VAR_NAME` パターンおよび環境変数によるクレデンシャル管理に対応
- **schtasks 互換** -- Windows タスクスケジューラとの互換性のため、常に終了コード 0 で終了
- **JSON 出力** -- パイプやログ記録に適した構造化された結果を標準出力に出力

## インストール

```bash
git clone https://github.com/aliksir/health-yoshi.git
cd health-yoshi
```

`npm install` は不要です（ゼロ依存設計）。

### グローバルインストール（任意）

```bash
npm link
# health-yoshi コマンドとして利用可能になります
```

## 設定

プロジェクトルートの `config.json` を作成・編集してください。

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

### 設定項目

| フィールド | 型 | 必須 | デフォルト | 説明 |
|-----------|------|------|-----------|------|
| `services` | array | はい | -- | 監視対象サービスの一覧 |
| `services[].name` | string | はい | -- | サービスの表示名 |
| `services[].url` | string | はい | -- | チェック対象の URL（HTTP GET） |
| `services[].timeout` | number | はい | -- | タイムアウト（ミリ秒） |
| `retryCount` | number | いいえ | `2` | 失敗時のリトライ回数 |
| `retryDelayMs` | number | いいえ | `1000` | リトライ間隔（ミリ秒） |
| `notifyOnNetworkOutage` | boolean | いいえ | `false` | 全サービスダウン時も通知する |
| `consecutiveOutageThreshold` | number | いいえ | `3` | 連続N回全滅で通知（`notifyOnNetworkOutage` が false 時） |
| `webhookUrl` | string | いいえ | `null` | 汎用 Webhook URL（POST JSON） |
| `telegram.botToken` | string | はい | -- | Telegram Bot API トークン |
| `telegram.chatId` | string | はい | -- | アラート送信先の Telegram チャット ID |

### Telegram クレデンシャルの設定方法

クレデンシャルは以下の 3 つの方法で設定できます（優先順位順）:

1. **環境変数**（最優先）: `HEALTH_YOSHI_BOT_TOKEN` と `HEALTH_YOSHI_CHAT_ID` を設定
2. **SECRET_REF パターン**: config.json で `"botToken": "SECRET_REF:MY_ENV_VAR"` と記述すると、実行時に `MY_ENV_VAR` の値が使用されます
3. **平文**（非推奨）: config.json にトークンを直接記述

## 使い方

```bash
# デフォルトの config.json を使用
node bin/health-yoshi.mjs

# カスタム設定ファイルを指定
node bin/health-yoshi.mjs --config /path/to/my-config.json

# グローバルインストール済みの場合
health-yoshi --config /path/to/my-config.json
```

### 出力例

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

### Telegram アラートの例

部分障害が検知された場合、以下のようなメッセージが送信されます:

```
--- health-yoshi alert ---
1/3 service(s) DOWN

[FAIL] my-db
  URL: http://localhost:5432
  Error: Timeout after 5000ms

Checked at: 2026-06-07T12:00:00.000Z
```

**全サービス**がダウンしている場合は Telegram 通知を送信しません（ネットワーク障害ヒューリスティック）。

### 定期実行（Windows タスクスケジューラ）

```cmd
schtasks /create /tn "health-yoshi" /tr "node C:\path\to\health-yoshi\bin\health-yoshi.mjs" /sc minute /mo 5
```

### 定期実行（cron）

```bash
*/5 * * * * node /path/to/health-yoshi/bin/health-yoshi.mjs >> /var/log/health-yoshi.log 2>&1
```

## オプション

| オプション | 説明 |
|-----------|------|
| `--config <path>` | config.json のパス（デフォルト: プロジェクトルートの `./config.json`） |

## テスト

```bash
npm test
# または直接:
node --test tests/health.test.mjs
```

## 動作要件

- **Node.js 18 以上**（グローバル `fetch` API と `node:test` を使用）

## ライセンス

MIT
