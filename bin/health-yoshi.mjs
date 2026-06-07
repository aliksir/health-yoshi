#!/usr/bin/env node

/**
 * health-yoshi CLI — Service health checker with Telegram notification
 *
 * Usage: node bin/health-yoshi.mjs [--config path/to/config.json]
 *
 * Exit code is always 0 (designed for schtasks periodic execution).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { checkService, parseConfig, isNetworkOutage, formatFailureMessage } from '../src/checker.mjs';
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

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  // Parse --config argument or use default
  const args = process.argv.slice(2);
  let configPath = resolve(__dirname, '..', 'config.json');

  const configIdx = args.indexOf('--config');
  if (configIdx !== -1 && args[configIdx + 1]) {
    configPath = resolve(args[configIdx + 1]);
  }

  // Load config
  let config;
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
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
