import { normalizeIndianMobileNumber } from './phone-utils.js';

// Never round a fractional paisa or treat a missing amount as zero.
export function exactPaise(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const amount = Number(value), paise = Math.round(amount * 100);
  return Number.isFinite(amount) && Number.isSafeInteger(paise) && Math.abs(amount * 100 - paise) < 1e-6 ? paise : null;
}

// Compare provider cart items without silently dropping variants or add-ons.
export function sameCartItems(expected, actual) {
  const makeSignature = (item) => {
    const id = String(item?.menu_item_id || item?.itemId || item?.id || '');
    if (!/^\d+$/.test(id)) return null;
    const choices = (list, choiceKeys) => {
      if (!Array.isArray(list)) return null;
      const output = [];
      for (const choice of list) {
        const group = String(choice?.group_id ?? choice?.groupId ?? '');
        const choiceId = String(choiceKeys.map(key => choice?.[key]).find(v => v !== undefined && v !== null) ?? '');
        if (!group || !choiceId) return null;
        output.push(`${group}:${choiceId}`);
      }
      return output.sort();
    };
    const variants = choices(item.variants || [], ['variation_id', 'variationId', 'id']);
    const addons = choices(item.addons || [], ['choice_id', 'choiceId', 'id']);
    if (!variants || !addons) return null;
    return JSON.stringify([id, variants, addons]);
  };
  const aggregate = (list) => {
    if (!Array.isArray(list) || !list.length) return null;
    const result = new Map();
    for (const item of list) {
      const signature = makeSignature(item);
      const quantity = Number(item.qty ?? item.quantity);
      if (!signature || !Number.isInteger(quantity) || quantity <= 0) return null;
      result.set(signature, (result.get(signature) || 0) + quantity);
    }
    return result;
  };
  const left = aggregate(expected), right = aggregate(actual);
  return Boolean(left && right && left.size === right.size && [...left].every(([key, qty]) => right.get(key) === qty));
}


function validIndianCoordinates(lat, lng) {
  const a = Number(lat), b = Number(lng);
  return Number.isFinite(a) && Number.isFinite(b) && a >= 5.5 && a <= 38.5 && b >= 67 && b <= 99;
}

export function sameDeliveryRecipient(expected, saved) {
  const expectedPhone = normalizeIndianMobileNumber(expected?.mobile || '');
  const savedPhone = normalizeIndianMobileNumber(saved?.mobile || '');
  const normalizeText = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (!expectedPhone || expectedPhone !== savedPhone || !normalizeText(expected?.name) || normalizeText(expected.name) !== normalizeText(saved?.name)) return false;
  if (!normalizeText(expected?.address) || normalizeText(expected.address) !== normalizeText(saved?.address)) return false;
  if (!validIndianCoordinates(expected?.lat, expected?.lng) || !validIndianCoordinates(saved?.lat, saved?.lng)) return false;
  const toRad = n => n * Math.PI / 180;
  const lat1 = Number(expected.lat), lat2 = Number(saved.lat);
  const dLat = toRad(lat2 - lat1), dLng = toRad(Number(saved.lng) - Number(expected.lng));
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(Math.min(1, a))) <= 35;
}
