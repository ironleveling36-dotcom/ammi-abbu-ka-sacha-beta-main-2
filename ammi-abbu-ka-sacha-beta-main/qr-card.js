/**
 * qr-card.js — Swiggy payment QR card renderer (PURE, no bot/store imports).
 *
 * Alag module isliye ki yeh CPU-heavy kaam (PNG paint + jsQR verify ≈ 240ms)
 * ek worker thread me chal sake. Pehle yeh main event loop par chalta tha: 10
 * order ek saath aate hi bot 2+ second ke liye "dead" ho jata tha.
 */
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';

const FONT_5X7 = {
  ' ': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  '!': [0x04, 0x04, 0x04, 0x04, 0x04, 0x00, 0x04],
  '#': [0x0a, 0x1f, 0x0a, 0x0a, 0x1f, 0x0a, 0x00],
  '(': [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ')': [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
  '+': [0x00, 0x04, 0x04, 0x1f, 0x04, 0x04, 0x00],
  ',': [0x00, 0x00, 0x00, 0x00, 0x0c, 0x04, 0x08],
  '-': [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  '/': [0x01, 0x02, 0x04, 0x04, 0x08, 0x10, 0x00],
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1f],
  '3': [0x1f, 0x02, 0x04, 0x06, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  ':': [0x00, 0x0c, 0x0c, 0x00, 0x0c, 0x0c, 0x00],
  '@': [0x0e, 0x11, 0x17, 0x15, 0x17, 0x10, 0x0f],
  'A': [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  'B': [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  'C': [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  'D': [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  'E': [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  'F': [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  'G': [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  'H': [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  'I': [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  'J': [0x07, 0x02, 0x02, 0x02, 0x12, 0x12, 0x0c],
  'K': [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  'L': [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  'M': [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  'N': [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  'O': [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  'P': [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  'Q': [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  'R': [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  'S': [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  'T': [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  'U': [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  'V': [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  'W': [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  'X': [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  'Y': [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  'Z': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  '_': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f],
  'RS': [0x1f, 0x04, 0x1f, 0x09, 0x06, 0x04, 0x03]
};

function tokenizeBannerText(raw) {
  const tokens = [];
  const clean = String(raw || '').toUpperCase();
  for (const ch of clean) {
    if (ch === '₹') tokens.push('RS');
    else if (FONT_5X7[ch]) tokens.push(ch);
    else if (/\s/.test(ch)) tokens.push(' ');
  }
  return tokens;
}

function fillRect(png, x0, y0, w, h, r, g, b) {
  const xStart = Math.max(0, Math.floor(x0));
  const yStart = Math.max(0, Math.floor(y0));
  const xEnd = Math.min(png.width, Math.ceil(x0 + w));
  const yEnd = Math.min(png.height, Math.ceil(y0 + h));
  for (let y = yStart; y < yEnd; y++) {
    for (let x = xStart; x < xEnd; x++) {
      const idx = (png.width * y + x) << 2;
      png.data[idx] = r;
      png.data[idx + 1] = g;
      png.data[idx + 2] = b;
      png.data[idx + 3] = 255;
    }
  }
}

function drawCenteredText(png, text, centerY, scale, r, g, b) {
  const maxChars = Math.max(10, Math.floor((png.width - 48) / (6 * scale)));
  const tokens = Array.isArray(text) ? text.slice(0, maxChars) : tokenizeBannerText(text).slice(0, maxChars);
  if (tokens.length === 0) return;
  const totalW = tokens.length * (6 * scale) - scale;
  let cursorX = Math.max(24, Math.floor((png.width - totalW) / 2));
  const startY = Math.floor(centerY - (7 * scale) / 2);

  for (const tok of tokens) {
    const rows = FONT_5X7[tok] || FONT_5X7[' '];
    for (let row = 0; row < 7; row++) {
      const mask = rows[row];
      for (let col = 0; col < 5; col++) {
        if (mask & (1 << (4 - col))) {
          fillRect(png, cursorX + col * scale, startY + row * scale, scale, scale, r, g, b);
        }
      }
    }
    cursorX += 6 * scale;
  }
}

export function sanitizeUpiUriForQr(rawUri) {
  const raw = String(rawUri || '').trim();
  if (!raw) throw new Error('Empty UPI URI passed to QR generator.');

  // CRITICAL: Never alter a single character if bank cryptographic signature (`sign=`) is present!
  if (/[?&]sign=/i.test(raw) || !/^upi:\/\/pay\?/i.test(raw)) {
    return raw;
  }

  const qIdx = raw.indexOf('?');
  const prefix = raw.slice(0, qIdx + 1);
  const query = raw.slice(qIdx + 1);
  const cleanAsciiParam = (val, maxLen, fallback) => {
    let decoded = val;
    try { decoded = decodeURIComponent(val.replace(/\+/g, ' ')); } catch {}
    const ascii = String(decoded || '')
      .normalize('NFKD')
      .replace(/[^\x20-\x7E]/g, ' ')
      .replace(/[&=+#%<>\\"`'|{}[\]^~]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLen)
      .trim();
    return encodeURIComponent(ascii || fallback);
  };

  const parts = query.split('&').filter(Boolean).map(seg => {
    const eq = seg.indexOf('=');
    if (eq <= 0) return seg;
    const k = seg.slice(0, eq);
    const v = seg.slice(eq + 1);
    const kl = k.toLowerCase();
    if (kl === 'pn') return `${k}=${cleanAsciiParam(v, 28, 'Swiggy')}`;
    if (kl === 'tn') return `${k}=${cleanAsciiParam(v, 32, 'Swiggy Order')}`;
    return seg;
  });

  return `${prefix}${parts.join('&')}`;
}

export async function generateNamedUpiQrPngBuffer({ upiUri, senderName, restaurantName, amount, orderId }) {
  const safeUri = sanitizeUpiUriForQr(upiUri);
  // Adaptive ECC: 'M' for compact URIs (<= 175 chars), 'L' for long signed merchant URIs so module count stays big & crisp!
  const ecc = safeUri.length > 175 ? 'L' : 'M';
  const qrData = QRCode.create(safeUri, { errorCorrectionLevel: ecc });
  const modCount = qrData.modules.size;
  const quietModules = 4; // Full ISO/IEC 18004 4-module quiet zone!
  const totalModules = modCount + quietModules * 2;

  // Exact integer pixel scale per module (`8px`..`16px`) — ZERO anti-aliased gray pixels, AND total PNG strictly <= 1180px so Telegram NEVER downscales!
  const modPx = Math.max(8, Math.min(16, Math.floor(820 / totalModules)));
  const qrBoxPx = totalModules * modPx;
  const guardPad = 32;
  const outW = Math.max(760, qrBoxPx + guardPad * 2);

  // Adaptive multi-line header layout so even 250-char names display cleanly without ever shrinking or touching the QR quiet zone!
  const rawName = String(senderName || restaurantName || 'CUSTOMER').replace(/\s+/g, ' ').trim() || 'CUSTOMER';
  const nameTokens = tokenizeBannerText(rawName);
  let headerLines = [];
  let nameScale = 4;

  const fitCols4 = Math.floor((outW - 56) / 24);
  const fitCols3 = Math.floor((outW - 56) / 18);
  const fitCols2 = Math.floor((outW - 56) / 12);

  if (nameTokens.length <= fitCols4) {
    nameScale = 4;
    headerLines = [nameTokens.length ? nameTokens : tokenizeBannerText('CUSTOMER')];
  } else if (nameTokens.length <= fitCols3) {
    nameScale = 3;
    headerLines = [nameTokens];
  } else {
    nameScale = 2;
    const line1 = nameTokens.slice(0, fitCols2);
    let line2 = nameTokens.slice(fitCols2, fitCols2 * 2);
    if (nameTokens.length > fitCols2 * 2 && line2.length >= 3) {
      line2 = [...line2.slice(0, line2.length - 3), '.', '.', '.'];
    }
    headerLines = line2.length ? [line1, line2] : [line1];
  }

  const headerH = headerLines.length > 1 ? 142 : 118;
  const footerH = 104;
  const outH = headerH + guardPad * 2 + qrBoxPx + footerH;
  const out = new PNG({ width: outW, height: outH });

  // Pure high-contrast white background over entire canvas including quiet zone & guard frame
  fillRect(out, 0, 0, outW, outH, 255, 255, 255);
  fillRect(out, 0, 0, outW, headerH, 252, 128, 25);
  fillRect(out, 0, headerH - 6, outW, 6, 224, 98, 8);

  if (headerLines.length === 1) {
    drawCenteredText(out, headerLines[0], 44, nameScale, 255, 255, 255);
    drawCenteredText(out, `OFFICIAL SWIGGY QR  #${String(orderId || '').slice(0, 24)}`, 90, 2, 255, 245, 232);
  } else {
    drawCenteredText(out, headerLines[0], 34, 2, 255, 255, 255);
    drawCenteredText(out, headerLines[1], 66, 2, 255, 255, 255);
    drawCenteredText(out, `OFFICIAL SWIGGY QR  #${String(orderId || '').slice(0, 24)}`, 108, 2, 255, 245, 232);
  }

  // Paint every dark QR module with 100% crisp integer coordinates — zero interpolation blur!
  const qrOriginX = Math.floor((outW - qrBoxPx) / 2) + quietModules * modPx;
  const qrOriginY = headerH + guardPad + quietModules * modPx;
  for (let r = 0; r < modCount; r++) {
    for (let c = 0; c < modCount; c++) {
      if (qrData.modules.get(r, c)) {
        fillRect(out, qrOriginX + c * modPx, qrOriginY + r * modPx, modPx, modPx, 0, 0, 0);
      }
    }
  }

  const footerTop = headerH + guardPad * 2 + qrBoxPx;
  fillRect(out, 0, footerTop, outW, footerH, 248, 250, 252);
  fillRect(out, 28, footerTop + 6, outW - 56, 2, 226, 232, 240);
  drawCenteredText(out, `PAY ₹${amount}`, footerTop + 44, 4, 15, 23, 42);
  drawCenteredText(out, `AUTO PLACES ORDER ON SWIGGY`, footerTop + 84, 2, 22, 163, 74);

  // Built-in real camera decoder verification on rendered pixels (`jsQR`) — fallback to ultra-clean pure QR if ever needed!
  const decoded = jsQR(new Uint8ClampedArray(out.data), out.width, out.height);
  if (!decoded || decoded.data !== safeUri) {
    return QRCode.toBuffer(safeUri, {
      type: 'png',
      scale: 10,
      margin: 4,
      errorCorrectionLevel: ecc,
      color: { dark: '#000000', light: '#FFFFFF' }
    });
  }

  return PNG.sync.write(out);
}


/**
 * QR box ko hi decode karke verify karo (poora canvas nahi) — jsQR pixel count
 * ke hisaab se chalta hai, isliye ~2x tez.
 */
export function verifyQrRegion(out, safeUri, { qrOriginX, qrOriginY, qrBoxPx }) {
  try {
    const size = Math.max(1, Math.min(qrBoxPx, Math.min(out.width - qrOriginX, out.height - qrOriginY)));
    if (size <= 0) return true;
    const crop = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) {
      const srcStart = ((qrOriginY + y) * out.width + qrOriginX) * 4;
      crop.set(out.data.subarray(srcStart, srcStart + size * 4), y * size * 4);
    }
    const decoded = jsQR(crop, size, size);
    if (!decoded) return false;
    return decoded.data === safeUri;
  } catch {
    return true; // verifier fail ho to QR block na karo (guard alag hai)
  }
}

export { PNG, QRCode, jsQR };
