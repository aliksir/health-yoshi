/**
 * checker.mjs — Service health check logic (zero dependencies)
 *
 * Uses Node.js 18+ global fetch API.
 */

/**
 * Check a single service health.
 * @param {string} url - Service URL to check
 * @param {number} timeout - Timeout in milliseconds
 * @param {number} retryCount - Number of retries on failure
 * @param {number} retryDelayMs - Delay between retries in milliseconds
 * @returns {Promise<{ok: boolean, status: number|null, error: string|null, latencyMs: number}>}
 */
export async function checkService(url, timeout, retryCount, retryDelayMs) {
  let lastError = null;
  let lastStatus = null;

  for (let attempt = 0; attempt <= retryCount; attempt++) {
    if (attempt > 0) {
      await sleep(retryDelayMs);
    }

    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);

      const latencyMs = Date.now() - start;

      if (res.ok) {
        return { ok: true, status: res.status, error: null, latencyMs };
      }

      // Non-OK status — record and retry
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

      // On final attempt, return immediately with current latency
      if (attempt === retryCount) {
        return { ok: false, status: lastStatus, error: lastError, latencyMs };
      }
    }
  }

  // All retries exhausted with non-OK status
  return { ok: false, status: lastStatus, error: lastError, latencyMs: -1 };
}

/**
 * Normalize a credential value: trim whitespace, return null if non-string or empty after trim.
 * @param {*} value - Raw credential value
 * @returns {string|null}
 */
export function normalizeCredential(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Parse and validate config.
 * @param {object} raw - Raw config object from JSON
 * @returns {{ services: Array, retryCount: number, retryDelayMs: number, telegram: { botToken: string, chatId: string } }}
 * @throws {Error} on invalid config
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

  // Resolve telegram credentials: env vars override config values.
  // normalizeCredential trims whitespace/CR and converts empty strings to null.
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
 * Resolve a SECRET_REF value.
 * Returns the raw value if not a SECRET_REF, or null if unresolved.
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
 * Determine if all services are down (network outage heuristic).
 * @param {Array<{ok: boolean}>} results
 * @returns {boolean}
 */
export function isNetworkOutage(results) {
  if (results.length === 0) return false;
  return results.every(r => !r.ok);
}

/**
 * Format check results for Telegram notification.
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
