/**
 * notifier.mjs — Telegram + Webhook notification (zero dependencies)
 *
 * Uses Node.js 18+ global fetch API.
 */

/**
 * Send a message via Telegram Bot API.
 * @param {string} botToken - Telegram bot token
 * @param {string} chatId - Telegram chat ID
 * @param {string} message - Message text
 * @returns {Promise<boolean>} true if sent successfully
 */
export async function sendTelegram(botToken, chatId, message) {
  if (!botToken || !chatId) {
    console.error('[health-yoshi] Telegram credentials not configured, skipping notification');
    return false;
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        disable_web_page_preview: true,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[health-yoshi] Telegram API error: ${res.status} — ${body}`);
      return false;
    }

    return true;
  } catch (err) {
    console.error(`[health-yoshi] Telegram send failed: ${err.message}`);
    return false;
  }
}

/**
 * Send a message via generic webhook (POST JSON).
 * @param {string} url - Webhook URL
 * @param {string} message - Message text
 * @param {object} payload - Full check result payload
 * @returns {Promise<boolean>}
 */
export async function sendWebhook(url, message, payload) {
  if (!url) return false;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message, ...payload }),
    });
    return res.ok;
  } catch (err) {
    console.error(`[health-yoshi] Webhook send failed: ${err.message}`);
    return false;
  }
}
