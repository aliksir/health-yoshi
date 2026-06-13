#!/usr/bin/env node

/**
 * health-yoshi CLI — Service health checker with Telegram notification
 *
 * Usage: node bin/health-yoshi.mjs [--config path/to/config.json]
 *
 * Exit code is always 0 (designed for schtasks periodic execution).
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { checkService, parseConfig, isNetworkOutage, formatFailureMessage, normalizeCredential, resolveSecretRef } from '../src/checker.mjs';
import { sendTelegram, sendWebhook } from '../src/notifier.mjs';

const STATE_DIR = join(homedir(), '.health-yoshi');
const STATE_PATH = join(STATE_DIR, 'state.json');

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
  } catch {
    return { consecutiveOutageCount: 0 };
  }
}

function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state), 'utf-8');
}

function writeStats(entry) {
  try {
    const dir = process.env.NEKO_HQ_STATS
      ? dirname(process.env.NEKO_HQ_STATS)
      : join(homedir(), '.neko-hq');
    const file = process.env.NEKO_HQ_STATS || join(dir, 'stats.jsonl');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    console.error(`[health-yoshi] stats write failed: ${err.message}`);
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const startTime = Date.now();

  // Parse --config argument or use default
  const args = process.argv.slice(2);
  const checkMode = args.includes('--check');
  let configPath = resolve(__dirname, '..', 'config.json');

  const configIdx = args.indexOf('--config');
  if (configIdx !== -1 && args[configIdx + 1]) {
    configPath = resolve(args[configIdx + 1]);
  }

  // Load config
  let raw;
  let config;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    config = parseConfig(raw);
  } catch (err) {
    console.error(`[health-yoshi] Config error: ${err.message}`);
    // Output error result and exit 0 (schtasks compatibility)
    const errorResult = {
      timestamp: new Date().toISOString(),
      error: `Config error: ${err.message}`,
      results: [],
    };
    console.log(JSON.stringify(errorResult, null, 2));
    process.exit(0);
  }

  // --check mode: show credential diagnostics only (no real values)
  if (checkMode) {
    const tgCfg = (raw && raw.telegram) ? raw.telegram : {};

    function credentialDiag(label, envKey, configValue) {
      const rawEnvValue = process.env[envKey];
      const rawConfigValue = resolveSecretRef(configValue);

      // Determine raw value and source before normalization
      let rawValue;
      let source;
      if (rawEnvValue !== undefined && rawEnvValue !== null && rawEnvValue !== '') {
        rawValue = rawEnvValue;
        source = 'env';
      } else if (typeof configValue === 'string' && configValue.startsWith('SECRET_REF:')) {
        rawValue = rawConfigValue;
        const refName = configValue.slice('SECRET_REF:'.length);
        source = rawValue !== null ? `SECRET_REF (${refName})` : `SECRET_REF (${refName}) [unset]`;
      } else if (typeof configValue === 'string' && configValue.length > 0) {
        rawValue = rawConfigValue;
        source = 'config';
      } else {
        rawValue = null;
        source = 'unresolved';
      }

      const normalized = normalizeCredential(rawValue);
      const rawLen = typeof rawValue === 'string' ? rawValue.length : 0;
      const normLen = normalized !== null ? normalized.length : 0;
      const trimmedDiff = rawLen - normLen;

      const lengthStr = normalized !== null ? String(normLen) : '0 (unresolved)';
      const trimmedStr = trimmedDiff > 0
        ? `${trimmedDiff} WARNING: whitespace/CR detected`
        : String(trimmedDiff);

      console.log(`  ${label}:`);
      console.log(`    source  : ${source}`);
      console.log(`    length  : ${lengthStr}`);
      console.log(`    trimmed : ${trimmedStr}`);
    }

    console.log('[health-yoshi] --check: credential diagnostics');
    console.log('  (actual values are never shown)');
    console.log('');
    credentialDiag('botToken', 'HEALTH_YOSHI_BOT_TOKEN', tgCfg.botToken);
    console.log('');
    credentialDiag('chatId', 'HEALTH_YOSHI_CHAT_ID', tgCfg.chatId);
    console.log('');

    const bothResolved = config.telegram.botToken !== null && config.telegram.chatId !== null;
    console.log(`  result: ${bothResolved ? 'OK' : 'NG'}`);
    process.exit(0);
  }

  // Check all services concurrently
  const results = await Promise.all(
    config.services.map(async (svc) => {
      const result = await checkService(
        svc.url,
        svc.timeout,
        config.retryCount,
        config.retryDelayMs,
      );
      return { name: svc.name, url: svc.url, ...result };
    }),
  );

  // Determine failures
  const failed = results.filter(r => !r.ok);
  let notified = false;
  const state = loadState();

  async function notify(message) {
    const tg = await sendTelegram(config.telegram.botToken, config.telegram.chatId, message);
    if (config.webhookUrl) {
      await sendWebhook(config.webhookUrl, message, { results });
    }
    return tg;
  }

  if (failed.length > 0) {
    if (isNetworkOutage(results)) {
      state.consecutiveOutageCount = (state.consecutiveOutageCount || 0) + 1;

      if (config.notifyOnNetworkOutage) {
        const message = formatFailureMessage(results);
        notified = await notify(message);
      } else if (state.consecutiveOutageCount >= config.consecutiveOutageThreshold) {
        const message = `--- health-yoshi CRITICAL ---\n` +
          `全${results.length}サービスが${state.consecutiveOutageCount}回連続でダウンしています。\n` +
          `ネットワーク障害または共通基盤障害の可能性があります。\n\n` +
          formatFailureMessage(results);
        notified = await notify(message);
      } else {
        console.error(
          `[health-yoshi] All ${results.length} services are down (${state.consecutiveOutageCount}/${config.consecutiveOutageThreshold}). ` +
          'Likely a network outage — skipping notification.',
        );
      }
    } else {
      state.consecutiveOutageCount = 0;
      const message = formatFailureMessage(results);
      notified = await notify(message);
    }
  } else {
    state.consecutiveOutageCount = 0;
  }

  saveState(state);

  // Output JSON result to stdout
  const output = {
    timestamp: new Date().toISOString(),
    total: results.length,
    healthy: results.length - failed.length,
    unhealthy: failed.length,
    networkOutage: isNetworkOutage(results),
    notified,
    results: results.map(r => ({
      name: r.name,
      url: r.url,
      ok: r.ok,
      status: r.status,
      error: r.error,
      latencyMs: r.latencyMs,
    })),
  };

  // Write stats entry
  writeStats({
    schema_version: '1.1',
    tool: 'health-yoshi',
    command: 'check',
    ts: new Date().toISOString(),
    duration_ms: Date.now() - startTime,
    exit_code: failed.length > 0 ? 1 : 0,
    severity: failed.length > 0 ? 'warn' : 'info',
    summary: {
      total: results.length,
      healthy: results.length - failed.length,
      unhealthy: failed.length,
      notified: notified ? 1 : 0,
    },
  });

  console.log(JSON.stringify(output, null, 2));
  process.exit(0);
}

main().catch(err => {
  console.error(`[health-yoshi] Unexpected error: ${err.message}`);
  const errorResult = {
    timestamp: new Date().toISOString(),
    error: `Unexpected: ${err.message}`,
    results: [],
  };
  console.log(JSON.stringify(errorResult, null, 2));
  process.exit(0);
});
