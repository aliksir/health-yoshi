#!/usr/bin/env node

/**
 * health-yoshi CLI — Service health checker with Telegram notification
 *
 * Usage: node bin/health-yoshi.mjs [--config path/to/config.json]
 *
 * Exit code is always 0 (designed for schtasks periodic execution).
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkService, parseConfig, isNetworkOutage, formatFailureMessage } from '../src/checker.mjs';
import { sendTelegram } from '../src/notifier.mjs';

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

  if (failed.length > 0) {
    if (isNetworkOutage(results)) {
      // All services down — likely network issue, skip notification
      console.error(
        `[health-yoshi] All ${results.length} services are down. ` +
        'Likely a network outage — skipping Telegram notification.',
      );
    } else {
      // Partial failure — send notification
      const message = formatFailureMessage(results);
      notified = await sendTelegram(
        config.telegram.botToken,
        config.telegram.chatId,
        message,
      );
    }
  }

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
