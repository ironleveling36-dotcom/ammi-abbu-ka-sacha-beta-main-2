// ============================================================================
// boss-mirror.js — Real-Time Customer Message & QR Mirror to Boss
// ============================================================================
// Guarantees that the Boss has 100% full visibility into all communications sent
// to customers by the bot:
//   1. Every payment QR code / screenshot / photo delivered to any customer is
//      immediately mirrored to all configured Bosses with customer & order context.
//   2. Every text message (bill summary, tracking URL, OTP request, confirmation)
//      delivered to any customer is mirrored to all Bosses in real-time.
//   3. Strictly prevents infinite loops: messages sent to Bosses are never mirrored.
//   4. Completely asynchronous & error-isolated: never delays or blocks customer delivery.

import { getDb, isBoss } from './store.js';

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeTelegramCaption(htmlText, maxLen = 1000) {
  const str = String(htmlText || '');
  if (str.length <= maxLen) return str;
  const plain = str
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
  return `${plain.slice(0, maxLen - 4).trim()}...`;
}

/**
 * Installs transparent mirroring on Telegraf's telegram transport so any photo (QR)
 * or message delivered to any customer is automatically mirrored to all Bosses.
 */
export function installBossMirror(bot) {
  if (!bot?.telegram || bot.telegram.__bossMirrorInstalled) return bot;
  bot.telegram.__bossMirrorInstalled = true;

  const underlyingCallApi = bot.telegram.callApi.bind(bot.telegram);
  bot.telegram.__rawCallApi = underlyingCallApi;

  const rawCallApi = (method, payload, callOpts) => {
    const fn = (bot.telegram && bot.telegram.__rawCallApi && bot.telegram.__rawCallApi !== bot.telegram.callApi) ? bot.telegram.__rawCallApi : underlyingCallApi;
    return fn(method, payload, callOpts);
  };

  bot.telegram.callApi = async function mirroredCallApi(method, payload, callOpts = {}) {
    // 1. Execute the primary Telegram API call first
    const result = await rawCallApi(method, payload, callOpts);

    // 2. Perform mirroring if applicable
    try {
      // Guard: never mirror recursive calls or non-customer targets
      if (callOpts?.__isBossMirror) return result;
      if (method !== 'sendPhoto' && method !== 'sendMessage') return result;

      const targetChatId = payload?.chat_id;
      if (!targetChatId) return result;

      // Do not mirror if recipient is already a Boss (avoids loops & duplication)
      if (isBoss(targetChatId)) return result;

      const db = getDb();
      const bossIds = [...new Set((db?.config?.bossIds || []).map(String).filter(Boolean))];
      if (bossIds.length === 0) return result;

      // Context gathering: find customer and active order
      const userObj = db?.users?.[String(targetChatId)] || db?.users?.[Number(targetChatId)];
      const userOrders = Object.values(db?.orders || {}).filter(
        o => String(o.userId) === String(targetChatId) || String(o.userChatId) === String(targetChatId)
      );
      const activeOrder = userOrders.find(
        o => o.status !== 'CANCELLED' && o.status !== 'COMPLETED' && o.status !== 'REJECTED'
      ) || userOrders[userOrders.length - 1];

      const userName = userObj?.first_name || activeOrder?.userName || 'Customer';
      const userProfileUrl = `tg://user?id=${targetChatId}`;
      const userLink = `<a href="${userProfileUrl}">${escapeHtml(userName)}</a> (ID: <code>${targetChatId}</code>)`;
      const orderTag = activeOrder ? ` · <b>Order #${activeOrder.id}</b>` : '';

      if (method === 'sendPhoto') {
        // Extract file_id from Telegram's response for 0-bandwidth instant mirror
        const fileId = result?.photo?.[result.photo.length - 1]?.file_id || payload?.photo;
        if (fileId) {
          const originalCaption = payload?.caption || '';
          const header = `📤 <b>[BOT ➔ USER QR / PHOTO]</b>\n👤 <b>To:</b> ${userLink}${orderTag}\n\n`;
          const caption = safeTelegramCaption(
            header + (originalCaption ? `<b>Caption:</b>\n${originalCaption}` : '<i>QR code delivered to customer</i>'),
            1000
          );

          setImmediate(async () => {
            for (const bossId of bossIds) {
              try {
                await rawCallApi(
                  'sendPhoto',
                  {
                    chat_id: bossId,
                    photo: fileId,
                    caption,
                    parse_mode: 'HTML'
                  },
                  { __isBossMirror: true }
                );
              } catch (err) {
                // If cross-chat file_id fails, fallback to original buffer source if present
                if (payload?.photo && typeof payload.photo === 'object' && payload.photo.source) {
                  try {
                    await rawCallApi(
                      'sendPhoto',
                      {
                        chat_id: bossId,
                        photo: payload.photo,
                        caption,
                        parse_mode: 'HTML'
                      },
                      { __isBossMirror: true }
                    );
                  } catch {}
                }
              }
            }
          });
        }
      } else if (method === 'sendMessage') {
        const text = String(payload?.text || '');
        if (text) {
          const header = `📤 <b>[BOT ➔ USER MESSAGE]</b>\n👤 <b>To:</b> ${userLink}${orderTag}\n\n`;
          const isHtml = payload?.parse_mode === 'HTML';
          const formattedBody = isHtml ? text : escapeHtml(text);
          const fullText = header + formattedBody;
          const safeText = fullText.length > 3900 ? fullText.slice(0, 3900) + '…' : fullText;

          setImmediate(async () => {
            for (const bossId of bossIds) {
              try {
                await rawCallApi(
                  'sendMessage',
                  {
                    chat_id: bossId,
                    text: safeText,
                    parse_mode: 'HTML',
                    link_preview_options: { is_disabled: true }
                  },
                  { __isBossMirror: true }
                );
              } catch (e) {}
            }
          });
        }
      }
    } catch (err) {
      console.warn('[BossMirror] Non-fatal error during customer message mirroring:', err.message);
    }

    return result;
  };

  return bot;
}
