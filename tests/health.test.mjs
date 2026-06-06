/**
 * health.test.mjs — Unit tests for checker pure functions
 *
 * Uses node:test (Node.js 18+ built-in test runner).
 * No HTTP mocks — tests parseConfig, resolveSecretRef, isNetworkOutage, formatFailureMessage.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseConfig,
  resolveSecretRef,
  isNetworkOutage,
  formatFailureMessage,
} from '../src/checker.mjs';

// --- parseConfig ---

describe('parseConfig', () => {
  const validConfig = {
    services: [
      { name: 'svc-a', url: 'http://localhost:3000', timeout: 5000 },
    ],
    retryCount: 3,
    retryDelayMs: 500,
    telegram: {
      botToken: 'test-token',
      chatId: '12345',
    },
  };

  it('parses a valid config', () => {
    const result = parseConfig(validConfig);
    assert.equal(result.services.length, 1);
    assert.equal(result.services[0].name, 'svc-a');
    assert.equal(result.retryCount, 3);
    assert.equal(result.retryDelayMs, 500);
    assert.equal(result.telegram.botToken, 'test-token');
    assert.equal(result.telegram.chatId, '12345');
  });

  it('uses default retryCount and retryDelayMs when not provided', () => {
    const cfg = {
      services: [{ name: 'x', url: 'http://x', timeout: 1000 }],
      telegram: { botToken: 'tok', chatId: '1' },
    };
    const result = parseConfig(cfg);
    assert.equal(result.retryCount, 2);
    assert.equal(result.retryDelayMs, 1000);
  });

  it('throws on null config', () => {
    assert.throws(() => parseConfig(null), /non-null object/);
  });

  it('throws on missing services', () => {
    assert.throws(
      () => parseConfig({ telegram: { botToken: 'a', chatId: 'b' } }),
      /non-empty "services" array/,
    );
  });

  it('throws on empty services array', () => {
    assert.throws(
      () => parseConfig({ services: [], telegram: { botToken: 'a', chatId: 'b' } }),
      /non-empty "services" array/,
    );
  });

  it('throws on service missing name', () => {
    assert.throws(
      () => parseConfig({
        services: [{ url: 'http://x', timeout: 1000 }],
        telegram: { botToken: 'a', chatId: 'b' },
      }),
      /name must be a non-empty string/,
    );
  });

  it('throws on service missing url', () => {
    assert.throws(
      () => parseConfig({
        services: [{ name: 'x', timeout: 1000 }],
        telegram: { botToken: 'a', chatId: 'b' },
      }),
      /url must be a non-empty string/,
    );
  });

  it('throws on invalid timeout', () => {
    assert.throws(
      () => parseConfig({
        services: [{ name: 'x', url: 'http://x', timeout: -1 }],
        telegram: { botToken: 'a', chatId: 'b' },
      }),
      /timeout must be a positive number/,
    );
  });

  it('throws on missing telegram section', () => {
    assert.throws(
      () => parseConfig({
        services: [{ name: 'x', url: 'http://x', timeout: 1000 }],
      }),
      /must have a "telegram" object/,
    );
  });
});

// --- resolveSecretRef ---

describe('resolveSecretRef', () => {
  const envKey = 'HEALTH_YOSHI_TEST_SECRET';

  beforeEach(() => {
    process.env[envKey] = 'resolved-value';
  });

  afterEach(() => {
    delete process.env[envKey];
  });

  it('resolves SECRET_REF to env var value', () => {
    const result = resolveSecretRef(`SECRET_REF:${envKey}`);
    assert.equal(result, 'resolved-value');
  });

  it('returns null for unset SECRET_REF env var', () => {
    const result = resolveSecretRef('SECRET_REF:NONEXISTENT_VAR_12345');
    assert.equal(result, null);
  });

  it('returns raw value for non-SECRET_REF strings', () => {
    assert.equal(resolveSecretRef('plain-value'), 'plain-value');
  });

  it('returns null for non-string input', () => {
    assert.equal(resolveSecretRef(undefined), null);
    assert.equal(resolveSecretRef(42), null);
    assert.equal(resolveSecretRef(null), null);
  });
});

// --- isNetworkOutage ---

describe('isNetworkOutage', () => {
  it('returns true when all services are down', () => {
    const results = [
      { ok: false },
      { ok: false },
      { ok: false },
    ];
    assert.equal(isNetworkOutage(results), true);
  });

  it('returns false when at least one service is up', () => {
    const results = [
      { ok: false },
      { ok: true },
      { ok: false },
    ];
    assert.equal(isNetworkOutage(results), false);
  });

  it('returns false when all services are up', () => {
    const results = [
      { ok: true },
      { ok: true },
    ];
    assert.equal(isNetworkOutage(results), false);
  });

  it('returns false for empty results', () => {
    assert.equal(isNetworkOutage([]), false);
  });
});

// --- formatFailureMessage ---

describe('formatFailureMessage', () => {
  it('returns empty string when no failures', () => {
    const results = [
      { name: 'svc-a', url: 'http://a', ok: true, status: 200, error: null, latencyMs: 10 },
    ];
    assert.equal(formatFailureMessage(results), '');
  });

  it('includes failed service details', () => {
    const results = [
      { name: 'svc-ok', url: 'http://ok', ok: true, status: 200, error: null, latencyMs: 10 },
      { name: 'svc-fail', url: 'http://fail', ok: false, status: 500, error: 'HTTP 500', latencyMs: 50 },
    ];
    const msg = formatFailureMessage(results);
    assert.ok(msg.includes('1/2 service(s) DOWN'));
    assert.ok(msg.includes('[FAIL] svc-fail'));
    assert.ok(msg.includes('URL: http://fail'));
    assert.ok(msg.includes('Error: HTTP 500'));
    assert.ok(msg.includes('Status: 500'));
  });

  it('omits status line when status is null', () => {
    const results = [
      { name: 'svc-down', url: 'http://down', ok: false, status: null, error: 'Timeout', latencyMs: 5000 },
    ];
    const msg = formatFailureMessage(results);
    assert.ok(msg.includes('[FAIL] svc-down'));
    assert.ok(msg.includes('Error: Timeout'));
    assert.ok(!msg.includes('Status:'));
  });

  it('includes timestamp in message', () => {
    const results = [
      { name: 'x', url: 'http://x', ok: false, status: null, error: 'err', latencyMs: 0 },
    ];
    const msg = formatFailureMessage(results);
    assert.ok(msg.includes('Checked at:'));
  });
});

// --- parseConfig with SECRET_REF env override ---

describe('parseConfig with env var override', () => {
  const tokenKey = 'HEALTH_YOSHI_BOT_TOKEN';
  const chatKey = 'HEALTH_YOSHI_CHAT_ID';

  afterEach(() => {
    delete process.env[tokenKey];
    delete process.env[chatKey];
  });

  it('env vars override SECRET_REF values', () => {
    process.env[tokenKey] = 'env-token';
    process.env[chatKey] = 'env-chat';

    const cfg = parseConfig({
      services: [{ name: 'x', url: 'http://x', timeout: 1000 }],
      telegram: {
        botToken: 'SECRET_REF:HEALTH_YOSHI_BOT_TOKEN',
        chatId: 'SECRET_REF:HEALTH_YOSHI_CHAT_ID',
      },
    });

    assert.equal(cfg.telegram.botToken, 'env-token');
    assert.equal(cfg.telegram.chatId, 'env-chat');
  });

  it('returns null when SECRET_REF env vars are not set', () => {
    const cfg = parseConfig({
      services: [{ name: 'x', url: 'http://x', timeout: 1000 }],
      telegram: {
        botToken: 'SECRET_REF:NONEXISTENT_TOKEN_VAR',
        chatId: 'SECRET_REF:NONEXISTENT_CHAT_VAR',
      },
    });

    assert.equal(cfg.telegram.botToken, null);
    assert.equal(cfg.telegram.chatId, null);
  });
});
