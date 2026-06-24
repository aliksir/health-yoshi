/**
 * checker.mjs — サービスヘルスチェックロジック（外部依存ゼロ）
 *
 * Node.js 18+ の組み込み fetch API を使用。
 */

/**
 * 単一サービスのヘルスチェックを実行する（タイムアウト + リトライ付き）
 * @param {string} url - チェック対象のサービスURL
 * @param {number} timeout - タイムアウト時間（ミリ秒）
 * @param {number} retryCount - 失敗時のリトライ回数
 * @param {number} retryDelayMs - リトライ間隔（ミリ秒）
 * @returns {Promise<{ok: boolean, status: number|null, error: string|null, latencyMs: number}>}
 */
export async function checkService(url, timeout, retryCount, retryDelayMs) {
  let lastError = null;
  let lastStatus = null;

  for (let attempt = 0; attempt <= retryCount; attempt++) {
    // リトライ時は指定間隔だけ待機する
    if (attempt > 0) {
      await sleep(retryDelayMs);
    }

    const start = Date.now();
    try {
      // AbortController でタイムアウトを実装する
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);

      const latencyMs = Date.now() - start;

      if (res.ok) {
        return { ok: true, status: res.status, error: null, latencyMs };
      }

      // 非OKステータスを記録してリトライを継続する
      lastStatus = res.status;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      const latencyMs = Date.now() - start;
      lastStatus = null;

      if (err.name === 'AbortError') {
        lastError = `Timeout after ${timeout}ms`;
      } else {
        lastError = err.message || String(err);
      }

      // 最終リトライでは現在のレイテンシで即時返却する
      if (attempt === retryCount) {
        return { ok: false, status: lastStatus, error: lastError, latencyMs };
      }
    }
  }

  // 全リトライ消耗後（非OKステータスが最後）
  return { ok: false, status: lastStatus, error: lastError, latencyMs: -1 };
}

/**
 * 認証情報を正規化する: 前後の空白を除去し、非文字列または空文字列の場合は null を返す
 * @param {*} value - 生の認証情報値
 * @returns {string|null}
 */
export function normalizeCredential(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * 設定オブジェクトをパースしてバリデーションする
 * @param {object} raw - JSONから読み込んだ生の設定オブジェクト
 * @returns {{ services: Array, retryCount: number, retryDelayMs: number, telegram: { botToken: string, chatId: string } }}
 * @throws {Error} 設定が不正な場合
 */
export function parseConfig(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Config must be a non-null object');
  }
  if (!Array.isArray(raw.services) || raw.services.length === 0) {
    throw new Error('Config must have a non-empty "services" array');
  }

  const services = raw.services.map((svc, i) => {
    if (!svc.name || typeof svc.name !== 'string') {
      throw new Error(`services[${i}].name must be a non-empty string`);
    }
    if (!svc.url || typeof svc.url !== 'string') {
      throw new Error(`services[${i}].url must be a non-empty string`);
    }
    if (typeof svc.timeout !== 'number' || svc.timeout <= 0) {
      throw new Error(`services[${i}].timeout must be a positive number`);
    }
    return { name: svc.name, url: svc.url, timeout: svc.timeout };
  });

  const retryCount = typeof raw.retryCount === 'number' ? raw.retryCount : 2;
  const retryDelayMs = typeof raw.retryDelayMs === 'number' ? raw.retryDelayMs : 1000;

  if (!raw.telegram || typeof raw.telegram !== 'object') {
    throw new Error('Config must have a "telegram" object');
  }

  // Telegram認証情報を解決する: 環境変数が設定値より優先される
  // normalizeCredential は空白/CRを除去し空文字列を null に変換する
  const botToken = normalizeCredential(
    process.env.HEALTH_YOSHI_BOT_TOKEN || resolveSecretRef(raw.telegram.botToken),
  );
  const chatId = normalizeCredential(
    process.env.HEALTH_YOSHI_CHAT_ID || resolveSecretRef(raw.telegram.chatId),
  );

  const notifyOnNetworkOutage = raw.notifyOnNetworkOutage === true;
  const consecutiveOutageThreshold = typeof raw.consecutiveOutageThreshold === 'number'
    ? raw.consecutiveOutageThreshold : 3;
  const webhookUrl = raw.webhookUrl || null;

  return {
    services, retryCount, retryDelayMs,
    telegram: { botToken, chatId },
    notifyOnNetworkOutage, consecutiveOutageThreshold, webhookUrl,
  };
}

/**
 * SECRET_REF 値を解決する。
 * SECRET_REF でない場合は生の値を返し、解決できない場合は null を返す
 * @param {string} value
 * @returns {string|null}
 */
export function resolveSecretRef(value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('SECRET_REF:')) {
    // SECRET_REF:<ENV_VAR_NAME> — look up the env var
    const envVar = value.slice('SECRET_REF:'.length);
    return process.env[envVar] || null;
  }
  return value;
}

/**
 * 全サービスがダウンしているか判定する（ネットワーク障害ヒューリスティック）
 * @param {Array<{ok: boolean}>} results
 * @returns {boolean}
 */
export function isNetworkOutage(results) {
  if (results.length === 0) return false;
  return results.every(r => !r.ok);
}

/**
 * チェック結果をTelegram通知用のメッセージ文字列にフォーマットする
 * @param {Array<{name: string, ok: boolean, status: number|null, error: string|null, latencyMs: number}>} results
 * @returns {string}
 */
export function formatFailureMessage(results) {
  const failed = results.filter(r => !r.ok);
  if (failed.length === 0) return '';

  const lines = [
    '--- health-yoshi alert ---',
    `${failed.length}/${results.length} service(s) DOWN`,
    '',
  ];

  for (const r of failed) {
    lines.push(`[FAIL] ${r.name}`);
    lines.push(`  URL: ${r.url}`);
    lines.push(`  Error: ${r.error}`);
    if (r.status != null) {
      lines.push(`  Status: ${r.status}`);
    }
    lines.push('');
  }

  lines.push(`Checked at: ${new Date().toISOString()}`);
  return lines.join('\n');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
