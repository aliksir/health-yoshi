/**
 * notifier.mjs — Telegram + Webhook通知（外部依存ゼロ）
 *
 * Node.js 18+ の組み込み fetch API を使用。
 */

/**
 * Telegram Bot API 経由でメッセージを送信する
 * @param {string} botToken - Telegram ボットトークン
 * @param {string} chatId - Telegram チャットID
 * @param {string} message - メッセージ本文
 * @returns {Promise<boolean>} 送信成功時は true
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
 * 汎用Webhook経由でメッセージを送信する（POST JSON）
 * @param {string} url - Webhook URL
 * @param {string} message - メッセージ本文
 * @param {object} payload - チェック結果のペイロード全体
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
