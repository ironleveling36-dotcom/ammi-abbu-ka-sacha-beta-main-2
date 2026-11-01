import './network-shield.js';
import assert from 'assert';
import fs from 'fs';
import { getDb } from './store.js';
import { buildBossPanelHome } from './boss-panel.js';

console.log('› Testing V22: Orders Done (All IDs) button and tracking links...');

// Check 1: Boss Panel inline keyboard contains Orders Done button
const db = getDb();
const home = buildBossPanelHome(db);
const flatButtons = home.keyboard.reply_markup.inline_keyboard.flat();
const ordersDoneBtn = flatButtons.find(b => b.callback_data === 'boss_view_orders_done');

assert(ordersDoneBtn, 'boss_view_orders_done callback button must be present in Boss Panel home');
console.log('✅ Boss Panel home inline keyboard has "📦 Orders Done" button');
assert(/Orders Done/i.test(ordersDoneBtn.text), 'Button text should contain "Orders Done"');
console.log(`✅ Button label is "${ordersDoneBtn.text}"`);

// Check 2: Verify index.js wiring for Orders Done
const indexSrc = fs.readFileSync('index.js', 'utf8');

assert(indexSrc.includes('handleAllOrdersDone'), 'index.js must define handleAllOrdersDone function');
console.log('✅ handleAllOrdersDone function defined in index.js');

assert(indexSrc.includes('boss_view_orders_done'), 'index.js must register boss_view_orders_done action');
console.log('✅ boss_view_orders_done action registered');

assert(indexSrc.includes("'📦 Orders Done'"), 'index.js must include 📦 Orders Done in bot.hears and reply keyboards');
console.log('✅ 📦 Orders Done registered in reply keyboards and bot.hears');

assert(indexSrc.includes('• 🔗 <b>Tracking Link:</b>'), 'index.js must display Tracking Link in front of each order');
console.log('✅ Tracking link rendered in front of each order in message text');

console.log('\n================================================================');
console.log('📊 RESULT: 5/5 V22 Orders Done checks passed successfully!');
console.log('================================================================');
