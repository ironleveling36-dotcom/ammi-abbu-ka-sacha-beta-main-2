import { getDb } from './store.js';

(async () => {
  const db = getDb();
  for (const [key, acc] of Object.entries(db.config.accounts)) {
    console.log(`\n--- Testing Account: ${key} (${acc.phone}) ---`);
    if (!acc.cookies) {
      console.log('No cookies');
      continue;
    }
    try {
      const res = await fetch('https://www.swiggy.com/dapi/cart', {
        headers: {
          'Cookie': acc.cookies,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Referer': 'https://www.swiggy.com/checkout'
        }
      });
      console.log('Status:', res.status);
      const json = await res.json();
      console.log('Cart Response:', JSON.stringify(json, null, 2).slice(0, 1500));
    } catch (err) {
      console.error('Error:', err.message);
    }
  }
})();
