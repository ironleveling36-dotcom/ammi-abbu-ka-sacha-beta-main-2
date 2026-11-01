import { getDb } from './store.js';
import { verifyAndInspectSwiggyLink } from './swiggy-cart.js';

(async () => {
  const db = getDb();
  const testUrl = 'https://swig.gy/gc/803172/Umbashiya-442849410';
  console.log('Testing verifyAndInspectSwiggyLink with Abbu account...');
  const res = await verifyAndInspectSwiggyLink(testUrl, db.config.accounts.abbu.cookies);
  console.log('VERIFY RESULT:\n', JSON.stringify(res, null, 2));
})();
