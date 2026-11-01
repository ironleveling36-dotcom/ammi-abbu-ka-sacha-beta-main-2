import { getDb } from './store.js';
import { extractRealSwiggyTracking } from './swiggy-cart.js';

(async () => {
  const db = getDb();
  for (const [key, acc] of Object.entries(db.config.accounts)) {
    console.log(`Checking tracking for account ${key}...`);
    const track = await extractRealSwiggyTracking(acc.cookies, 'TEST_ORDER_123');
    console.log(`Account ${key} tracking:`, track);
  }
})();
