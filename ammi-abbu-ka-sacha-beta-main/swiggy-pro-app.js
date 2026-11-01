/* Mini App client. All identity and account selection are verified server-side. */
(() => {
  'use strict';
  const tg = window.Telegram?.WebApp;
  try { tg?.ready(); tg?.expand(); } catch {}
  const initData = tg?.initData || '';
  const state = {
    tab: 'accounts', auth: false, authError: '', authErrorCode: '', connecting: false, user: null, accounts: [], activeAccount: null,
    selectedAddress: null, addresses: [], addressNote: '', pendingAddress: null, contactEdit: false, addressesLoading: false,
    cart: null, checkout: null, checkoutEnabled: false, mode: 'phone', otpSent: false, searchQuery: '', results: null, menu: null,
    menuLoading: false, menuQuery: '', orders: null, ordersScope: 'active', order: null, orderTracking: null, orderLinkLoading: false, ordersLoading: false, ordersDetailAllowed: true,
    cachedAccounts: [], busy: false, loading: 0, resultsLoading: false, deleteFlow: null, claimBusyKey: '', claimResult: null, couponOpen: false,
    outlets: null, outletsOpen: false, outletsLoading: false, backup: null, backupBusy: false,
    coupons: null, couponsNote: '', couponsError: '', couponsLoading: false, couponBusy: '', couponView: false, couponResults: {}, ordersFilter: 'all', accountQuery: '', accountFilters: [], payWindow: null, payTicks: 0, payExpired: false, shareNote: '',
    meal: null, mealFor: '', mealLoading: false, couponDraft: '', groupCartDraft: '', groupCartOn: true,
    track: null, trackData: null, trackError: '', trackBusy: false,
    orderFee: null, checkoutWarning: '',
    chatHandoff: null, handoffHidden: false, handoffIgnorePending: '', handoffBusy: false, handoffError: '', handoffAutoFor: '', handoffName: null, handoffMobile: null,
    doctor: null, doctorBusy: false, doctorNote: '', access: null, accessUser: '', accessLoading: false,
    // Boss (31-10-2026, round 13): 2 minute idle → draft order band.
    idle: null, idleClosed: null
  };
  // Boss (31-10-2026): "ME KOI CHEEZ UPDATE KARU TO SAARA USER KA DATA RESET NA
  // HOJAYE, BAAKI RAHE UNKE PHONES ME." UI ka safe hissa (tab, theme, pehle
  // dikhe ID ke naam, search text) phone par rehta hai. Server hi asli source
  // hai; cache sirf itna batata hai ki pehle kya tha — koi secret nahi.
  const CACHE_KEY = 'pro-state-v2';
  function readCache() {
    try { const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); return raw && raw.version === 2 ? raw : {}; } catch { return {}; }
  }
  function writeCache(patch) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ...readCache(), ...patch, version: 2, savedAt: new Date().toISOString() })); } catch {}
  }
  let mealRequestVersion = 0;
  let couponRequestVersion = 0;
  let couponWriteVersion = 0;
  function locationContext() {
    const a = state.selectedAddress;
    return JSON.stringify([state.activeAccount?.key || '', a?.id || '', a?.address || '', String(a?.lat || ''), String(a?.lng || '')]);
  }
  function cartSourceContext() {
    return JSON.stringify([locationContext(), String(state.cart?.restaurantId || '')]);
  }
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
  const money = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? `₹${Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—';
  function playLoader(label = 'Loading', size = '') {
    return `<span class="play-loader${size ? ' ' + size : ''}" role="status" aria-label="${esc(label)}"><svg viewBox="0 0 48 48" aria-hidden="true" focusable="false"><circle class="play-loader-track" cx="24" cy="24" r="20"></circle><circle class="play-loader-arc" cx="24" cy="24" r="20"></circle></svg><span class="sr-only">${esc(label)}</span></span>`;
  }
  function couponSaving(q) {
    if (!q) return 0;
    if (Number(q.discount) > 0) return Number(q.discount);
    return q.discountAlreadyApplied === true ? Math.max(0, Number(q.couponSaving || 0)) : 0;
  }
  function couponBadge(c) {
    const text = `${c?.title || ''} ${c?.description || ''}`;
    const pct = text.match(/(\d{1,3})\s*%/);
    if (pct) return `<b>${esc(pct[1])}%</b><small>OFF</small>`;
    const flat = text.match(/(?:₹|rs\.?|inr)\s*(\d[\d,]*(?:\.\d{1,2})?)/i) || text.match(/(\d[\d,]*(?:\.\d{1,2})?)\s*(?:₹|rs\.?|inr|off)/i);
    if (flat) return `<b>${money(Number(String(flat[1]).replace(/,/g, '')))}</b><small>OFF</small>`;
    return `<b>DEAL</b>`;
  }

  const iconPaths = {
    accounts:'<path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="8" r="4"/>',
    address:'<path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
    search:'<circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 4 4"/>',
    cart:'<path d="M3 4h2l2 11h11l2-8H6"/><circle cx="9" cy="20" r="1"/><circle cx="17" cy="20" r="1"/>',
    orders:'<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
    tools:'<path d="m13 2-8 12h6l-1 8 9-12h-6z"/>',
    link:'<path d="M10 13a5 5 0 0 0 7 .4l2-2a5 5 0 0 0-7-7l-1.2 1.1"/><path d="M14 11a5 5 0 0 0-7-.4l-2 2a5 5 0 0 0 7 7l1.2-1.1"/>',
    refresh:'<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5 9a7 7 0 0 1 12-2l3 5M4 12l3 5a7 7 0 0 0 12-2"/>',
    arrow:'<path d="M5 12h14M14 7l5 5-5 5"/>',
    back:'<path d="M19 12H5M10 7l-5 5 5 5"/>',
    plus:'<path d="M12 5v14M5 12h14"/>',
    close:'<path d="M18 6 6 18M6 6l12 12"/>',
    trash:'<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    check:'<path d="m5 12 4 4L19 6"/>',
    store:'<path d="M4 10v10h16V10M3 8l2-5h14l2 5-2 3-3-2-4 2-4-2-3 2zM9 20v-6h6v6"/>',
    moon:'<path d="M20.7 14a8 8 0 0 1-10.7-10.7A8.5 8.5 0 1 0 20.7 14Z"/>',
    sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M19 5l-1.4 1.4M6.4 17.6 5 19"/>',
    receipt:'<path d="M5 3h14v18l-2-1-2 1-3-1-3 1-2-1-2 1zM8 8h8M8 12h8M8 16h5"/>',
    userplus:'<path d="M16 21a7 7 0 0 0-14 0"/><circle cx="9" cy="8" r="4"/><path d="M19 8v6M16 11h6"/>',
    alert:'<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
    spark:'<path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M18 15.5 18.8 18l2.5.8-2.5.8L18 22l-.8-2.4-2.5-.8 2.5-.8z"/>',
    phone:'<rect x="6.5" y="2.5" width="11" height="19" rx="2.6"/><path d="M10.5 18.6h3"/>',
    code:'<path d="m9 7.5-4.5 4.5L9 16.5M15 7.5l4.5 4.5L15 16.5"/>',
    send:'<path d="M21.4 3.2 2.9 10.1l6.7 2.5 2.4 6.7z"/><path d="M21.4 3.2 9.6 12.6"/>',
    copy:'<rect x="8.5" y="8.5" width="12" height="11.5" rx="2.4"/><path d="M15.5 8.5V6.2a2 2 0 0 0-2-2H5.9a2 2 0 0 0-2 2v7.4a2 2 0 0 0 2 2h2.6"/>',
    used:'<path d="M4.5 7.5h15v11h-15z"/><path d="M8.5 7.5v-2h7v2"/><path d="m9 13 2 2 4-4"/>',
    coins:'<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>'
  };
  const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${iconPaths[name] || ''}</svg>`;
  const tile = (name, green = false) => `<span class="icon-tile${green ? ' green' : ''}">${icon(name)}</span>`;
  const cartLocked = () => Boolean(state.checkout && state.checkout.status !== 'PAID');
  const head = (eyebrow, title, sub, end = '') => `<div class="page-heading"><div>${eyebrow ? `<span class="page-eyebrow">${esc(eyebrow)}</span>` : ''}<h1>${esc(title)}</h1>${String(sub || '').startsWith('Swiggy order #') ? `<p>${esc(sub)}</p>` : ''}</div>${end}</div>`;
  const empty = (symbol, title, text) => `<div class="empty"><div class="large-icon">${icon(symbol)}</div><strong>${esc(title)}</strong>${esc(text)}</div>`;
  /**
   * Round 27 (boss): toast ab Swiggy jaisa — upar se drop, icon ke saath, aur
   * rang sach ke hisaab se (kaam hua = hara, nahi hua = laal). Type na diya
   * jaye to message se pata lagta hai, par jahan pakka pata ho wahan type do.
   */
  const toast = (message, type = '') => {
    // Telegram WebView band hone ke baad bhi async response aa sakta hai.
    try {
      const el = $('#toast');
      if (!el) return;
      const text = String(message ?? '');
      // Type guess nahi karte — jahan pakka pata ho wahin 'ok'/'bad' bhejte
      // hain, warna neutral 'info'. Isse jhootha hara tick kabhi nahi aata.
      const kind = type === 'ok' || type === 'bad' ? type : 'info';
      el.className = `toast-${kind}`;
      const glyph = kind === 'bad' ? '!' : kind === 'ok' ? '\u2713' : 'i';
      el.innerHTML = `<span class="toast-icon" aria-hidden="true">${glyph}</span><span class="toast-copy"></span>`;
      const copy = el.querySelector('.toast-copy');
      if (copy) copy.textContent = text; else el.textContent = text;
      el.hidden = false;
      // Dobara same message par animation phir se chale.
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = '';
      clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.hidden = true; }, 4300);
    } catch { /* window band ho gaya */ }
  };
  // Tests aur manual debug ke liye — behaviour badalta nahi.
  try { window.__appToast = toast; } catch { /* no window */ }
  // Browser confirm() can be blocked in Telegram WebViews. Keep every consent
  // inside the Mini App, preserve the full recipient/amount text, and default
  // to cancellation on dismissal. Only one prompt can be open at a time.
  let confirmationOpen = false;
  // Dialogs live beside the app shell. Preserve any existing inert state so a
  // confirmation on top of a sheet restores the sheet, not the page behind it.
  function lockModalBackground(overlay) {
    const saved = Array.from(document.body.children)
      .filter(el => el !== overlay && !/^(SCRIPT|STYLE|LINK)$/.test(el.tagName))
      .map(el => ({ el, inert: el.hasAttribute('inert'), aria: el.getAttribute('aria-hidden') }));
    for (const { el } of saved) { el.setAttribute('inert', ''); el.setAttribute('aria-hidden', 'true'); }
    return () => {
      for (const { el, inert, aria } of saved) {
        if (!el.isConnected) continue;
        if (!inert) el.removeAttribute('inert');
        if (aria === null) el.removeAttribute('aria-hidden'); else el.setAttribute('aria-hidden', aria);
      }
    };
  }
  function restoreDialogFocus(el, identity = null) {
    // A background response may have repainted the original trigger while the
    // dialog was open; find its equivalent in the current view in that case.
    if (!el?.isConnected) { if (identity) restoreFocus(document, identity); return; }
    if (el.closest('[inert], [hidden]') || typeof el.focus !== 'function') return;
    // run() temporarily disables its triggering button until the task settles.
    if (el.disabled && el.dataset.busy === '1') { el.dataset.dialogReturnFocus = '1'; return; }
    if (el.disabled) return;
    try { el.focus({ preventScroll: true }); } catch { el.focus(); }
  }
  function confirmInApp({ title, message, confirmText = 'Continue', danger = false, choices = null, opener = null }) {
    if (confirmationOpen) return Promise.resolve(false);
    confirmationOpen = true;
    return new Promise(resolve => {
      const previousFocus = opener || document.activeElement;
      const previousIdentity = describeFocus(previousFocus);
      const overlay = document.createElement('div');
      overlay.className = 'confirm-overlay';
      const dialog = document.createElement('section');
      dialog.className = 'confirm-dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'confirm-title');
      dialog.setAttribute('aria-describedby', 'confirm-message');
      const heading = document.createElement('h2');
      heading.id = 'confirm-title';
      heading.textContent = title;
      const body = document.createElement('p');
      body.id = 'confirm-message';
      body.className = 'confirm-message';
      body.textContent = message;
      const actions = document.createElement('div');
      actions.className = 'confirm-actions';
      const cancel = document.createElement('button');
      cancel.type = 'button'; cancel.className = 'button soft'; cancel.textContent = 'Cancel';
      actions.append(cancel);
      // Delete jaise case me do-teen asli option (boss 31-10-2026).
      const optionButtons = Array.isArray(choices) && choices.length
        ? choices.map(choice => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `button ${choice.danger ? 'danger' : 'primary'}`;
            btn.textContent = choice.label;
            btn.dataset.choice = choice.id;
            actions.append(btn);
            return btn;
          })
        : [];
      const confirm = document.createElement('button');
      confirm.type = 'button'; confirm.className = `button ${danger ? 'danger' : 'primary'}`; confirm.textContent = confirmText;
      if (!optionButtons.length) actions.append(confirm);
      dialog.append(heading, body, actions);
      overlay.append(dialog);
      let settled = false;
      let unlockBackground = () => {};
      const finish = approved => {
        if (settled) return;
        settled = true;
        confirmationOpen = false;
        document.removeEventListener('keydown', onKeyDown);
        overlay.remove();
        unlockBackground();
        restoreDialogFocus(previousFocus, previousIdentity);
        resolve(approved);
      };
      const onKeyDown = event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); }
        if (event.key === 'Tab') {
          const order = [cancel, ...optionButtons, ...(optionButtons.length ? [] : [confirm])];
          const at = order.indexOf(document.activeElement);
          event.preventDefault();
          const next = at === -1 ? (event.shiftKey ? order.at(-1) : order[0])
            : event.shiftKey ? (at === 0 ? order.at(-1) : order[at - 1]) : (at === order.length - 1 ? order[0] : order[at + 1]);
          next.focus();
        }
      };
      cancel.addEventListener('click', () => finish(false));
      confirm.addEventListener('click', () => finish(true));
      for (const btn of optionButtons) btn.addEventListener('click', () => finish(btn.dataset.choice));
      overlay.addEventListener('click', event => { if (event.target === overlay) finish(false); });
      document.addEventListener('keydown', onKeyDown);
      document.body.append(overlay);
      try { cancel.focus({ preventScroll: true }); } catch { cancel.focus(); }
      unlockBackground = lockModalBackground(overlay);
    });
  }
  async function api(path, method = 'GET', body) {
    if (!initData) throw new Error('Open the Mini App from your bot in Telegram.');
    const headers = { 'X-Telegram-Init-Data': initData };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch('/pro/api/' + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      const e = new Error(result.error || 'Request failed. Please try again.');
      e.status = response.status; e.code = String(result.code || '');
      throw e;
    }
    return result;
  }
  function merge(data) {
    const previousLocation = locationContext();
    const previousCartSource = cartSourceContext();
    for (const key of ['user','accounts','activeAccount','selectedAddress','cart','checkout','checkoutEnabled','checkoutBlockReason','ordersDetailAllowed','adminContact','backup','orderFee','identities','liveOrder','durability','chatHandoff']) if (Object.hasOwn(data, key)) state[key] = data[key];
    if (previousLocation !== locationContext()) {
      // Results are tied to a specific account and delivery location.
      state.results = null; state.menu = null; state.menuQuery = '';
      state.autoBillFor = '';
    }
    if (previousCartSource !== cartSourceContext()) {
      // Old account/location/restaurant responses must not supply coupons or
      // meal suggestions to a newly selected cart.
      mealRequestVersion++; couponRequestVersion++; couponWriteVersion++;
      state.meal = null; state.mealFor = ''; state.mealLoading = false;
      state.coupons = null; state.couponsNote = ''; state.couponsLoading = false; state.autoCouponsFor = ''; state.couponResults = {}; state.couponBusy = '';
    }
    if (data.idle) { state.idle = data.idle; if (data.idle.closed) state.idleClosed = data.idle.closed; }
    if (Array.isArray(data.accounts)) {
      state.cachedAccounts = data.accounts.map(a => ({ key: a.key, name: a.name, phoneMasked: a.phoneMasked || '', owner: a.owner || 'self' }));
      writeCache({ accounts: state.cachedAccounts });
    }
  }
  // Boss (31-10-2026): "JAISE YOUTUBE PAR NET NA HO" — har load par upar patli
  // progress bar, aur content me skeleton. Koi button bina feedback nahi.
  // Round 34 (boss): "REMOVE THAT DASH WHICH ANIMATION." Top ki sweeping
  // progress bar gayi — busy button khud spin karta hai, so wahi feedback
  // kaafi hai. `state.loading` abhi bhi ginti rakhta hai (idle refresh isse
  // rukta hai), bas koi patli dash bar animate nahi hoti.
  function startLoading() {
    state.loading += 1;
    try { document.body.classList.add('is-loading'); } catch { /* window band ho gaya */ }
  }
  function stopLoading() {
    state.loading = Math.max(0, state.loading - 1);
    if (state.loading) return;
    try { document.body.classList.remove('is-loading'); } catch { /* window band ho gaya */ }
  }
  // `.is-loading` ko CSS me rakhte hain taaki koi bhi naya loader isi hook par
  // lage — par abhi koi dash/sweep animation nahi chalti.
  async function run(task, button) {
    // Boss (31-10-2026): "ADDRESS PAGE LOAD HO RAHA HAI TO KISI AUR PAGE PAR
    // SHIFT NAHI HO PAA RAHA." Ek global busy-lock tab change ko rok deta tha.
    // Ab sirf wahi button band hota hai jisne request bheji hai.
    if (button?.dataset?.busy === '1') return;
    if (button) { button.dataset.busy = '1'; button.disabled = true; }
    if (button) button.classList.add('button-busy');
    startLoading();
    try { await task(); } catch (e) {
      if (['PRO_VAULT_NOT_CONFIGURED', 'PRO_VAULT_DECRYPT_FAILED'].includes(e?.code)) {
        state.auth = false; state.authError = e.message; state.authErrorCode = e.code; render();
      } else toast(e.message || 'Something went wrong.');
    } finally {
      state.busy = false;
      if (button?.isConnected) {
        const returnFocus = button.dataset.dialogReturnFocus === '1';
        delete button.dataset.busy; delete button.dataset.dialogReturnFocus;
        button.disabled = false; button.classList.remove('button-busy');
        if (returnFocus && document.activeElement === document.body) restoreDialogFocus(button);
      }
      stopLoading();
    }
  }
  // Boss (31-10-2026, dusra round): "ADMIN SE BAAT KARO WALA BUTTON HATAO."
  // App ke andar sirf app ka kaam — koi support button nahi.
  function skeletonRows(count = 3, lines = 2) {
    return `<div class="skeleton-list" aria-hidden="true">${Array.from({ length: count }).map(() => `<div class="skeleton-row"><span class="skeleton-tile"></span><span class="skeleton-copy">${Array.from({ length: lines }).map((_, i) => `<span class="skeleton-line${i ? ' short' : ''}"></span>`).join('')}</span></div>`).join('')}</div>`;
  }
  function field(label, name, placeholder, value = '', extra = '') {
    return `<label class="field"><span class="field-label">${esc(label)}</span><span class="input-wrap"><input name="${esc(name)}" placeholder="${esc(placeholder)}" value="${esc(value)}" ${extra}></span></label>`;
  }
  /** Order ka asli time — sirf jab parse ho. Swiggy "31/10/26, 12:19 am" bheje
   *  to hum uska hisaab nahi banate; wo bhi sach hai (Last 1 Hour band rehta hai). */
  function orderTime(o) {
    for (const v of [o?.placedAtIso, o?.placedAtAt, o?.placedAt]) {
      if (!v) continue;
      const t = Date.parse(String(v));
      if (Number.isFinite(t)) return t;
    }
    return null;
  }
  function addressLabel(a) {
    // Swiggy jaisa: heading me address ka naam (Skk / Home), neeche poora address.
    // Annotation (HOME/WORK) ho to wahi, warna name, warna honest fallback.
    return a?.annotation || a?.name || a?.label || 'Delivery address';
  }
  const normName = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  function trapDialogTab(event, dialog) {
    if (event.key !== 'Tab') return;
    const controls = Array.from(dialog.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'))
      .filter(el => !el.closest('[hidden], [inert]'));
    if (!controls.length) { event.preventDefault(); return; }
    const index = controls.indexOf(document.activeElement);
    if (index === -1 || (event.shiftKey && index === 0) || (!event.shiftKey && index === controls.length - 1)) {
      event.preventDefault();
      (event.shiftKey ? controls[controls.length - 1] : controls[0]).focus();
    }
  }
  let dismissOutletSheet = null;
  /**
   * Boss (31-10-2026): "RESTAURANT KA LOCATION CHOOSE KARNE WALA SEARCH PAR
   * CLICK KARKE RESTAURANT KHOLU TAB DENA". Swiggy jaisa: ek naam ke kai
   * outlet ho to pehle location sheet, phir menu.
   */
  function openOutletSheet(name, outlets, currentId = '', opener = null) {
    if (dismissOutletSheet) dismissOutletSheet(false);
    const previousFocus = opener || document.activeElement;
    const previousIdentity = describeFocus(previousFocus);
    const overlay = document.createElement('div');
    overlay.className = 'sheet-overlay';
    const sheet = document.createElement('section');
    sheet.className = 'sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Choose outlet');
    // Boss (31-10-2026): Swiggy ka outlet sheet jaisa — "Current Outlet" card
    // (rating · time · distance + tick) aur "Other Outlets Around You" list.
    const detail = o => [o.rating ? `★ ${o.rating}` : '', o.time, o.distance, o.isOpen === false ? 'Closed' : ''].filter(Boolean).join(' · ');
    const current = outlets.find(o => String(o.id) === String(currentId)) || null;
    const others = outlets.filter(o => String(o.id) !== String(currentId));
    const row = (o, isCurrent) => `<button class="sheet-option${isCurrent ? ' current' : ''}" type="button" data-sheet-outlet="${esc(o.id)}" ${o.isOpen === false ? 'disabled' : ''}>
        <span class="sheet-pin">${icon('address')}</span>
        <span class="row-content"><strong>${esc(o.area || o.name)}</strong><small>${esc(detail(o))}</small></span>
        ${isCurrent ? `<span class="pill green">Yahi</span><span class="outlet-check">${icon('check')}</span>` : o.isOpen === false ? '<span class="pill grey">Closed</span>' : icon('arrow')}
      </button>`;
    sheet.innerHTML = `<div class="sheet-grip" aria-hidden="true"></div>
      <div class="sheet-head"><div><p class="eyebrow">DELIVERING FROM</p><h2>${esc(name)}</h2><p>${outlets.length} outlet${outlets.length === 1 ? '' : 's'} aapke address ke paas</p></div><button class="icon-button" type="button" data-sheet-close aria-label="Band karein">${icon('close')}</button></div>
      <div class="sheet-list">${current ? `<p class="outlet-list-title">Current Outlet</p>${row(current, true)}` : ''}${others.length ? `<p class="outlet-list-title">Other Outlets Around You</p>${others.map(o => row(o, false)).join('')}` : ''}</div>`;
    overlay.append(sheet);
    document.body.append(overlay);
    const onKey = event => {
      if (confirmationOpen) return;
      if (event.key === 'Escape') { event.preventDefault(); dismissOutletSheet?.(); return; }
      trapDialogTab(event, sheet);
    };
    let unlockBackground = () => {};
    dismissOutletSheet = (restore = true) => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      unlockBackground();
      dismissOutletSheet = null;
      if (restore) restoreDialogFocus(previousFocus, previousIdentity);
    };
    document.addEventListener('keydown', onKey);
    const close = sheet.querySelector('[data-sheet-close]');
    try { close?.focus({ preventScroll: true }); } catch { close?.focus(); }
    unlockBackground = lockModalBackground(overlay);
    overlay.addEventListener('click', event => {
      if (event.target === overlay || event.target.closest('[data-sheet-close]')) { dismissOutletSheet?.(); return; }
      const pick = event.target.closest('[data-sheet-outlet]');
      if (!pick) return;
      dismissOutletSheet?.(false);
      run(() => openMenu(pick.dataset.sheetOutlet));
    });
  }
  let menuRequestVersion = 0;
  let searchRequestVersion = 0;
  async function openMenu(id) {
    const request = ++menuRequestVersion;
    const fromTab = state.tab;
    const context = JSON.stringify([state.activeAccount?.key || '', state.selectedAddress || null]);
    state.menuLoading = true;
    try {
      const menu = await api('menu?id=' + encodeURIComponent(id));
      // Ignore an old response even if the user navigated away and back.
      if (request !== menuRequestVersion || state.tab !== fromTab || handoffShown() || context !== JSON.stringify([state.activeAccount?.key || '', state.selectedAddress || null])) return;
      state.menu = menu; state.menuQuery = '';
      state.tab = 'search'; writeCache({ tab: 'search' });
      render(); window.scrollTo(0, 0);
    } finally { if (request === menuRequestVersion) state.menuLoading = false; }
  }
  /** Search results me same naam ke saare outlet — sheet ke liye. */
  function outletsForName(name) {
    const target = normName(name);
    const unique = new Map();
    for (const r of state.results || []) if (target && r.id && normName(r.name) === target) unique.set(String(r.id), r);
    return [...unique.values()];
  }
  // A location switch is offered only after Swiggy search returned a distinct
  // matching outlet for this account and delivery address. Do not infer one.
  const outletCache = new Map();
  function outletContext(restaurant) {
    const a = state.selectedAddress;
    if (!state.auth || !state.activeAccount || !a || !restaurant?.id || !normName(restaurant.name)) return '';
    return JSON.stringify([state.activeAccount.key || '', a.id || '', a.address || '', a.lat || '', a.lng || '', String(restaurant.id), normName(restaurant.name)]);
  }
  function outletData(restaurant) {
    const key = outletContext(restaurant);
    if (!key) return { key: '', outlets: [], alternatives: [] };
    let entry = outletCache.get(key);
    if (!entry || (entry.status !== 'loading' && entry.until < Date.now())) {
      entry = { status: 'loading', outlets: [], until: 0 };
      outletCache.set(key, entry);
      if (outletCache.size > 100) outletCache.delete(outletCache.keys().next().value);
      api('restaurants/outlets?q=' + encodeURIComponent(restaurant.name))
        .then(out => {
          const seen = new Set();
          entry.outlets = (Array.isArray(out.outlets) ? out.outlets : []).filter(o => {
            const id = String(o?.id || '');
            if (!id || seen.has(id) || normName(o.name) !== normName(restaurant.name)) return false;
            seen.add(id); return true;
          });
          entry.status = 'ready'; entry.until = Date.now() + 120_000;
        })
        .catch(() => { entry.status = 'error'; entry.until = Date.now() + 30_000; })
        .finally(() => { try { refreshOutletSlots(key); } catch { /* WebView closed */ } });
    }
    const outlets = entry.status === 'ready' ? entry.outlets : [];
    return { key, outlets, alternatives: outlets.filter(o => String(o.id) !== String(restaurant.id)) };
  }
  function allOutletChoices(restaurant, data) {
    const current = data.outlets.find(o => String(o.id) === String(restaurant.id)) || restaurant;
    return [current, ...data.alternatives];
  }
  function renderMenuOutlet(restaurant) {
    const data = outletData(restaurant);
    if (!data.alternatives.length) return '';
    return `<button class="outlet-row menu-outlet-row" type="button" data-action="menu-outlets"><span class="outlet-pin">${icon('address')}</span><span class="outlet-copy"><strong>${esc(restaurant.area || 'Location')}</strong><small>${data.alternatives.length + 1} outlets</small></span><span class="outlet-caret">Change ▾</span></button>`;
  }
  function renderCartOutlet(cart) {
    const restaurant = { id: cart.restaurantId, name: cart.restaurantName, area: cart.restaurantArea, time: cart.restaurantTime, rating: cart.restaurantRating };
    const data = outletData(restaurant);
    if (!data.alternatives.length) return '';
    const open = state.outletsOpen && state.outletOpenFor === data.key;
    const options = allOutletChoices(restaurant, data).map(o => {
      const current = String(o.id) === String(restaurant.id);
      const bits = [o.rating ? `★ ${o.rating}` : '', o.time, o.distance, o.isOpen === false ? 'Closed' : ''].filter(Boolean).join(' · ');
      return `<button class="outlet-option ${current ? 'current' : ''}" type="button" data-action="outlet-pick" data-id="${esc(o.id)}" data-name="${esc(o.name)}" ${current || o.isOpen === false ? 'disabled' : ''}><span class="row-content"><strong>${esc(o.area || o.name)}</strong><small>${esc(bits)}</small></span>${current ? `<span class="pill green">Yahi</span><span class="outlet-check">${icon('check')}</span>` : o.isOpen === false ? '<span class="pill grey">Closed</span>' : icon('arrow')}</button>`;
    }).join('');
    return `<button class="outlet-row" type="button" data-action="outlets-toggle" aria-expanded="${open ? 'true' : 'false'}"><span class="outlet-pin">${icon('address')}</span><span class="outlet-copy"><strong>${esc(restaurant.area || restaurant.name)}</strong><small>Outlet badlein</small></span><span class="outlet-caret">${open ? '▴' : '▾'}</span></button>${open ? `<div class="outlet-list-wrap"><div class="outlet-list">${options}</div></div>` : ''}`;
  }
  function refreshOutletSlots(key) {
    if (state.tab === 'search' && state.menu && outletContext(state.menu.restaurant) === key) {
      const slot = document.querySelector('[data-outlet-slot="menu"]');
      if (slot) slot.innerHTML = renderMenuOutlet(state.menu.restaurant);
    }
    if (state.tab === 'cart' && state.cart) {
      const restaurant = { id: state.cart.restaurantId, name: state.cart.restaurantName };
      if (outletContext(restaurant) === key) {
        const slot = document.querySelector('[data-outlet-slot="cart"]');
        if (slot) slot.innerHTML = renderCartOutlet(state.cart);
      }
    }
  }
  let renderedNav = '';
  let renderedDock = '';
  function renderNav() {
    const tabs = [['accounts','Accounts'],['address','Address'],['search','Search'],['cart','Cart'],['orders','Orders'],['tools','Tools']];
    const cart = state.auth ? state.cart : null;
    const quantity = cart?.items?.reduce((n, i) => n + Number(i.qty || 0), 0) || 0;
    const nav = $('#bottom-nav');
    const navHtml = tabs.map(([id, label]) => {
      const selected = !handoffShown() && state.tab === id;
      return `<button type="button" data-action="nav" data-tab="${id}" class="${selected ? 'selected' : ''}" ${selected ? 'aria-current="page"' : ''} ${id === 'cart' && quantity ? `aria-label="Cart, ${quantity} item${quantity === 1 ? '' : 's'}"` : ''} ${state.auth ? '' : 'disabled'}><span class="nav-icon">${icon(id)}${id === 'cart' && quantity ? `<span class="nav-count" aria-hidden="true">${quantity > 99 ? '99+' : quantity}</span>` : ''}</span><span>${label}</span></button>`;
    }).join('');
    if (renderedNav !== navHtml) { nav.innerHTML = navHtml; renderedNav = navHtml; }

    const chip = $('#account-chip');
    const chipPhone = state.activeAccount?.phone || state.activeAccount?.phoneMasked || '';
    const chipName = state.activeAccount?.name || '';
    const chipText = chip.querySelector('#account-chip-text') || chip;
    chipText.textContent = state.auth ? (chipName || (chipPhone ? `+91 ${chipPhone}` : 'Select account')) : 'Not connected';
    const accountDescription = state.auth ? [chipName, chipPhone ? `+91 ${chipPhone}` : ''].filter(Boolean).join(' · ') || 'Select account' : 'Not connected';
    chip.setAttribute('aria-label', `Account: ${accountDescription}`);
    chip.title = accountDescription;
    chip.disabled = !state.auth;

    // Keep the one existing dock tied to the server cart. A pending/unknown
    // checkout takes precedence over both the cart shortcut and the chat draft.
    let dockHtml = '';
    if (state.auth && !state.checkout && !state.track && !state.couponView) {
      if (state.chatHandoff && state.handoffHidden) {
        const detail = cart && quantity ? `${esc(cart.restaurantName || 'Cart')} · ${cart.quote ? money(cart.quote.total) : 'Bill not checked yet'}` : 'Mini App mein continue karein';
        dockHtml = `<button type="button" class="cart-dock" data-action="handoff-resume"><span class="dock-icon">${icon('link')}</span><span class="dock-copy"><strong>Chat links${quantity ? ` · ${quantity} item${quantity === 1 ? '' : 's'}` : ''}</strong><small>${detail}</small></span><span class="dock-cta">Continue ${icon('arrow')}</span></button>`;
      } else if (!handoffShown() && cart && quantity && state.tab !== 'cart') {
        const description = `${quantity} item${quantity === 1 ? '' : 's'} · ${cart.restaurantName || 'Cart'} · ${cart.quote ? `Swiggy bill ${money(cart.quote.total)}` : 'Bill not checked yet'}`;
        dockHtml = `<button type="button" class="cart-dock" data-action="nav" data-tab="cart" aria-label="View cart: ${esc(description)}"><span class="dock-icon">${icon('cart')}</span><span class="dock-copy"><strong>${quantity} item${quantity === 1 ? '' : 's'} · ${esc(cart.restaurantName || 'Cart')}</strong><small>${cart.quote ? `Swiggy bill ${money(cart.quote.total)}` : 'Bill not checked yet'}</small></span><span class="dock-cta">View cart ${icon('arrow')}</span></button>`;
      }
    }
    const dock = $('#cart-dock');
    if (renderedDock !== dockHtml) { dock.innerHTML = dockHtml; renderedDock = dockHtml; }
    document.body.classList.toggle('has-dock', Boolean(dockHtml));
  }
  function renderThemeControl() {
    const button = $('.theme-button');
    if (!button) return;
    const dark = document.body.classList.contains('dark');
    button.setAttribute('aria-pressed', String(dark));
    button.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    button.innerHTML = icon(dark ? 'sun' : 'moon');
  }
  /**
   * Boss (01-11-2026, round 31): reference screenshot — "Add Account" card,
   * Number/JSON pill, flag wala mobile field, gradient Send OTP, "Saved Accounts"
   * heading + ginti, "Search Account…", aur har row par Used / JSON copy /
   * green check / delete.
   *
   * Niym still same: OTP asli Swiggy flow se jata hai, JSON import asli verify
   * hota hai, delete ka do-choice flow wahi hai. Koi nakli success nahi.
   */
  function renderAccounts() {
    const lockedNotice = cartLocked() ? '<div class="warning">Checkout pending or unknown hai. Account switching locked hai; sirf wahi original account dobara connect ho sakta hai.</div>' : '';
    const phoneMode = state.mode !== 'json';
    const modePill = `<div class="ac-mode" role="tablist" aria-label="Add account mode">
      <button type="button" role="tab" aria-selected="${phoneMode}" class="${phoneMode ? 'on' : ''}" data-action="account-mode" data-mode="phone">${icon('phone')} Number</button>
      <button type="button" role="tab" aria-selected="${!phoneMode}" class="${!phoneMode ? 'on' : ''}" data-action="account-mode" data-mode="json">${icon('code')} JSON</button>
    </div>`;
    const phoneForm = state.otpSent
      ? `<form data-form="verify-otp" class="ac-form">
          <label class="ac-label" for="ac-otp">Enter OTP</label>
          <div class="ac-input"><span class="ac-prefix">${icon('phone')}</span><input id="ac-otp" name="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6-digit OTP" required></div>
          <button class="ac-cta" type="submit">Verify &amp; add account ${icon('arrow')}</button>
          <button class="text-button ac-switch" type="button" data-action="otp-reset">Change mobile number</button>
        </form>`
      : `<form data-form="send-otp" class="ac-form">
          <label class="sr-only" for="ac-phone">Mobile number</label>
          <div class="ac-input"><span class="ac-prefix"><span class="ac-flag" aria-hidden="true"></span>+91</span><input id="ac-phone" name="phone" inputmode="tel" autocomplete="tel-national" placeholder="Enter Mobile Number" required></div>
          <button class="ac-cta" type="submit">${icon('send')} Send OTP</button>
        </form>`;
    const jsonForm = `<form data-form="import" class="ac-form">
        <label class="ac-label" for="ac-json">Session JSON</label>
        <div class="ac-input ac-textarea"><textarea id="ac-json" name="session" placeholder='{"mobile":"…","token":"…","tid":"…"}' required></textarea></div>
        <button class="ac-cta" type="submit">${icon('code')} Login via JSON</button>
      </form>`;
    const addCard = `<div class="card ac-card">
      <div class="ac-head">${tile('userplus')}<h2>Add Account</h2>${modePill}</div>
      ${phoneMode ? phoneForm : jsonForm}
    </div>`;

    const query = String(state.accountQuery || '').trim().toLowerCase();
    const activeFilters = Array.isArray(state.accountFilters) ? state.accountFilters : [];
    // Boss (round 33): "USED FRESH NIGHT BREKFAST ... CLICK KARNE PAR WO SELECT
    // HOJAYE JINME WO HO AND MULTIPLE FILTER LAGA SAKTA USER."
    // Kaam: USED = live check me order mile; FRESH = live check me 0 order;
    // NIGHT/BREAKFAST = is ID me wo offer maujood hai. Jahan Swiggy se check hi
    // nahi hua, wahan USED/FRESH dono nahi — jhooth nahi.
    const ACCOUNT_FILTERS = [
      { id: 'used', label: 'USED', test: (a) => a.used === true },
      { id: 'fresh', label: 'FRESH', test: (a) => a.fresh === true },
      { id: 'night', label: 'NIGHT', test: (a) => a.night === true },
      { id: 'breakfast', label: 'BREAKFAST', test: (a) => a.breakfast === true }
    ];
    const filterCounts = Object.fromEntries(ACCOUNT_FILTERS.map(f => [f.id, state.accounts.filter(f.test).length]));
    const passesFilters = (a) => activeFilters.every(id => {
      const f = ACCOUNT_FILTERS.find(x => x.id === id);
      return f ? f.test(a) : true;
    });
    const matches = (a) => passesFilters(a)
      && (!query
        || String(a.name || '').toLowerCase().includes(query)
        || String(a.phone || '').includes(query)
        || String(a.phoneMasked || '').replace(/\D/g, '').includes(query.replace(/\D/g, '') || '~'));
    const visible = state.accounts.filter(matches);
    const rows = visible.length ? visible.map(a => {
      const blocked = a.selectable === false && a.needsConfirm !== true;
      const locked = cartLocked();
      const phoneLine = a.phone ? '+91 ' + esc(a.phone) : a.phoneMasked ? '+91 ' + esc(a.phoneMasked) : 'Number not returned';
      const status = a.active ? 'Selected' : String(a.status || '').replace(/_/g, ' ');
      const icons = (a.offerTracks || []).map(t => {
        const outcome = offerOutcome(t);
        const on = ['Claimed', 'Already claimed'].includes(outcome);
        const name = String(t.label || 'Offer').replace(/\s*\([^)]*\)/g, '').trim();
        const accessibleName = `${name}: ${outcome || 'Not confirmed'}`;
        const glyph = t.emoji ? esc(t.emoji) : icon('spark');
        return `<span class="offer-chip ${on ? 'on' : 'off'}" title="${esc(accessibleName)}" aria-label="${esc(accessibleName)}">${glyph}</span>`;
      }).join('');
      const used = a.status === 'USED' ? '<span class="ac-used">Used</span>' : '';
      const copyBtn = a.canRemove === false ? '' : `<button class="ac-json" type="button" data-action="account-copy-json" data-key="${esc(a.key)}" data-name="${esc(a.name)}" aria-label="Copy JSON" title="Copy JSON">${icon('copy')}</button>`;
      const check = `<span class="ac-check ${a.active ? 'on' : blocked ? 'off' : ''}" aria-hidden="true">${icon('check')}</span>`;
      const remove = a.canRemove === false ? '' : `<button class="ac-del" type="button" data-action="account-remove" data-key="${esc(a.key)}" aria-label="Remove account" ${locked ? 'disabled' : ''}>${icon('trash')}</button>`;
      return `<div class="ac-row ${a.active ? 'active' : ''}${blocked ? ' is-blocked' : ''}" data-account-row data-search="${esc([a.name, a.phone, a.phoneMasked].filter(Boolean).join(' ').toLowerCase())}">
        <button class="ac-main" type="button" data-action="account-select" data-key="${esc(a.key)}" aria-pressed="${a.active ? 'true' : 'false'}" aria-label="${esc(a.active ? 'Selected account' : 'Select account')} ${esc(a.name)}" title="${esc(a.reason || status)}" ${blocked || locked ? 'disabled' : ''}>
          <span class="ac-avatar">${icon('accounts')}</span>
          <span class="ac-copy"><strong>${esc(a.name)}</strong><small>${phoneLine}</small><span class="ac-tags">${used}${icons}</span></span>
        </button>
        <div class="ac-actions">${copyBtn}${check}${remove}</div>
      </div>`;
    }).join('') : (state.accounts.length
      ? `<p class="hint ac-noresult">"${esc(state.accountQuery)}" se koi account nahi mila.</p>`
      : empty('accounts', 'No accounts yet', 'Apna account OTP se ya verified session JSON se add karein.'));

    const remembered = state.accounts.length ? '' : (state.cachedAccounts || []).map(a =>
      `<div class="ac-row is-blocked"><span class="ac-avatar">${icon('accounts')}</span><div class="ac-copy"><strong>${esc(a.name || 'Saved ID')}</strong><small>${a.phoneMasked ? '+91 ' + esc(a.phoneMasked) : 'Saved on this phone'} · Server par session nahi mila — dobara add karein (data delete nahi hua).</small></div></div>`
    ).join('');
    const rememberedNote = remembered ? `<div class="warning">Aapke phone par pehle se saved ID mili. Session server par nahi hai — neeche wahi number daal kar OTP se dobara add karein.</div>${remembered}` : '';

    const savedHead = `<div class="ac-saved-head">
      <span class="ac-saved-icon">${icon('accounts')}</span>
      <h2>Saved Accounts</h2>
      <span class="ac-hairline" aria-hidden="true"></span>
      <span class="ac-count">${state.accounts.length}</span>
    </div>`;
    const noResultLive = `<p class="hint ac-noresult-live" hidden>Is naam se koi account nahi mila.</p>`;
    const search = state.accounts.length
      ? `<div class="ac-search">${icon('search')}<input type="search" data-input="account-search" value="${esc(state.accountQuery || '')}" placeholder="Search Account..." aria-label="Search account"></div>`
      : '';

    const filterBar = state.accounts.length
      ? `<div class="ac-filters" role="group" aria-label="Accounts filter">${ACCOUNT_FILTERS.map(f => {
          const on = activeFilters.includes(f.id);
          const count = filterCounts[f.id] || 0;
          return `<button class="ac-filter${on ? ' on' : ''}" type="button" data-action="account-filter" data-filter="${f.id}" aria-pressed="${on}">${f.label} <b>${count}</b></button>`;
        }).join('')}${activeFilters.length ? `<button class="ac-filter clear" type="button" data-action="account-filter" data-filter="">Clear</button>` : ''}</div>`
      : '';
    const filterEmpty = state.accounts.length && !visible.length && !query
      ? '<p class="hint ac-noresult">Is filter par koi ID nahi mili. Filter hata kar dekh lein.</p>'
      : '';
    const saved = `${savedHead}${search}${filterBar}${filterEmpty}${noResultLive}${rememberedNote}${rows}`;
    return `${head('YOUR SPACE', 'Accounts', '')}${lockedNotice}${addCard}${saved}${state.deleteFlow ? `<div class="card delete-card"><div class="card-title">${icon('trash')} Swiggy delete OTP<small>Swiggy ne ${esc(state.deleteFlow.phoneMasked || 'account phone')} par 6-digit delete OTP bheja hai. Ye account Swiggy se hamesha ke liye delete ho jayega.</small></div><form data-form="delete-otp">${field('Delete OTP', 'otp', '6-digit OTP', '', 'inputmode=\"numeric\" autocomplete=\"one-time-code\" maxlength=\"6\" required')}<button class="button danger block" type="submit">Swiggy se delete karein ${icon('trash')}</button><button class="text-button" type="button" data-action="delete-cancel">Cancel</button></form></div>` : ''}`;
  }
  function sameAddress(a, b) {
    if (!a || !b) return false;
    if (a.id && b.id) return String(a.id) === String(b.id);
    if (!a.address || !b.address) return false;
    return ['address', 'area', 'city', 'flat_no', 'lat', 'lng'].every(key => String(a[key] || '').trim().toLowerCase() === String(b[key] || '').trim().toLowerCase());
  }
  function addressCard(a, selected = false) {
    const lockAttr = cartLocked() ? 'disabled' : '';
    return `<div class="address-row${selected ? ' active' : ''}"><div class="row-content"><span class="badge ${selected ? 'green' : 'blue'}">${selected ? 'SELECTED' : esc(addressLabel(a))}</span><strong>${esc(a.name || 'Receiver name needed')}${a.mobile ? ' · +91 ' + esc(a.mobile) : ''}</strong><p>${esc(a.address || 'Address not available')}</p></div>${selected ? `<button class="icon-button" data-action="contact-edit" aria-label="Edit receiver contact" ${lockAttr}>${icon('accounts')}</button>` : `<button class="button mini outline" data-action="address-select" data-ref="${esc(a.ref)}" ${lockAttr}>Select</button>`}</div>`;
  }
  function renderAddress() {
    const locked = cartLocked();
    const lockAttr = locked ? 'disabled' : '';
    const lockedNotice = locked ? '<div class="warning">Receiver changes are locked while checkout is pending or unknown.</div>' : '';
    const selected = state.selectedAddress ? addressCard(state.selectedAddress, true) : '';
    const contact = !locked && state.contactEdit && state.selectedAddress ? `<div class="card"><h2 class="card-title">Receiver details</h2><form data-form="contact">${field('Receiver name', 'name', 'Full name', state.selectedAddress.name, 'required')}${field('Receiver mobile', 'mobile', '10-digit mobile number', state.selectedAddress.mobile, 'inputmode="tel" required')}<p class="hint">Use the person who should receive this order; no account-number substitution.</p><button class="button primary block">Confirm receiver</button></form></div>` : '';
    const pending = !locked && state.pendingAddress ? `<div class="card"><h2 class="card-title">Confirm link details</h2><p class="hint">${esc(state.pendingAddress.address)}</p><form data-form="confirm-address">${field('Receiver name', 'name', 'Receiver name', state.pendingAddress.name, 'required')}${field('Receiver mobile', 'mobile', '10-digit mobile number', state.pendingAddress.mobile, 'inputmode="tel" required')}<p class="hint">Name and mobile are filled from the link when Swiggy provides them. Check them before continuing.</p><button class="button primary block">Use this address ${icon('arrow')}</button></form></div>` : '';
    const list = state.addressesLoading ? skeletonRows(3, 2) : state.addresses.length ? state.addresses.map(a => {
      const selected = sameAddress(a, state.selectedAddress);
      return addressCard(selected ? { ...a, name: state.selectedAddress.name, mobile: state.selectedAddress.mobile } : a, selected);
    }).join('') : `<div class="empty">${esc(state.addressNote || 'Refresh dabaiye — saved address Swiggy se aate hain.')}</div>`;
    return `${head('WHERE TO?', 'Delivery addresses', 'Choose the right person and place.')}${lockedNotice}${selected}${contact}<div class="card"><div class="card-title">${tile('link')}<span class="title-copy">Add by address link<small>Paste the Swiggy share-address link.</small></span></div><form data-form="address-link">${field('Swiggy address link', 'url', 'https://swiggy.onelink.me/…', '', 'type="url" required ' + lockAttr)}<button class="button primary block" ${lockAttr}>Read address ${icon('arrow')}</button></form></div>${pending}<div class="line-heading">${icon('address')} Saved addresses <button class="text-button right" data-action="addresses-refresh">${icon('refresh')} Refresh</button></div>${list}`;
  }
  function menuCartLines(item, restaurant) {
    if (String(state.cart?.restaurantId || '') !== String(restaurant?.id || '')) return [];
    return (state.cart?.items || []).filter(line => String(line.menu_item_id ?? line.id ?? '') === String(item.id));
  }
  function menuItemControl(item, restaurant) {
    const lines = menuCartLines(item, restaurant);
    const line = lines.find(row => !(row.variants?.length || row.addons?.length));
    const total = lines.reduce((sum, row) => sum + Math.max(0, Number(row.qty) || 0), 0);
    const disabled = cartLocked() || restaurant.isOpen === false || item.inStock === false || item.customizable || item.price === null;
    if (line) {
      const qty = Math.max(0, Number(line.qty) || 0);
      return `<div class="stepper menu-stepper"><button type="button" data-action="qty" data-key="${esc(line.lineKey)}" data-qty="${qty - 1}" aria-label="Remove one ${esc(item.name)}" ${cartLocked() || qty > 21 ? 'disabled' : ''}>−</button><span aria-live="polite">${total}</span><button type="button" data-action="qty" data-key="${esc(line.lineKey)}" data-qty="${qty + 1}" aria-label="Add one ${esc(item.name)}" ${disabled || qty >= 20 ? 'disabled' : ''}>+</button></div>`;
    }
    // Imported customised lines cannot be modified without choosing options;
    // still show the real quantity instead of pretending the item is absent.
    if (total) return `<span class="menu-qty-readonly" aria-label="${total} ${esc(item.name)} in cart">${total} in cart</span>`;
    return `<button class="button mini outline" type="button" data-action="dish-add" data-id="${esc(item.id)}" data-restaurant="${esc(restaurant.id)}" ${disabled ? 'disabled' : ''}>${cartLocked() ? 'Checkout pending' : item.inStock === false ? 'Sold out' : item.customizable ? 'Choices needed' : 'ADD +'}</button>`;
  }
  // Update only the quantity controls and dock after the server confirms a cart
  // change; the menu, scroll position and dish search stay intact.
  function updateMenuCartControls(opener, hadFocus) {
    if (state.tab !== 'search' || !state.menu || handoffShown()) { render(); return; }
    const items = (state.menu.categories || []).flatMap(category => category.items || []);
    let focusTarget = null;
    for (const slot of document.querySelectorAll('[data-menu-control]')) {
      const item = items.find(i => String(i.id) === slot.dataset.menuControl);
      if (!item) continue;
      const wasInSlot = slot.contains(opener);
      slot.innerHTML = menuItemControl(item, state.menu.restaurant);
      if (wasInSlot && hadFocus) {
        const wanted = opener.getAttribute('aria-label') || '';
        focusTarget = [...slot.querySelectorAll('button:not(:disabled)')].find(b => b.getAttribute('aria-label') === wanted) || slot.querySelector('button:not(:disabled)');
      }
    }
    renderNav();
    if (focusTarget) { try { focusTarget.focus({ preventScroll: true }); } catch { focusTarget.focus(); } }
  }
  function renderSearch() {
    if (state.menu) {
      const r = state.menu.restaurant;
      const avail = r.isOpen === false ? `<div class="warning">${esc(r.opens || 'This restaurant is closed right now.')}</div>` : '';
      // Boss (31-10-2026): "ITEM SEARCH KAR SAKE… AUR SO ON." Menu ke andar hi
      // dish search + same restaurant ke doosre outlets ke chips.
      const sections = state.menu.categories.map(c => `<section data-category-block><div class="menu-category">${esc(c.title)} <span class="pill">${c.items.length}</span></div>${c.items.map(i => `<article class="dish-row" data-menu-item data-name="${esc(String(i.name || '').toLowerCase())}"><div class="row-content">${i.isVeg === null ? '' : `<span class="veg-mark ${i.isVeg ? '' : 'nonveg'}" aria-label="${i.isVeg ? 'Vegetarian' : 'Non-vegetarian'}"></span>`}<strong>${esc(i.name)}</strong><div class="dish-price">${i.price === null ? 'Price unavailable' : money(i.price)}</div><p class="dish-description">${esc(i.description)}</p></div><div class="dish-right">${i.image ? `<img class="food-thumb" src="${esc(i.image)}" alt="" loading="lazy" decoding="async">` : `<span class="food-placeholder">${icon('store')}</span>`}<span class="menu-control" data-menu-control="${esc(i.id)}">${menuItemControl(i, r)}</span></div></article>`).join('')}</section>`).join('');
      const outletSlot = `<div data-outlet-slot="menu">${renderMenuOutlet(r)}</div>`;
      return `<button class="back-button" data-action="menu-back">${icon('back')} Back to search</button><div class="menu-hero"><p>RESTAURANT · ${esc(r.area)}</p><h1>${esc(r.name)}</h1><p>${esc([r.rating ? '★ ' + r.rating : '', r.ratings, r.time].filter(Boolean).join(' · '))}</p></div>${outletSlot}${avail}<div class="input-wrap menu-search">${icon('search')}<input type="search" data-input="menu-search" value="${esc(state.menuQuery)}" placeholder="Is restaurant me dish search karein…" aria-label="Search dishes"></div><p class="hint">Jo item custom choices maangta hai wo Swiggy me order karein — yahan support baad me aayega.</p>${sections}`;
    }
    const addr = state.selectedAddress ? `<button class="action-tile" data-action="nav" data-tab="address">${tile('address')}<span class="tile-copy"><small>DELIVER TO</small><strong>${esc(addressLabel(state.selectedAddress))}</strong><small>${esc(state.selectedAddress.address)}</small></span>${icon('arrow')}</button>` : `<button class="action-tile" data-action="nav" data-tab="address">${tile('address')}<span class="tile-copy"><strong>Select a delivery address</strong><small>Restaurant availability depends on your location.</small></span>${icon('arrow')}</button>`;
    let results;
    if (state.resultsLoading) {
      results = skeletonRows(4, 2);
    } else if (state.results === null) {
      results = `${empty('store', 'Find something delicious', 'Search for a restaurant to see its menu and build a cart.')}<p class="eyebrow">Popular searches</p><div class="chips">${["Domino's",'KFC',"McDonald’s",'Pizza Hut','Burger King','Subway'].map(q => `<button class="chip" data-action="popular" data-query="${esc(q)}">${esc(q)}</button>`).join('')}</div>`;
    } else if (!state.results.length) {
      results = empty('search', 'No restaurants returned', 'Try another search or check the selected address.');
    } else {
      // Boss (31-10-2026): "RESTAURANT KA ALAG ALAG LOCATION HO TO CHUN SAKE."
      // Ek hi naam ke outlets alag rows rehte hain (apna area/distance ke saath)
      // aur un par "N locations" ka pill dikhta hai.
      results = `<div class="line-heading">${state.results.length} restaurant${state.results.length === 1 ? '' : 's'}</div>${state.results.map(r => {
        const outlets = outletsForName(r.name).length;
        return `<button class="restaurant-row" data-action="restaurant" data-id="${esc(r.id)}" data-name="${esc(r.name)}">${r.image ? `<img class="food-thumb" src="${esc(r.image)}" alt="" loading="lazy" decoding="async">` : `<span class="food-placeholder">${icon('store')}</span>`}<span class="row-content"><strong>${esc(r.name)}</strong>${outlets > 1 ? ` <span class="pill blue">${outlets} locations</span>` : ''}<p>${esc([r.rating ? '★ ' + r.rating : '',r.ratings].filter(Boolean).join(' · '))}</p><p>${esc(r.cuisines)}</p><p>${esc([r.area,r.distance,r.time].filter(Boolean).join(' · '))}</p><p class="${r.isOpen === true ? 'status-open' : r.isOpen === false ? 'status-closed' : 'status-unknown'}">${r.isOpen === true ? 'Open' : r.isOpen === false ? esc(r.opens || 'Closed') : 'Availability not returned'}</p></span>${icon('arrow')}</button>`;
      }).join('')}`;
    }
    return `${head('DISCOVER', 'Find a restaurant', 'Good food, a little closer to home.')}${addr}<form class="search-form" data-form="search"><span class="input-wrap">${icon('search')}<input name="q" value="${esc(state.searchQuery)}" placeholder="Search for restaurants…" required></span><button class="button primary" aria-label="Search">${icon('arrow')}</button></form>${results}`;
  }
  /**
   * Boss (31-10-2026, round 21): "NO SMS RECEIVED" — SMS ka sach alag se.
   * Jhootha "bhej diya" nahi: jo Swiggy ke data me hai wahi.
   */
  function trackingDetails(t) {
    if (!t) return '';
    return `<div class="bill-row"><span>Status</span><strong>${esc(t.status || 'Not returned')}</strong></div>${t.eta ? `<div class="bill-row"><span>ETA</span><strong>${esc(t.eta)}</strong></div>` : ''}${t.deliveryPartner?.name ? `<div class="bill-row"><span>Delivery partner</span><strong>${esc(t.deliveryPartner.name)}</strong></div>` : ''}${t.deliveryPartner?.phone ? `<div class="bill-row"><span>Partner phone</span><strong>${esc(t.deliveryPartner.phone)}</strong></div>` : ''}${t.deliveryOtp ? `<div class="bill-row"><span>Delivery OTP</span><strong>${esc(t.deliveryOtp)}</strong></div>` : ''}`;
  }
  function renderCheckout() {
    const c = state.checkout;
    if (!c) {
      // App ke andar hi rehna hai (boss 31-10-2026) — Swiggy bahar nahi kholte.
      if (!state.checkoutEnabled) return `<div class="card"><div class="card-title">${icon('cart')} Payment</div><div class="warning">In-app checkout abhi band hai, isliye ye draft order nahi hai. Bill upar se check karein — paisa nahi katega.</div></div>`;
      return `<div class="card"><div class="card-title">${icon('cart')} UPI checkout</div><p class="hint">Experimental: one real placement request is sent after your confirmation. Swiggy may notify the recipient. Check all details before continuing.</p><button class="button green block" type="button" data-action="checkout-start" ${state.cart?.quote ? '' : 'disabled'}>Place order & get UPI QR ${icon('arrow')}</button><p class="hint">A bill is not an order. Card and cash payments are not supported here.</p></div>`;
    }
    const id = `${c.accountPhone ? `<div class="bill-row"><span>Original account</span><strong>${esc(c.accountPhone)}</strong></div>` : ''}${c.orderId ? `<div class="bill-row"><span>Swiggy order ID</span><strong>#${esc(c.orderId)}</strong></div>` : ''}`;
    const warning = `<p class="hint">${esc(c.message || '')}</p>`;
    if (c.status === 'PAID') return `<div class="card"><div class="card-title">${icon('check')} Payment verified</div>${id}${warning}${trackingDetails(c.tracking ? { ...c.tracking, sms: c.sms || c.tracking.sms } : null)}<button class="button outline block" data-action="checkout-finish">Start a new draft</button></div>`;
    if (c.status === 'PAYMENT_PENDING') {
      const qr = c.qrDataUrl && /^data:image\/png;base64,/.test(c.qrDataUrl) && c.upiIntentUrl && /^upi:\/\/pay\?/i.test(c.upiIntentUrl)
        ? `<img class="payment-qr" src="${esc(c.qrDataUrl)}" alt="Swiggy UPI payment QR"><a class="button green block" href="${esc(c.upiIntentUrl)}">Open UPI app</a><p class="hint">Pay ${money(c.amount)} only once. If your UPI app cannot open here, scan this QR with another device.</p>` : '';
      const paidNote = c.paymentVerified ? '<div class="warning">Payment was reported, but order confirmation is still pending. Do not pay again.</div>' : '';
      return `<div class="card"><div class="card-title">${icon('receipt')} Payment pending</div>${id}${warning}${paidNote}${qr}<p class="hint">${c.ofoConfirmed ? 'Swiggy returned an OFO flag; recipient SMS is not verified.' : 'Swiggy has not confirmed OFO acceptance or recipient SMS.'}</p><button class="button primary block" data-action="checkout-status">Check payment & order ${icon('refresh')}</button></div>`;
    }
    // Boss (round 35): "CHECKOUT NEEDS CHECKING KA CARD ARAHA AND BUTTON AARAHA
    // CHECK THIS ORDER AND CHECK ORIGINAL ACCOUNT BLAH BAKH — ISKO HATADO,
    // CANCEL KARDU." Isliye yahan sirf ek saaf raasta: cancel karo, cart wapas,
    // naya order karo. Swiggy par order ban gaya ho to uska sach neeche likha
    // rehta hai — hum use cancel nahi kar sakte, isliye jhooth nahi bolte.
    const stuck = c.status === 'SUBMITTING'
      ? 'Order Swiggy ko ja raha hai. 5-10 second ruk kar isi card par cancel dabaiye — jawab aane par yahan sach dikhega.'
      : esc(c.message || 'Ye checkout band nahi hua. Cancel karke cart wapas lein — dobara order tabhi karein jab My Orders khaali dikhe.');
    return `<div class="card cancel-card"><div class="card-title">${icon('receipt')} Checkout band karein</div>${id}<div class="warning">${stuck}</div><button class="button danger-soft block" type="button" data-action="checkout-cancel">Order cancel karein</button><p class="hint">Cancel karne par: paisa nahi katega, wallet fee wapas (agar li gayi thi), aur cart dobara khul jayega.</p></div>`;
  }
  /**
   * Boss (31-10-2026): "CART WALA PAGE JAISA DIKHAYA WAISA HI — OPTION BAHUT
   * CONFUSING HAI." Ab cart Swiggy ke cart jaisa seedha hai: group cart,
   * delivering to, your order, apply coupon, bill, payment method, pay bar.
   */
  /**
   * Boss (31-10-2026, round 8): "DETAILED ... HOW THE FINAL BILL IS BEING
   * CALCULATED, SAARA CASH JAISE APP ME DIKHTA HAI." Har line wahi jo Swiggy ke
   * bill me aati hai, aur neeche poora hisaab jod kar dikhta hai.
   */
  /**
   * Boss (31-10-2026, round 11): "TEXT ORGANISE WAY ME BHI NAHI HAI ... AISE
   * AUTOMATIC BILL CALCULATE HONA CHAHIYE." Isliye wahi lines, wahi order,
   * wahi naam — jo Swiggy ke bill summary me aate hain. Number Swiggy ka.
   */
  function renderBill(q) {
    if (!q) return '';
    const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? 0 : Number(v));
    const present = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
    const row = (label, value, cls = '') => `<div class="bill-row${cls ? ' ' + cls : ''}"><span>${label}</span><strong>${value}</strong></div>`;
    const discount = num(q.discount), freeCash = num(q.freeCash), tradeDiscount = num(q.tradeDiscount);
    const oneFee = num(q.oneMembershipFee), packing = num(q.packingCharges);
    const taxes = num(q.taxes), other = num(q.otherCharges), offer = num(q.unlistedDiscount);
    const deliverySaved = num(q.deliverySaved);
    const deliveryKnown = present(q.deliveryFee);
    const deliveryFree = deliveryKnown && num(q.deliveryFee) === 0;
    const savings = num(q.totalSavings) || (discount + freeCash + tradeDiscount + deliverySaved);
    const distance = q.deliveryDistance ? ` <small>${esc(q.deliveryDistance)}</small>` : '';
    const offerLine = q.offerNote ? `<div class="bill-offer-note">${icon('spark')} ${esc(q.offerNote)}</div>` : '';
    const couponCode = esc(q.coupon || q.couponCode || '');
    const couponRow = discount > 0 ? row(`Coupon ${couponCode}`.trim(), `−${money(discount)}`, 'saving')
      : q.discountAlreadyApplied === true && couponCode ? row(`Coupon ${couponCode}`, 'Included', 'saving') : '';
    return `<div class="card bill-card" id="bill-details"><div class="card-title">${icon('receipt')} Bill Details <button class="icon-button right" type="button" data-action="bill-refresh" aria-label="Refresh bill">${icon('refresh')}</button></div>${offerLine}<div class="divider"></div>${present(q.itemTotal) ? row('Items Total', money(q.itemTotal)) : ''}${couponRow}${freeCash > 0 ? row('Free Cash', `−${money(freeCash)}`, 'saving') : ''}${tradeDiscount > 0 ? row('Restaurant Discount', `−${money(tradeDiscount)}`, 'saving') : ''}${oneFee > 0 ? row('Swiggy One Lite Membership', `+${money(oneFee)}`) : ''}${deliveryFree ? `<div class="bill-row free-delivery"><span>Free Delivery</span><strong>${deliverySaved > 0 ? `${money(deliverySaved)} saved` : 'Applied'}</strong></div>` : ''}${deliveryKnown ? row(`Delivery Fee${distance}`, deliveryFree ? `FREE${deliverySaved > 0 ? ` (${money(deliverySaved)} saved)` : ''}` : money(q.deliveryFee), deliveryFree ? 'saving' : '') : ''}${packing > 0 ? row('Packing Charges', money(packing)) : ''}${(taxes + other) > 0 ? row('GST &amp; Other Charges', money(taxes + other)) : ''}${offer > 0 ? row('Extra saving (bill me)', `−${money(offer)}`, 'saving') : ''}${savings > 0 ? `<div class="bill-row total-savings"><span>Total Savings</span><strong>${money(savings)}</strong></div>` : ''}<div class="bill-row total"><span>To Pay</span><span>${money(q.total)}</span></div></div>`;
  }
  function renderBillLoading(q, cart) {
    if (q || !cart || !(cart.items || []).length || cartLocked()) return '';
    return `<div class="card bill-loading-card" aria-live="polite">${playLoader('Bill calculate ho raha hai', 'large')}<strong>Bill calculate ho raha hai…</strong><button class="text-button bill-loading-retry" type="button" data-action="bill-refresh">Retry</button></div>`;
  }
  function savedAmount(q) {
    if (!q) return 0;
    // Swiggy ne khud "Total Savings" diya ho to wahi sach hai (usme free
    // delivery/wallet bhi jud jaata hai) — hum apna bada number nahi banate.
    const stated = Number(q.totalSavings);
    if (Number.isFinite(stated) && stated > 0) return Math.round(stated * 100) / 100;
    const sum = (Number(q.discount) || 0) + (Number(q.unlistedDiscount) || 0) + (Number(q.freeCash) || 0) + (Number(q.tradeDiscount) || 0) + (Number(q.deliverySaved) || 0);
    return Math.round(sum * 100) / 100;
  }
  /**
   * Boss (31-10-2026): "IMAGE JAISA CHAHIYE, NORMAL NAHI." Swiggy ke cart jaisa
   * Savings Corner: jo laga hua hai wahi Applied, Remove se hat bhi sakta hai.
   */
  function renderSavingsCorner(q) {
    if (!q) return '';
    const num = v => (v === null || v === undefined || !Number.isFinite(Number(v)) ? 0 : Number(v));
    const rows = [];
    const appliedCode = String(q.couponCode || q.coupon || '').toUpperCase();
    const saving = couponSaving(q);
    const applied = Boolean(appliedCode && (saving > 0 || q.discountAlreadyApplied === true));
    if (applied) {
      rows.push(`<div class="saving-row"><span class="saving-icon">%</span><span class="row-content"><strong>${saving > 0 ? money(saving) + ' saved with ' : ''}${esc(appliedCode)}</strong><small>${saving > 0 ? 'Coupon applied' : 'Discount item total me included'}</small></span><span class="saving-badge on">✓ Applied</span>${state.couponView ? '' : `<button class="text-button" type="button" data-action="coupon-remove" ${state.couponBusy ? 'disabled' : ''}>Remove</button>`}</div>`);
    }
    if (num(q.freeCash) > 0) {
      const tracks = Array.isArray(q.offerTracks) ? q.offerTracks.filter(t => t?.verified === true).map(t => t.label).join(' + ') : '';
      rows.push(`<div class="saving-row"><span class="saving-icon one">cash</span><span class="row-content"><strong>${money(num(q.freeCash))} Free Cash</strong><small>${esc(tracks ? tracks + ' claim applied' : 'Bill me applied')}</small></span><span class="saving-badge on">✓ Applied</span></div>`);
    }
    if (num(q.tradeDiscount) > 0) rows.push(`<div class="saving-row"><span class="saving-icon">%</span><span class="row-content"><strong>${money(num(q.tradeDiscount))} Restaurant Discount</strong></span><span class="saving-badge on">✓ Applied</span></div>`);
    if (q.oneApplied === true) rows.push(`<div class="saving-row"><span class="saving-icon one">ONE</span><span class="row-content"><strong>Free Delivery</strong><small>Swiggy One Lite</small></span><span class="saving-badge on">✓ Applied</span><button class="text-button" type="button" data-action="one-remove" ${state.couponBusy ? 'disabled' : ''}>Remove</button></div>`);
    const totalSaved = savedAmount(q);
    const inlineCoupons = (state.coupons || []).filter(c => String(c.code).toUpperCase() !== appliedCode).slice(0, 3).map(c => {
      const busy = state.couponBusy === c.code;
      const result = (state.couponResults || {})[c.code];
      return `<div class="coupon-inline"><span class="coupon-inline-ribbon">${couponBadge(c)}</span><div class="coupon-inline-copy"><strong>${esc(c.code)}</strong><small>${esc(c.description || c.title || '')}</small>${result ? `<small class="${result.ok ? 'ok' : 'no'}">${result.ok ? `Applied — ${money(result.saved)} saved` : esc(result.message || 'Swiggy ne nahi liya')}</small>` : ''}</div><button class="coupon-cta" type="button" data-action="coupon-pick" data-code="${esc(c.code)}" ${state.couponBusy || cartLocked() || c.applicable === false ? 'disabled' : ''}>${busy ? playLoader('Applying', 'tiny') : 'APPLY'}</button></div>`;
    }).join('');
    const strip = !rows.length && !inlineCoupons
      ? `<div class="coupon-empty">${state.couponsLoading ? playLoader('Coupons load ho rahe hain', 'small') + '<span>Coupons load ho rahe hain…</span>' : `<span>${esc(state.couponsError || state.couponsNote || 'Is bill par koi coupon nahi laga.')}</span><button class="text-button" type="button" data-action="coupon-open">View coupons</button>`}</div>`
      : inlineCoupons;
    const more = (state.coupons || []).length
      ? `<button class="text-button coupon-open-link" type="button" data-action="coupon-open">All coupons (${state.coupons.length})</button>`
      : state.couponsLoading ? '' : '<button class="text-button coupon-open-link" type="button" data-action="coupon-open">Apply coupon</button>';
    return `<div class="card savings-corner"><div class="card-title">SAVINGS CORNER${totalSaved > 0 ? `<span class="pill green right">${money(totalSaved)} saved</span>` : ''}${more}</div>${rows.join('')}${strip}</div>`;
  }
  function renderMealRail(cart) {
    if (!state.meal || state.mealLoading) return '';
    const inCart = new Set((cart.items || []).map(i => String(i.id)));
    const dishes = [];
    for (const category of state.meal.categories || []) {
      for (const item of category.items || []) {
        if (dishes.length >= 8) break;
        if (!item.id || inCart.has(String(item.id))) continue;
        if (item.price === null || item.inStock === false || item.customizable) continue;
        dishes.push(item);
      }
    }
    if (!dishes.length) return '';
    return `<div class="meal-rail"><p class="section-title">Complete your meal</p><div class="meal-track">${dishes.map(i => `<article class="meal-card"><span class="meal-thumb">${i.image ? `<img src="${esc(i.image)}" alt="" loading="lazy" decoding="async">` : icon('store')}</span><button class="meal-plus" type="button" data-action="dish-add" data-id="${esc(i.id)}" data-restaurant="${esc(cart.restaurantId)}" aria-label="Add ${esc(i.name)}">+</button><strong>${esc(i.name)}</strong><small>${money(i.price)}</small></article>`).join('')}</div></div>`;
  }
  /**
   * Coupon page (Swiggy image 2 jaisa): applied coupon ribbon ke saath, phir
   * "great deal you are missing out" aur more offers. APPLY par asli bill.
   */
  function renderCouponPage() {
    const cart = state.cart;
    const q = cart?.quote;
    const results = state.couponResults || {};
    const appliedCode = String(q?.couponCode || q?.coupon || '').toUpperCase();
    const appliedSaving = couponSaving(q);
    const isCouponApplied = Boolean(appliedCode && (appliedSaving > 0 || q?.discountAlreadyApplied === true));
    const applied = isCouponApplied
      ? `<p class="section-title">Applied coupon</p><article class="coupon-tile applied"><span class="coupon-ribbon">${appliedSaving > 0 ? `<b>${money(appliedSaving)}</b><small>SAVED</small>` : '<b>✓</b><small>ON</small>'}</span><div class="coupon-body"><div class="coupon-head"><span class="coupon-code">${esc(appliedCode)}</span><button class="coupon-cta" type="button" data-action="coupon-remove" ${state.couponBusy ? 'disabled' : ''}>REMOVE</button></div><p class="coupon-line">${appliedSaving > 0 ? `Save ${money(appliedSaving)} on this order` : 'Discount item total me included'}</p></div></article>`
      : '';
    const tile = c => {
      const code = String(c.code || '').toUpperCase();
      const isApplied = isCouponApplied && appliedCode === code;
      const busy = state.couponBusy === code;
      const result = results[code];
      const action = isApplied
        ? '<span class="coupon-cta off">✓ APPLIED</span>'
        : `<button class="coupon-cta" type="button" data-action="coupon-pick" data-code="${esc(code)}" ${state.couponBusy || cartLocked() || c.applicable === false ? 'disabled' : ''}>${busy ? playLoader('Applying coupon', 'tiny') + ' APPLYING' : 'APPLY'}</button>`;
      const resultLine = result
        ? `<p class="coupon-result ${result.ok ? 'ok' : 'no'}" role="status">${result.ok ? `Applied — ${money(result.saved)} saved` : esc(result.message || 'Swiggy ne ye code accept nahi kiya.')}</p>`
        : c.applicable === false && c.reason ? `<p class="coupon-result no">${esc(c.reason)}</p>` : '';
      return `<article class="coupon-tile${isApplied ? ' applied' : ''}${c.applicable === false ? ' ineligible' : ''}"><span class="coupon-ribbon">${couponBadge(c)}</span><div class="coupon-body"><div class="coupon-head"><span class="coupon-code">${esc(code)}</span>${action}</div><p class="coupon-line">${esc(c.title || code)}</p>${c.description ? `<p class="coupon-desc">${esc(c.description)}</p>` : ''}${resultLine}</div></article>`;
    };
    const list = state.coupons || [];
    const body = state.couponsLoading
      ? `<div class="coupon-loading">${playLoader('Coupons load ho rahe hain')}<span>Coupons load ho rahe hain…</span></div>`
      : state.couponsError
        ? `<div class="card"><p class="warning">${esc(state.couponsError)}</p><button class="button soft block" type="button" data-action="coupon-retry">Retry</button></div>`
        : list.length ? list.map(tile).join('')
          : `<div class="card"><p class="hint">Is restaurant par koi coupon nahi mila.</p><button class="button soft block" type="button" data-action="coupon-retry">Refresh coupons</button></div>`;
    const sheetHead = `<div class="coupon-sheet-head"><span class="icon-tile">${icon('receipt')}</span><h2>Apply Coupon</h2><button class="icon-button" type="button" data-action="coupon-back" aria-label="Band karein">${icon('close')}</button></div>`;
    return `<div class="coupon-overlay" data-action="coupon-back" aria-hidden="true"></div><section class="coupon-sheet" role="dialog" aria-modal="true" aria-label="Apply Coupon"><div class="sheet-grip"></div>${sheetHead}${applied}<div class="coupon-count">${isCouponApplied ? 'MORE OFFERS' : 'AVAILABLE COUPONS'} <b>${list.length}</b></div><div class="coupon-list">${body}</div></section>`;
  }
  function renderTrack() {
    const t = state.track;
    const data = state.trackData;
    const status = String(data?.status || '');
    const steps = ['Order place hua', 'Restaurant ne accept kiya', 'Khana ban raha hai', 'Rider raaste me', 'Delivered'];
    const lowered = status.toLowerCase();
    let reached = 0;
    if (/deliver(ed)?/i.test(lowered) && !/out for|on the way/i.test(lowered)) reached = 5;
    else if (/out for delivery|on the way|picked|rider/i.test(lowered)) reached = 4;
    else if (/prepar|cook|kitchen|accepted|confirm/i.test(lowered)) reached = 3;
    else if (/placed|received|pending/i.test(lowered)) reached = 1;
    const timeline = status ? `<ol class="track-steps">${steps.map((label, i) => `<li class="${i < reached ? 'done' : ''}${i === reached - 1 ? ' current' : ''}"><span class="track-dot"></span><span>${esc(label)}</span></li>`).join('')}</ol>` : '';
    return `<button class="back-button" data-action="track-close">${icon('back')} Cart</button>${head('LIVE ORDER', 'Order track karein', data?.orderId || state.track?.id ? `Swiggy order #${esc(data?.orderId || state.track?.id)}` : 'Swiggy order')}<div class="card track-card"><div class="card-title">${icon('orders')} <span class="title-copy"><strong>${esc(status || (state.trackError ? 'Status nahi mila' : 'Status aa raha hai…'))}</strong><small>${esc(data?.eta ? 'ETA ' + data.eta : 'Swiggy ka taaza status')}</small></span>${state.trackBusy ? '<span class="spinner right" aria-label="Loading"></span>' : ''}</div>${timeline}${state.trackError ? `<div class="warning">${esc(state.trackError)}</div>` : ''}${trackingDetails(data)}${renderShareCard()}<div class="track-actions"><button class="button soft block" type="button" data-action="nav" data-tab="orders">Saare orders</button></div></div>`;
  }
  /** Payment pending: QR screen Swiggy jaisa, phir track. */
  function renderPaymentScreen(c) {
    // Boss (round 33): "PAYMENT PAGE SE OPEN UPI APP HATAYE AND CANCEL ORDER
    // AND I HAVE PAID KA OPTION DE BAS FALTU KE ORDER TRACK KARE ORIGINAL
    // ACCOUNT KE ORDER AUR UPI SE PAY KARE AUR BLAH BLAH NA RAKHE."
    // Isliye yahan sirf: kitna dena hai, QR, aur do button.
    const hasQr = Boolean(c.qrDataUrl && /^data:image\/png;base64,/.test(c.qrDataUrl));
    const verifying = c.status === 'PAYMENT_PENDING' && c.paymentVerified !== true;
    const remaining = payRemainingMs();
    const verifyStrip = verifying
      ? (state.payExpired || remaining <= 0
        ? `<div class="verify-strip expired"><span class="verify-icon">${icon('alert')}</span><span class="verify-copy"><strong>5 minute poore ho gaye</strong><small>Auto-check band. Payment check karein — neeche <b>I have paid</b> dabaiye.</small></span></div>`
        : `<div class="verify-strip"><span class="verify-icon spinner"></span><span class="verify-copy"><strong>Payment verify ho rahi hai… <span class="pay-clock" data-pay-clock>${payClock(remaining)}</span></strong><small>Har 5 second me Swiggy se check — poore 5 minute tak. Aapko kuch nahi karna.</small></span><span class="verify-ticks">${state.payTicks || 0}×</span></div>`)
      : '';
    const reasons = Array.isArray(c.qrMissingReasons) ? c.qrMissingReasons.filter(Boolean).slice(0, 3) : [];
    const qr = hasQr
      ? `<img class="payment-qr" src="${esc(c.qrDataUrl)}" alt="Swiggy UPI payment QR">`
      : `<div class="pay-hold"><div class="pay-hold-head">${tile('alert')}<div class="title-copy"><strong>QR Swiggy ne nahi diya</strong><small>Order ban gaya hai — paisa abhi nahi kata.</small></div></div>${reasons.length ? `<ul class="pay-reasons">${reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : (c.qrMissingReason ? `<p class="pay-reason-line">${esc(c.qrMissingReason)}</p>` : '')}<div class="pay-order-chip"><span>Order</span><b>#${esc(c.orderId || '—')}</b></div></div>${/^https:\/\//.test(String(c.paymentPageUrl || '')) ? `<a class="button soft block" href="${esc(c.paymentPageUrl)}">Swiggy ka payment page</a>` : ''}`;
    return `${head('PAYMENT', `Pay ${money(c.amount)}`, c.orderId ? `Order #${esc(c.orderId)}` : '')}<div class="card pay-screen"><div class="card-title">${tile('receipt')}<span class="title-copy"><strong>UPI se pay karein</strong><small>${hasQr ? 'QR scan karke pay karein — ek hi baar.' : 'Swiggy ne order le liya, bas QR nahi diya.'}</small></span></div>${verifyStrip}${qr}<div class="pay-actions"><button class="button green block" type="button" data-action="checkout-status">${icon('check')} I have paid</button><button class="button soft block danger-soft" type="button" data-action="checkout-cancel">Cancel order</button></div><p class="hint pay-foot">${hasQr ? 'Paisa sirf isi QR par dein — ek hi baar.' : 'Dobara order mat karein — Swiggy par order pehle se bana hua hai.'}</p></div>`;
  }
  function renderCart(behindCoupon = false) {
    // QR aaya to 5-minute verify शुरू (render ke andar se, kyunki yahi entry point hai).
    if (state.checkout?.status === 'PAYMENT_PENDING' && state.checkout.paymentVerified !== true) {
      try { schedulePaymentPoll(); } catch { /* render kabhi na toote */ }
    }
    if (state.track) return renderTrack();
    // The sheet overlays the actual cart, rather than replacing it with a blank
    // screen. The background is inert while the dialog is open.
    if (state.couponView && !behindCoupon) return `<div class="coupon-underlay" inert aria-hidden="true">${renderCart(true)}</div>${renderCouponPage()}`;
    const cart = state.cart;
    const locked = cartLocked();
    const lockAttr = locked ? 'disabled' : '';
    if (state.checkout?.status === 'PAYMENT_PENDING') return renderPaymentScreen(state.checkout);
    // Boss (round 35): "CHECK ORIGINAL ACCOUNT BLAH BAKH ... HATADO" — ab
    // seedha raasta: cancel karo, cart wapas, naya order.
    const lockedNotice = locked ? '<div class="warning">Ek checkout khula hai. Neeche diye button se cancel karein — phir cart aur order dobara chal jayenge.</div>' : '';
    // Boss (31-10-2026): "CART PARSE KARNE WALA BUTTON SIDHA ACTIVE KAR NAKI
    // DROP DOWN PAR CLICK KARNE KE BAAD." Isliye koi toggle nahi — input aur
    // button hamesha saamne, seedha dabao.
    // Round 28: reference jaisa — title + right toggle, neeche paste row.
    // Button hamesha saamne (koi dropdown nahi, round 17 ka niyam bacha hua).
    const groupOn = state.groupCartOn !== false;
    const groupCard = `<div class="card group-cart-card${groupOn ? '' : ' off'}"><div class="card-title"><span class="icon-tile">${icon('link')}</span><span class="title-copy">Add Items from Group Cart<small>Swiggy group cart ka link paste karein.</small></span><button class="switch" type="button" role="switch" aria-checked="${groupOn}" aria-label="Group cart" data-action="group-cart-toggle"></button></div><form data-form="group-cart" class="group-cart-form" novalidate><span class="input-wrap">${icon('link')}<input name="url" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://www.swiggy.com/gc/…" value="${esc(state.groupCartDraft || '')}" ${lockAttr}></span><button class="button primary" type="submit" ${lockAttr}>Cart parse karein ${icon('arrow')}</button></form></div>`;
    const delivery = `<button class="select-address" type="button" data-action="nav" data-tab="address"><span class="pin">${icon('address')}</span><span class="copy"><small>DELIVERING TO</small><strong>${esc(state.selectedAddress ? addressLabel(state.selectedAddress) : 'Select Delivery Address')}</strong><small>${esc(state.selectedAddress ? (state.selectedAddress.address || '') : 'Prices for Other. Pick a saved address to order')}</small></span><span class="chev">${icon('arrow')}</span></button>`;
    if (!cart) {
      return `${head('YOUR ORDER', 'Cart', 'Group cart se items add karein ya restaurant search karein.')}${lockedNotice}${state.checkout ? renderCheckout() : ''}${groupCard}${state.selectedAddress ? delivery : ''}${empty('cart', 'Cart khaali hai', 'Restaurant search karein ya group cart link paste karein.')}`;
    }
    maybeLoadMeal(cart);
    maybeAutoCoupons();
    const quantity = cart.items.reduce((n, i) => n + Number(i.qty || 0), 0);
    // Boss (31-10-2026): Swiggy cart jaisa item row — veg mark + naam left,
    // green stepper + item ka total right.
    const items = cart.items.map(i => {
      const veg = i.isVeg === true ? '<span class="veg-mark" aria-label="Vegetarian"></span>' : i.isVeg === false ? '<span class="veg-mark nonveg" aria-label="Non-vegetarian"></span>' : '';
      const gross = i.price === null ? null : Math.round(Number(i.price) * Number(i.qty || 1) * 100) / 100;
      const lineTotal = gross === null ? '—' : (Number.isFinite(Number(i.lineTotal)) && Number(i.lineTotal) > 0 && Number(i.lineTotal) < gross ? `<s>${money(gross)}</s> ${money(i.lineTotal)}` : money(gross));
      return `<div class="cart-item"><div class="row-content">${veg}<strong>${esc(i.name)}</strong><p>${i.price === null ? 'Price unavailable' : money(i.price) + ' each'}${(i.variants?.length || i.addons?.length) ? ' · Customised' : ''}</p></div><div class="cart-item-right"><div class="stepper"><button type="button" data-action="qty" data-key="${esc(i.lineKey)}" data-qty="${Number(i.qty)-1}" aria-label="Remove one" ${lockAttr}>−</button><span>${Number(i.qty)}</span><button type="button" data-action="qty" data-key="${esc(i.lineKey)}" data-qty="${Number(i.qty)+1}" aria-label="Add one" ${lockAttr}>+</button></div><strong class="line-total">${lineTotal}</strong></div></div>`;
    }).join('');
    const q = cart.quote;
    const meta = [cart.restaurantArea, cart.restaurantTime].filter(Boolean).join(' · ');
    const outletRow = `<div data-outlet-slot="cart">${renderCartOutlet(cart)}</div>`;
    const restaurantCard = `<div class="card restaurant-cart"><div class="cart-restaurant-head"><span class="cart-restaurant-thumb">${cart.restaurantImage ? `<img src="${esc(cart.restaurantImage)}" alt="" loading="lazy" decoding="async">` : icon('store')}</span><span class="row-content"><strong>${esc(cart.restaurantName)}${cart.restaurantRating ? ` <span class="rating-chip">★ ${esc(cart.restaurantRating)}</span>` : ''}</strong><p>${esc(meta || 'Restaurant')}</p></span><button class="icon-button danger" type="button" data-action="cart-clear" aria-label="Cart clear karein" ${lockAttr}>${icon('trash')}</button></div>${outletRow}${items}<div class="cart-actions-row"><button class="chip-action" type="button" data-action="nav" data-tab="search">${icon('plus')} Add Items</button><button class="chip-action" type="button" data-action="toggle-coupon">${icon('receipt')} Apply coupon</button></div></div>`;
    // Boss (31-10-2026): "JAISE SWIGGY KE APP ME DIKHTA CHECKOUT PAGE WAISA KARNA
    // SAME AND PAY NOW KA BUTTON ACTIVE KARNA." ETA strip → savings → address →
    // Your Order → coupon/savings → bill → payment → pay bar.
    const saved = savedAmount(q);
    const savingsBanner = saved > 0 ? `<div class="savings-banner">${icon('spark')} ${money(saved)} saved!${q?.coupon ? ` · ${esc(q.coupon)}` : ''}</div>` : '';
    const eta = `<div class="eta-strip"><span class="eta-clock">${icon('orders')}</span><span class="eta-copy"><strong>${cart.restaurantTime ? `Delivery in ${esc(cart.restaurantTime)}` : 'Delivery time Swiggy se aayega'}</strong><small>${esc([cart.restaurantName, cart.restaurantArea].filter(Boolean).join(' · '))}</small></span></div>`;
    const billReady = Boolean(q && Number.isFinite(Number(q.total)));
    const payBar = `<div class="pay-bar"><button class="button green pay-now" type="button" data-action="checkout-start" ${locked || !state.checkoutEnabled ? 'disabled' : ''} ${!state.checkoutEnabled ? `title="${esc(state.checkoutBlockReason || '')}"` : ''}>${state.checkoutEnabled ? `Pay Now ${icon('arrow')}` : 'Payment band'}</button><div class="pay-left">${billReady ? `<strong aria-label="Bill amount">${money(q.total)}</strong>` : playLoader('Bill amount load ho raha hai', 'small')}</div></div>${state.checkoutEnabled ? '' : `<div class="warning pay-blocked">Payment abhi band hai — ${esc(state.checkoutBlockReason || 'server ne reason nahi diya')}</div>`}`;
    return `${head('CHECKOUT', 'Checkout', '')}${lockedNotice}${state.checkout ? renderCheckout() : ''}${eta}${savingsBanner}${delivery}<div class="line-heading">${icon('cart')} Your Order <span class="pill right">${quantity} item${quantity === 1 ? '' : 's'}${q ? ' · ' + money(q.total) : ''}</span></div>${restaurantCard}${renderMealRail(cart)}${groupCard}${renderSavingsCorner(q)}${renderBill(q)}${renderBillLoading(q, cart)}${state.checkoutWarning ? `<div class="warning" role="alert">${esc(state.checkoutWarning)}</div>` : ''}${payBar}`;
  }
  /**
   * Order detail ka bill/payment hissa (round 30). Rule: sirf wahi line jo
   * Swiggy ne di — jo nahi aaya wo row hi nahi banti. Kuch bhi guess nahi.
   */
  function orderMoneyRows(o) {
    const rows = [
      ['Item total', o.itemTotal],
      ['Platform fee', o.platformFee ?? o.platformFeePaise / 100],
      ['Subscription fee', o.subscriptionFee ?? o.oneMembershipFee],
      ['Coupon discount', o.couponDiscount ?? o.discount],
      ['Offer discount', o.offerDiscount ?? o.unlistedDiscount],
      ['Taxes & other charges', o.taxes ?? o.taxAndCharges]
    ];
    return rows
      .filter(([, v]) => v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) && Number(v) !== 0)
      .map(([label, v]) => `<div class="bill-row"><span>${label}</span><strong>${label.toLowerCase().includes('discount') ? '−' : ''}${money(Math.abs(Number(v)))}</strong></div>`)
      .join('');
  }
  /**
   * Share link card (round 32). Swiggy app me "three dot → Share" se jo link
   * milta hai, wahi yahan Swiggy ke apne response se aata hai (trackV4 ka
   * cta_link / order page share). Hum Swiggy app ke dots khud nahi dabate —
   * isliye ye card seedha wahi link deta hai: copy ya Telegram share.
   */
  function orderShareLink() {
    // Never reuse a different order's checkout link when viewing history.
    const t = state.order ? state.orderTracking : state.track ? state.trackData : state.checkout?.tracking;
    return /^https:\/\//i.test(String(t?.trackingUrl || '')) ? String(t.trackingUrl) : '';
  }
  function renderShareCard() {
    // Boss (round 33): payment ke baad "share order jo link milega wo yahan
    // show hoga aur ek copy ka button bhi hoga and go back ka option bhi".
    const link = orderShareLink();
    const busy = state.shareBusy === true;
    const note = state.shareNote ? `<p class="hint share-note">${esc(state.shareNote)}</p>` : '';
    const back = `<button class="button soft block" type="button" data-action="back-to-cart">${icon('back')} Go back</button>`;
    if (!link) {
      const pending = state.orderLinkLoading || state.trackBusy;
      return `<div class="card share-card"><div class="card-title">${icon('link')} Share link</div>${pending
        ? '<p class="hint">Swiggy se link aa raha hai…</p>'
        : '<p class="hint">Link unavailable — Swiggy ne is order ka share link nahi diya. Hum apna link nahi banate.</p>'}${note}${back}</div>`;
    }
    return `<div class="card share-card"><div class="card-title">${icon('link')} Share link</div><div class="share-link-row"><input class="share-link-input" readonly value="${esc(link)}" aria-label="Order share link" data-share-input><button class="icon-button" type="button" data-action="share-copy" aria-label="Copy link">${icon('copy')}</button></div><div class="share-actions"><button class="button primary" type="button" data-action="share-copy" ${busy ? 'disabled' : ''}>${icon('copy')} Copy</button><button class="button soft" type="button" data-action="share-send">${icon('send')} Share</button></div>${note}${back}</div>`;
  }
  function renderOrders() {
    const detailed = state.ordersDetailAllowed !== false;
    const restrictedNote = detailed ? '' : '<div class="warning">Ye operator ka ID hai. Summary aur Swiggy ka tracking link dikhta hai — address, item list, delivery OTP sirf operator ke paas rehta hai.</div>';
    if (state.order) {
      const o = state.order;
      if (!detailed) {
        return `<button class="back-button" data-action="orders-back">${icon('back')} Back to orders</button>${head('ORDER SUMMARY', o.restaurant || 'Swiggy order', '')}<div class="card"><div class="card-title">${icon('orders')} ${esc(o.status)}</div><div class="divider"></div><div class="bill-row"><span>Order ID</span><strong>#${esc(o.id)}</strong></div><div class="bill-row"><span>Placed</span><strong>${esc(o.placedAt || 'Not returned')}</strong></div><div class="bill-row"><span>Amount</span><strong>${money(o.amount)}</strong></div></div>${renderShareCard()}`;
      }
      const delivered = /\bdelivered\b/i.test(String(o.status || '')) && !/cancel|not delivered|undeliver/i.test(String(o.status || ''));
      const hero = delivered
        ? `<div class="delivered-hero"><div class="delivered-check">${icon('check')}</div><h1>Order Delivered</h1><span class="pill green">${icon('orders')} ${esc(o.restaurant || 'Swiggy order')}</span><p>${esc(o.placedAt ? 'Delivered · placed ' + o.placedAt : 'Swiggy ne delivered bataya hai.')}</p></div>`
        : '';
      return `<div class="order-top-actions"><button class="back-pill" data-action="orders-back">${icon('back')} Back to Orders</button>${state.shareWanted ? `<button class="back-pill" data-action="back-to-cart">${icon('cart')} Go back</button>` : ''}</div>${hero}${head('ORDER DETAILS', o.restaurant || 'Swiggy order', 'Only information returned by Swiggy is shown.')}<div class="card"><div class="card-title">${icon('orders')} ${esc(o.status)}</div><div class="divider"></div><div class="bill-row"><span>Order ID</span><strong>#${esc(o.id)}</strong></div><div class="bill-row"><span>Placed</span><strong>${esc(o.placedAt || 'Not returned')}</strong></div><div class="bill-row"><span>Amount</span><strong>${money(o.amount)}</strong></div>${o.address ? `<div class="bill-row"><span>Address</span><strong>${esc(o.address)}</strong></div>` : ''}</div><div class="card"><div class="card-title">${icon('cart')} Ordered items</div>${o.items.length ? o.items.map(i => `<div class="bill-row"><span>${esc(i.name)}${i.price !== undefined ? '' : ''}</span><strong>${Number.isFinite(Number(i.price)) ? money(Number(i.price) * (Number(i.qty) || 1)) : ''} × ${Number(i.qty)}</strong></div>`).join('') : '<p class="hint">Swiggy did not return item details.</p>'}</div>${(() => {
        const money_ = orderMoneyRows(o);
        const payMethod = String(o.paymentMethod || o.paymentMode || '').trim();
        const receiver = [o.receiverName || o.receiver, o.receiverPhone].filter(Boolean).join(' · ');
        const partner = state.orderTracking?.deliveryPartner;
        const partnerLine = partner && (partner.name || partner.phone) ? `<div class="bill-row"><span>Delivery partner</span><strong>${esc([partner.name, partner.phone].filter(Boolean).join(' · '))}</strong></div>` : '';
        return `<div class="card"><div class="card-title">${icon('receipt')} Payment &amp; bill <span class="pill right">${money(o.amount)}</span></div>${payMethod ? `<div class="bill-row"><span>Payment method</span><strong>${esc(payMethod)}</strong></div>` : ''}${receiver ? `<div class="bill-row"><span>Receiver</span><strong>${esc(receiver)}</strong></div>` : ''}${partnerLine}${money_ ? `<div class="divider"></div>${money_}` : ''}<div class="bill-row total"><span>Total</span><span>${money(o.amount)}</span></div></div>`;
      })()}${renderShareCard()}`;
    }
    let rows;
    // Swiggy jaisa segmented filter. "Last 1 Hour" ka count sirf tab dikhta hai
    // jab Swiggy ne parse-hone wala time diya ho — warna button band + asli
    // wajah, kyunki jhoota count dena galat hoga.
    const times = Array.isArray(state.orders) ? state.orders.map(orderTime) : [];
    const timeKnown = times.some(t => Number.isFinite(t));
    const hourCount = timeKnown ? times.filter(t => Number.isFinite(t) && Date.now() - t < 3600e3).length : null;
    const filter = state.ordersFilter === 'hour' ? 'hour' : 'all';
    const segmented = `<div class="segmented" role="tablist" aria-label="Order filter">
      <button type="button" role="tab" aria-selected="${filter === 'all'}" class="${filter === 'all' ? 'selected' : ''}" data-action="orders-filter" data-filter="all">This Account</button>
      <button type="button" role="tab" aria-selected="${filter === 'hour'}" class="${filter === 'hour' ? 'selected' : ''}" data-action="orders-filter" data-filter="hour" ${timeKnown ? '' : 'disabled title="Swiggy ne order ka time nahi diya, isliye ghante ka hisaab nahi bana sakte."'}>Last 1 Hour${hourCount === null ? '' : ` · ${hourCount}`}</button>
    </div>`;
    const visibleOrders = Array.isArray(state.orders) && filter === 'hour'
      ? state.orders.filter(o => { const t = orderTime(o); return Number.isFinite(t) && Date.now() - t < 3600e3; })
      : state.orders;
    if (state.ordersLoading) rows = skeletonRows(3, 2);
    else if (state.orders === null) rows = empty('orders', 'Your orders', 'Refresh dabaiye — order history selected account se aati hai.');
    else if (!visibleOrders.length) rows = empty('orders', filter === 'hour' ? 'Last 1 hour me koi order nahi' : 'No orders returned', 'Swiggy ne is account ke liye koi order nahi diya.');
    else rows = visibleOrders.map(o => detailed
      ? `<button class="restaurant-row" data-action="order-detail" data-id="${esc(o.id)}">${tile('orders', true)}<span class="row-content"><strong>${esc(o.restaurant || 'Swiggy order')}</strong><p>${esc(o.placedAt || 'Time not returned')}</p><p>${esc((o.items || []).map(i => i.name).join(', ') || 'Item detail not returned')}</p><span class="order-id">#${esc(o.id)}</span></span><span class="pill ${/delivered/i.test(o.status) && !/cancel/i.test(o.status) ? 'green' : ''}">${esc(o.status)}</span></button>`
      // Boss (31-10-2026): user ko bas chhota card, poora detail sirf operator ko.
      : `<button class="restaurant-row compact" data-action="order-detail" data-id="${esc(o.id)}">${tile('orders', true)}<span class="row-content"><strong>${esc(o.restaurant || 'Swiggy order')}</strong><p>${esc(o.placedAt || 'Time not returned')} · #${esc(o.id)}</p></span><span class="order-bill">${money(o.amount)}</span><span class="pill ${/delivered/i.test(o.status) && !/cancel/i.test(o.status) ? 'green' : ''}">${esc(o.status)}</span>${o.trackingUrl && /^https:\/\//.test(String(o.trackingUrl)) ? `<span class="row-link" aria-hidden="true">${icon('arrow')}</span>` : ''}</button>`).join('');
    const original = state.ordersScope === 'checkout';
    const note = original ? '<div class="warning">Original checkout account dikh raha hai. Khaali ya der se aayi list ka matlab order fail nahi — jab tak outcome pata na chale doosra order na karein.</div>' : restrictedNote;
    return `${head('ORDER HISTORY', original ? 'Original account orders' : 'Your orders', original ? 'Checkout wale account ke recent orders.' : 'Is account ke purane aur chalte orders.', `<button class="button mini soft" data-action="orders-refresh">${icon('refresh')} Refresh</button>`)}${segmented}${note}${rows}`;
  }
  /**
   * Boss (31-10-2026, round 11): "AISE AUTOMATIC BILL CALCULATE HONA CHAHIYE."
   * Cart khulte hi Swiggy se asli bill aa jata hai (coupon bhi khud lagta hai)
   * — Pay dabane ka intezaar nahi. Ek hi baar per cart+address, loop nahi.
   */
  function billSyncSignature() {
    const cart = state.cart;
    return JSON.stringify([
      state.activeAccount?.key || '', state.selectedAddress || null,
      cart?.restaurantId || '', cart?.forSomeoneElse === true,
      (cart?.items || []).map(i => [i.lineKey, i.id, i.qty, i.price, i.variants, i.addons])
    ]);
  }
  function maybeAutoBill() {
    if (!state.auth || !state.activeAccount || state.tab !== 'cart' || state.couponView || state.track || state.chatHandoff) return;
    if (!state.checkoutEnabled || cartLocked()) return;
    const cart = state.cart;
    const addr = state.selectedAddress;
    if (!cart?.items?.length || cart.quote) return;
    if (!String(addr?.name || '').trim() || String(addr?.mobile || '').replace(/\D/g, '').length !== 10) return;
    const signature = billSyncSignature();
    if (state.autoBillFor === signature) return;
    state.autoBillFor = signature;
    confirmInApp({ title: 'Swiggy cart sync karein?', message: 'Selected ID ka existing Swiggy cart replace hoga aur address save hoga.', confirmText: 'Sync cart' })
      .then(confirmed => confirmed && signature === billSyncSignature() ? api('cart/sync', 'POST', {
        confirmReplaceSwiggyCart: true,
        forSomeoneElse: cart.forSomeoneElse === true,
        coupon: '', autoCoupon: true,
        // Round 35 (boss): ek hi bill — jo dikha wahi Pay Now par bhi.
        phase: 'full'
      }) : null)
      .then(out => {
        // Do not show an old account/address/cart's quote after the user has
        // changed the current context while Swiggy was responding.
        if (!out || signature !== billSyncSignature()) return;
        merge(out);
        if (state.tab === 'search' && state.menu && !handoffShown()) {
          updateMenuCartControls(null, false);
          const outlet = document.querySelector('[data-outlet-slot="menu"]');
          if (outlet) outlet.innerHTML = renderMenuOutlet(state.menu.restaurant);
        } else if (state.tab === 'cart') render();
        else renderNav();
        if (out.cart?.quote) toast('Bill taiyar — Swiggy ka hisaab neeche hai.');
      }).catch(e => { if (signature === billSyncSignature()) toast(e?.message || 'Swiggy ne bill nahi diya.'); });
  }

  /**
   * Round 35 (boss): "BILL CHANGE HOJATA ... CONSISTENT NAHI HAI".
   * Pehle pehla bill fast aata tha aur peeche se `cart/optimize` usko badal
   * deta tha. Ab bill ek hi baar me poora aata hai (`phase: 'full'`), isliye
   * jo number Pay bar par dikha wahi checkout par jata hai. Purana helper
   * hata diya — koi chhupa hua doosra quote nahi.
   */

  function renderAccountAccess() {
    if (!state.user?.isBoss) return '';
    if (!state.access) return `<div class="card"><div class="card-title">ID access</div><p class="hint">All users have access by default.</p><button class="button soft block" data-action="access-refresh" ${state.accessLoading ? 'disabled' : ''}>${state.accessLoading ? 'Loading…' : 'Load users'}</button></div>`;
    const users = state.access.users || [];
    const accounts = state.access.accounts || [];
    const selected = users.find(u => u.id === state.accessUser) || users[0];
    if (!selected) return '<div class="card"><div class="card-title">ID access</div><p class="hint">All users have access by default.</p><button class="button soft block" data-action="access-refresh">Refresh</button></div>';
    const options = users.map(u => `<option value="${esc(u.id)}" ${u.id === selected.id ? 'selected' : ''}>${esc(u.name)} · ${esc(u.id)}</option>`).join('');
    const rows = accounts.map(a => {
      const allowed = (selected.allowed || []).includes(a.key);
      return `<div class="handoff-account"><span><strong>${esc(a.name)}</strong><small>${esc(a.phoneMasked || '')}</small></span><button type="button" class="button mini ${allowed ? 'soft' : 'primary'}" data-action="access-toggle" data-key="${esc(a.key)}" data-user="${esc(selected.id)}" data-allow="${allowed ? '0' : '1'}">${allowed ? 'Remove' : 'Allow'}</button></div>`;
    }).join('');
    return `<div class="card"><div class="card-title">ID access</div><p class="hint">All users have access by default.</p><label class="field"><span class="field-label">User</span><span class="input-wrap"><select data-input="access-user">${options}</select></span></label><div class="handoff-accounts">${rows || '<p class="hint">Pehle operator ID add karein.</p>'}</div><button class="text-button" data-action="access-refresh">Refresh</button></div>`;
  }
  function offerOutcome(track) {
    const status = String(track?.status || '').toUpperCase();
    if (track?.verified === true && ['ALREADY_CLAIMED', 'ALREADY_ACTIVE', 'ALREADY_VERIFIED'].includes(status)) return 'Already claimed';
    if (track?.verified === true && ['CLAIMED', 'ACTIVE'].includes(status)) return 'Claimed';
    if (['FAILED', 'NO_CAMPAIGN_ID', 'WRONG_REWARD', 'CLAIMED_OTHER_VALUE', 'AUTH_FAILED', 'RATE_LIMITED'].includes(status)) return 'Failed';
    // Unknown, pending, and partial outcomes are not proof of either success or failure.
    return '';
  }
  function offerRows(tracks) {
    return (tracks || []).map(t => {
      const label = String(t.label || '').replace(/\s*\([^)]*\)\s*$/, '');
      const outcome = offerOutcome(t);
      return `<div class="offer-row"><span class="offer-emoji" aria-hidden="true">${t.emoji ? esc(t.emoji) : icon('spark')}</span><span class="row-content"><strong>${esc(label)}</strong></span>${outcome ? `<span class="pill ${outcome === 'Failed' ? 'amber' : 'green'}">${esc(outcome)}</span>` : ''}</div>`;
    }).join('');
  }
  function renderTools() {
    const access = renderAccountAccess();
    if (!state.accounts.length) return `${head('A LITTLE EXTRA', 'Offers & tools', '')}${access}${empty('tools', 'No account yet', 'Add an account first.')}`;
    const accounts = state.accounts.map(a => {
      const claimButton = a.canClaim !== false
        ? `<button class="button ${a.active ? 'green' : 'outline'} block" type="button" data-action="claim-offers" data-key="${esc(a.key)}" ${state.claimBusyKey === a.key || a.status === 'SESSION_EXPIRED' ? 'disabled' : ''}>${state.claimBusyKey === a.key ? 'Claiming…' : 'Claim'}</button>`
        : '';
      return `<div class="card"><div class="card-title">${tile('tools')}<span class="title-copy">${esc(a.name)}<small>${a.phone ? '+91 ' + esc(a.phone) : a.phoneMasked ? '+91 ' + esc(a.phoneMasked) : ''}</small></span></div>${offerRows(a.offerTracks)}${claimButton}</div>`;
    }).join('');
    const result = state.claimResult ? `<div class="card"><div class="card-title">${icon('check')} Claim</div>${offerRows(state.claimResult.tracks)}</div>` : '';
    // Diagnostics/backup functions remain available to the backend; these cards
    // are deliberately not mounted in the customer-facing Tools screen.
    return `${head('A LITTLE EXTRA', 'Offers & tools', '')}${access}${result}${accounts}`;
  }
  function renderConnection() {
    if (!initData) return `${head('TELEGRAM MINI APP', 'Open in Telegram', 'Your private account space needs a Telegram session.')}<div class="card connection-card"><strong>Browser preview only</strong><p>Open this app from your bot using Open App or /pro. No account data is shown here.</p></div>`;
    if (state.connecting) return `${head('CONNECTING', 'Preparing your space', 'Telegram session aur storage check ho raha hai…')}<div role="status">${skeletonRows(3, 2)}</div>`;
    let title = 'Unable to connect';
    let message = state.authError || 'Please retry, or reopen the app from your Telegram bot.';
    if (state.authErrorCode === 'PRO_VAULT_NOT_CONFIGURED') {
      // 31-10-2026: ye haalat ab normally nahi aati — server khud stable key
      // bana leta hai. Phir bhi aaye to dead-end nahi, seedha next step.
      title = 'Ek baar retry karein';
      message = 'Server ne storage key abhi taiyar ki hai. Neeche "Try again" dabaiye — data safe hai.';
    } else if (state.authErrorCode === 'PRO_VAULT_DECRYPT_FAILED') {
      title = 'Purana data is key se nahi khul raha';
      message = 'Aapka saved data waisa hi rakha hai (kuch delete nahi hua). Bot owner ko batayein: server par wahi purana PRO_VAULT_KEY wapas lagana hoga.';
    }
    return `${head('CONNECTION', title, 'Your account data has not been changed.')}<div class="card connection-card" role="alert"><strong>${esc(title)}</strong><p>${esc(message)}</p><button class="button primary block" type="button" data-action="retry-auth">Try again ${icon('refresh')}</button></div>`;
  }
  /**
   * Boss (31-10-2026, round 13): "2 minutes of activity ke baad pura order
   * band ho jayega." Server har request par yeh khud karta hai; app sirf itna
   * karta hai ki 2 minute baad khud refresh ho kar band hua order dikha de
   * (user ko button dabane ki zaroorat nahi).
   */
  let idleTimer = null;
  function payDeadline() {
    const timeout = Number(state.idle?.timeoutMs || 0) || 2 * 60 * 1000;
    const fetched = Date.parse(String(state.cart?.quote?.fetchedAt || ''));
    if (!Number.isFinite(fetched)) return 0;
    return fetched + timeout;
  }
  function payRemaining() {
    const deadline = payDeadline();
    return deadline ? Math.max(0, deadline - Date.now()) : 0;
  }
  function scheduleIdleRefresh() {
    clearTimeout(idleTimer);
    const timeout = Number(state.idle?.timeoutMs || 0);
    if (!timeout) return;
    const hasDraft = Boolean(state.cart || (state.checkout && state.checkout.status !== 'PAID'));
    if (!hasDraft) return;
    // Bill aane se pehle clock shuru hi nahi hota (server bhi yahi maanta hai).
    // Bill load ho raha ho to refresh bhi nahi — warna adhoora page saaf dikhta.
    const hasQuote = Boolean(state.cart?.quote && Number.isFinite(Date.parse(String(state.cart.quote.fetchedAt || ''))));
    const left = hasQuote ? payRemaining() : 0;
    // Bill aa chuka aur waqt nikal gaya — turant server se sach lete hain.
    if (hasQuote && !left) {
      idleTimer = setTimeout(async () => {
        try { merge(await api('bootstrap')); render(); } catch { /* net */ }
      }, 600);
      return;
    }
    if (!left) return;
    idleTimer = setTimeout(async () => {
      if (state.loading > 0) { scheduleIdleRefresh(); return; }
      try {
        const out = await api('bootstrap');
        merge(out); render();
      } catch { /* net gaya — agla render phir try karega */ }
    }, left + 1500);
  }
  /**
   * Boss (01-11-2026, round 32): "QR AYE TO WO QR 5 MINUTE TAK PAYMENT VERIFY
   * KARTE RAHE" — QR aane ke baad poore 5 minute tak khud check hota hai.
   *
   * Pehla check 5s baad (UPI turant ho jata hai), phir har 5s — total 5:00.
   * 5 minute poore hone par jhooth nahi bolte: "5 minute poore, ab khud check
   * karein" + button. Verify hote hi seedha My Orders → order detail + share link.
   */
  const PAY_WINDOW_MS = 5 * 60 * 1000;
  const PAY_POLL_MS = 5000;
  let paymentPollTimer = null;
  let payTicker = null;
  function stopPaymentPoll() {
    clearTimeout(paymentPollTimer);
    paymentPollTimer = null;
    clearInterval(payTicker);
    payTicker = null;
  }
  function payWindowStart() {
    if (!state.payWindow) {
      state.payWindow = { startedAt: Date.now(), until: Date.now() + PAY_WINDOW_MS };
      state.payTicks = 0;
      state.payExpired = false;
    }
    return state.payWindow;
  }
  function payRemainingMs() {
    if (!state.payWindow) return PAY_WINDOW_MS;
    return Math.max(0, state.payWindow.until - Date.now());
  }
  /** "4:37" jaisa — UI me dikhta hai, isliye user ko lagta hai app kaam kar raha hai. */
  function payClock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }
  function startPayTicker() {
    if (payTicker) return;
    payTicker = setInterval(() => {
      const pending = state.checkout && state.checkout.status === 'PAYMENT_PENDING' && state.checkout.paymentVerified !== true;
      if (!pending) { clearInterval(payTicker); payTicker = null; return; }
      if (payRemainingMs() <= 0) {
        clearInterval(payTicker); payTicker = null;
        state.payExpired = true;
        stopPaymentPoll();
        render();
        return;
      }
      // Sirf countdown wala hissa badalta hai — poora re-render nahi (QR flash na kare).
      const el = document.querySelector('[data-pay-clock]');
      if (el) el.textContent = payClock(payRemainingMs());
    }, 1000);
    if (typeof payTicker?.unref === 'function') payTicker.unref();
  }
  // Test/debug hook: 5 minute ka intezaar kiye bina wahi halat banana.
  try {
    window.__expirePayWindow = () => {
      state.payWindow = { startedAt: Date.now() - PAY_WINDOW_MS - 1000, until: Date.now() - 1000 };
      state.payExpired = true;
      stopPaymentPoll();
      render();
    };
  } catch { /* window band */ }
  function schedulePaymentPoll() {
    const c = state.checkout;
    const pending = c && c.status === 'PAYMENT_PENDING' && c.paymentVerified !== true;
    if (!pending) { stopPaymentPoll(); return; }
    payWindowStart();
    if (state.payExpired || payRemainingMs() <= 0) {
      state.payExpired = true;
      return stopPaymentPoll();
    }
    startPayTicker();
    if (paymentPollTimer) return;
    const delay = state.payTicks === 0 ? 5000 : PAY_POLL_MS;
    paymentPollTimer = setTimeout(async () => {
      paymentPollTimer = null;
      state.payTicks += 1;
      try {
        const out = await api('checkout/status', 'POST', {});
        merge(out);
        render();
        if (out.checkout?.status === 'PAID' && out.checkout.orderId) {
          stopPaymentPoll();
          state.payWindow = null;
          state.payExpired = false;
          toast('Payment verify ho gayi — My Orders me order khul gaya.', 'ok');
          openOrdersForOrder(out.checkout.orderId, { share: true });
          return;
        }
      } catch { /* net gaya — agla render phir schedule karega */ }
      if (payRemainingMs() <= 0) {
        state.payExpired = true;
        stopPaymentPoll();
        render();
        return;
      }
      schedulePaymentPoll();
    }, delay);
    if (typeof paymentPollTimer?.unref === 'function') paymentPollTimer.unref();
  }
  /**
   * Payment verify hone ke baad: My Orders khulta hai aur wahi order khud khul
   * jata hai. Boss ne kaha "three dot → Share" — Swiggy app ke andar ke dots hum
   * dabate nahi (wo app hamare control me nahi), par wahi share link Swiggy se
   * nikaal kar yahan de dete hain: copy + Telegram share.
   */
  async function openOrdersForOrder(orderId, { share = false } = {}) {
    if (state.chatHandoff) state.handoffHidden = true;
    state.tab = 'orders';
    state.ordersScope = 'active';
    state.ordersFilter = 'all';
    state.order = null;
    state.orderTracking = null;
    state.shareNote = '';
    writeCache({ tab: 'orders' });
    render(); window.scrollTo(0, 0);
    try {
      if (state.orders === null) await loadOrders();
    } catch { /* niche asli wajah dikh jayegi */ }
    const found = (state.orders || []).find(o => String(o.id) === String(orderId));
    if (found) {
      state.order = found;
      render();
      // Order detail khulte hi tracking + share link khud aa jate hain.
      await loadOrderTracking(found.id);
    }
    if (share) {
      state.shareWanted = true;
      render();
    }
  }
  function handoffShown() {
    return Boolean(state.auth && state.chatHandoff && !state.handoffHidden);
  }
  function renderHandoffBill(q, cart) {
    if (!q) return '<div class="warning">Swiggy ka bill abhi nahi aaya.</div>';
    const rows = [
      ['Items', q.itemTotal], ['Delivery', q.deliveryFee], ['Packing', q.packingCharges],
      ['Taxes & other charges', q.taxes], ['Coupon discount', q.discount == null ? null : -Math.abs(Number(q.discount))],
      ['Free cash', q.freeCash == null ? null : -Math.abs(Number(q.freeCash))],
      ['One membership', q.oneMembershipFee]
    ].filter(([, v]) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)));
    return `<div class="card"><div class="card-title">${icon('receipt')} Swiggy bill</div>${rows.map(([label, value]) => `<div class="bill-row"><span>${esc(label)}</span><strong>${Number(value) < 0 ? '−' : ''}${money(Math.abs(Number(value)))}</strong></div>`).join('')}<div class="bill-row total"><span>To pay</span><strong>${money(q.total)}</strong></div>${q.mismatch ? '<p class="warning">Bill ki lines total se match nahi hui. Swiggy total dobara check karein.</p>' : ''}${q.quickBill ? '<p class="hint">Extra offers abhi check nahi hue.</p>' : ''}</div>`;
  }
  function renderChatHandoff() {
    const h = state.chatHandoff;
    if (!h) return '';
    if (state.checkout) return `${head('', 'Existing order', '')}${renderCheckout()}<p class="hint">Naye links chat mein saved hain.</p>`;
    if (h.pendingId && state.handoffIgnorePending !== h.pendingId) {
      const note = h.blockedByChatOrder
        ? '<div class="warning">Chat mein active order hai. Pehle usko check karein.</div>'
        : h.existingDraft ? '<p class="hint">Mini App mein pehle se draft hai.</p>' : '';
      return `${head('', 'Chat se links mile', '')}<div class="card"><p>Cart aur address Mini App mein kholne ke liye continue karein.</p>${note}<button class="button primary block" data-action="handoff-start" ${h.blockedByChatOrder ? 'disabled' : ''}>Continue</button>${h.activeId ? '<button class="button soft block" data-action="handoff-keep">Pehla draft continue karein</button>' : ''}</div>`;
    }
    if (!h.activeId) return '';
    const back = `<button class="text-button" type="button" data-action="handoff-leave" ${state.handoffBusy ? 'disabled' : ''}>Link flow band karein</button>`;
    const change = h.stage !== 'ACCOUNT' ? `<button class="text-button" type="button" data-action="handoff-reselect" ${state.handoffBusy ? 'disabled' : ''}>ID badlein</button>` : '';
    const footer = `<div class="handoff-links">${change}${back}</div>`;
    const steps = [['ACCOUNT', 'ID'], ['ADDRESS', 'Address'], ['CART', 'Cart'], ['BILL', 'Bill']];
    const stageIndex = steps.findIndex(([stage]) => stage === h.stage);
    const progress = stageIndex < 0 ? '' : `<nav class="handoff-steps" aria-label="Chat link order steps">${steps.map(([stage, label], index) => `<span class="handoff-step ${index < stageIndex ? 'done' : index === stageIndex ? 'current' : ''}" ${stage === h.stage ? 'aria-current="step"' : ''}><span class="handoff-step-number">${index + 1}</span><span>${label}</span></span>`).join('')}</nav>`;
    const loading = state.handoffBusy ? '<p class="hint">Swiggy se check ho raha hai…</p>' : '';
    const failed = state.handoffError ? `<div class="warning" role="alert">${esc(state.handoffError)}</div><button class="button soft block" data-action="handoff-retry">Dobara try karein</button><p class="hint">Link na khule to chat mein naya link bhejein.</p>` : '';
    if (h.stage === 'ACCOUNT') {
      const rows = state.accounts.map(a => {
        const allowed = a.selectable || a.needsConfirm;
        const detail = [a.phoneMasked || a.phone || '', a.status === 'UNVERIFIED' ? 'Not verified' : a.status || ''].filter(Boolean).join(' · ');
        return `<button type="button" class="handoff-account" data-action="handoff-choose" data-key="${esc(a.key)}" ${allowed && !state.handoffBusy ? '' : 'disabled'}><span><strong>${esc(a.name || 'Swiggy ID')}</strong><small>${esc(detail || a.reason || '')}</small></span><span>${allowed ? 'Choose' : 'Unavailable'}</span></button>`;
      }).join('');
      return `${progress}${head('', 'Choose ID', '')}<div class="card"><button class="button primary block" data-action="handoff-auto" ${state.accounts.some(a => a.selectable) && !state.handoffBusy ? '' : 'disabled'}>Auto Choose</button><p class="hint">Ya ID chunein:</p><div class="handoff-accounts">${rows || '<p class="hint">Koi ID available nahi hai. Admin se baat karein.</p>'}</div>${loading}</div>${footer}`;
    }
    if (h.stage === 'ADDRESS') {
      const a = h.address;
      if (!a) return `${progress}${head('', 'Address', '')}<div class="card">${failed || loading || '<p class="hint">Address link khol rahe hain…</p>'}</div>${footer}`;
      const name = state.handoffName === null ? a.name || '' : state.handoffName;
      const mobile = state.handoffMobile === null ? a.mobile || '' : state.handoffMobile;
      return `${progress}${head('', 'Address confirm karein', '')}<div class="card"><p>${esc(a.address)}${a.area ? ', ' + esc(a.area) : ''}${a.city ? ', ' + esc(a.city) : ''}</p><form data-form="handoff-address">${field('Receiver name', 'receiver_name', 'Naam', name, 'required maxlength="120"')}${field('Mobile number', 'receiver_mobile', '10-digit mobile', mobile, 'required inputmode="tel" maxlength="16"')}<button class="button primary block" type="submit">Confirm address</button></form></div>${footer}`;
    }
    if (h.stage === 'CART') {
      if (!h.cartFetched || !state.cart) return `${progress}${head('', 'Cart', '')}<div class="card">${failed || loading || '<p class="hint">Cart link khol rahe hain…</p>'}</div>${footer}`;
      const items = state.cart.items.map(i => `<div class="bill-row"><span>${esc(i.name || 'Item')}</span><strong>× ${esc(i.qty || i.quantity || 1)}</strong></div>`).join('');
      return `${progress}${head('', 'Cart check karein', '')}<div class="card"><div class="card-title">${esc(state.cart.restaurantName || 'Restaurant')}</div>${items}<p class="hint">Continue karne par selected ID ka Swiggy cart replace hoga aur address save hoga.</p>${failed}${loading}<button class="button primary block" data-action="handoff-bill" ${state.handoffBusy ? 'disabled' : ''}>Continue to bill</button></div>${footer}`;
    }
    if (h.stage === 'BILL' && state.cart?.quote) {
      const a = state.selectedAddress || {};
      const items = (state.cart.items || []).map(i => `<div class="bill-row"><span>${esc(i.name || 'Item')}</span><strong>× ${esc(i.qty || i.quantity || 1)}</strong></div>`).join('');
      const fee = state.orderFee?.exempt ? 'Bot order fee: free' : `Bot wallet fee: ${money(Number(state.orderFee?.paise || 0) / 100)}`;
      return `${progress}${head('', 'Bill & Pay', '')}<div class="card"><strong>${esc(state.cart.restaurantName || 'Restaurant')}</strong>${items}<p class="hint">${esc(a.name || '')} · ${esc(a.mobile || '')}<br>${esc(a.address || '')}</p></div>${renderHandoffBill(state.cart.quote, state.cart)}<p class="hint">${esc(fee)}</p>${state.checkoutWarning ? `<div class="warning" role="alert">${esc(state.checkoutWarning)}</div>` : ''}${loading}<button class="button green block" data-action="checkout-start" ${!state.checkoutEnabled || state.handoffBusy ? 'disabled' : ''}>Pay Now · ${money(state.cart.quote.total)}</button>${state.checkoutEnabled ? '' : `<p class="warning">${esc(state.checkoutBlockReason || 'Payment abhi band hai.')}</p>`}${state.cart.quote.quickBill ? `<button class="button soft block" data-action="handoff-offers" ${state.handoffBusy ? 'disabled' : ''}>Find offers</button>` : ''}${footer}`;
    }
    return `<div class="card"><p>Draft refresh karein.</p><button class="button primary block" data-action="handoff-refresh">Refresh</button></div>`;
  }
  async function fetchHandoffPart(stage) {
    if (state.handoffBusy || !state.chatHandoff?.activeId) return;
    state.handoffBusy = true; state.handoffError = ''; render();
    try {
      const out = await api('chat-handoff/' + (stage === 'ADDRESS' ? 'address' : 'cart'), 'POST', { handoffId: state.chatHandoff.activeId });
      merge(out);
      if (stage === 'ADDRESS') { state.handoffName = null; state.handoffMobile = null; }
    } catch (e) {
      state.handoffError = e?.message || 'Swiggy se jawab nahi mila.';
    } finally {
      state.handoffBusy = false; render();
    }
  }
  function maybeFetchHandoff() {
    const h = state.chatHandoff;
    if (!handoffShown() || state.checkout || state.handoffBusy || !h?.activeId ||
        (h.pendingId && state.handoffIgnorePending !== h.pendingId)) return;
    const needs = (h.stage === 'ADDRESS' && !h.address) || (h.stage === 'CART' && !h.cartFetched);
    if (!needs) return;
    const signature = `${h.activeId}:${h.stage}`;
    if (state.handoffAutoFor === signature) return;
    state.handoffAutoFor = signature;
    queueMicrotask(() => fetchHandoffPart(h.stage));
  }
  let renderedView = '';
  let viewAnimationTimer = null;
  let renderedReceiverSources = {};
  // Keep unsaved receiver edits only while the same server address is on the
  // same screen. These values stay in the DOM/in-memory, never in the cache.
  function receiverSources(root) {
    const key = a => JSON.stringify([state.activeAccount?.key || '', a?.ref || '', a?.id || '', a?.address || '', a?.lat || '', a?.lng || '', a?.name || '', a?.mobile || '']);
    const sources = {};
    if (root.querySelector('form[data-form="contact"]')) sources.contact = key(state.selectedAddress);
    if (root.querySelector('form[data-form="confirm-address"]')) sources['confirm-address'] = key(state.pendingAddress);
    return sources;
  }
  function rememberReceiverInputs(root) {
    return Object.entries(renderedReceiverSources).map(([type, source]) => {
      const form = root.querySelector(`form[data-form="${type}"]`);
      if (!form) return null;
      const values = {};
      for (const name of ['name', 'mobile']) {
        const input = form.elements.namedItem(name);
        if (input && 'value' in input) values[name] = input.value;
      }
      return { type, source, values };
    }).filter(Boolean);
  }
  function restoreReceiverInputs(root, drafts, sources) {
    for (const draft of drafts) {
      if (draft.source !== sources[draft.type]) continue;
      const form = root.querySelector(`form[data-form="${draft.type}"]`);
      if (!form) continue;
      for (const [name, value] of Object.entries(draft.values)) {
        const input = form.elements.namedItem(name);
        if (input && 'value' in input) input.value = value;
      }
    }
  }
  function viewKey() {
    if (!state.auth) return 'connection';
    if (handoffShown()) return `handoff:${state.chatHandoff?.stage || ''}:${Boolean(state.checkout)}`;
    if (state.tab === 'search') return state.menu ? 'search:menu' : 'search';
    if (state.tab === 'cart') return state.track ? 'cart:track' : state.couponView ? 'cart:coupons' : state.checkout?.status === 'PAYMENT_PENDING' ? 'cart:payment' : 'cart';
    if (state.tab === 'orders') return state.order ? 'orders:detail' : 'orders';
    return state.tab;
  }
  // Async responses can repaint a view while the keyboard is open. Retain only
  // the currently focused control and its value; never put it in localStorage.
  function describeFocus(el) {
    if (!el) return null;
    const form = el.closest('form[data-form]');
    const field = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && el.type !== 'file';
    if (field && (el.id || el.name || el.dataset.input)) {
      const saved = { field: true, tag: el.tagName, id: el.id, name: el.name, input: el.dataset.input, form: form?.dataset.form || '', value: el.value };
      try { saved.start = el.selectionStart; saved.end = el.selectionEnd; } catch { /* not a text input */ }
      return saved;
    }
    if (el.dataset?.action) {
      const data = {};
      for (const key of ['key', 'code', 'ref', 'filter', 'id', 'user', 'qty', 'tab', 'mode', 'allow']) data[key] = el.dataset[key] || '';
      return { action: el.dataset.action, data };
    }
    if (el.tagName === 'BUTTON' && form?.dataset.form && el.type === 'submit') return { submit: true, form: form.dataset.form };
    return null;
  }
  function rememberFocus(root) {
    const el = document.activeElement;
    return el && root.contains(el) ? describeFocus(el) : null;
  }
  function restoreFocus(root, saved) {
    if (!saved) return false;
    const nodes = root.querySelectorAll(saved.field ? 'input,textarea,select' : saved.submit ? 'form[data-form] button' : '[data-action]');
    const el = Array.from(nodes).find(node => {
      if (node.disabled || node.closest('[inert], [hidden]')) return false;
      if (saved.field) return node.tagName === saved.tag && (saved.id ? node.id === saved.id : saved.input ? node.dataset.input === saved.input : node.name === saved.name && (node.closest('form[data-form]')?.dataset.form || '') === saved.form);
      if (saved.submit) return node.type === 'submit' && node.closest('form[data-form]')?.dataset.form === saved.form;
      return node.dataset.action === saved.action && Object.entries(saved.data || {}).every(([key, value]) => (node.dataset[key] || '') === value);
    });
    if (!el) return false;
    if (saved.field) {
      try { el.value = saved.value; } catch { /* unsupported input type */ }
    }
    try { el.focus({ preventScroll: true }); } catch { el.focus(); }
    if (saved.field && saved.start !== null && saved.start !== undefined) {
      try { el.setSelectionRange(saved.start, saved.end); } catch { /* unsupported input type */ }
    }
    return true;
  }
  function setCouponChromeInert(open) {
    for (const el of [$('.topbar'), $('#bottom-nav'), $('#cart-dock')]) {
      if (!el) continue;
      if (open) { el.setAttribute('inert', ''); el.setAttribute('aria-hidden', 'true'); }
      else { el.removeAttribute('inert'); el.removeAttribute('aria-hidden'); }
    }
  }
  function render() {
    // Telegram WebView band hone ke baad bhi async response aa sakta hai —
    // tab render chup-chaap rukna chahiye, window crash nahi.
    try {
      const content = $('#content');
      const nextView = viewKey();
      const wasCouponOpen = Boolean(content.querySelector('.coupon-sheet'));
      const previousReceiverSources = renderedReceiverSources;
      const receiverDrafts = renderedView === nextView ? rememberReceiverInputs(content) : [];
      let focus = renderedView === nextView ? rememberFocus(content) : null;
      // Re-render par user ka typed text na ude (coupon code / group cart link).
      try {
        const couponInput = document.querySelector('input[name="coupon"]');
        if (couponInput) state.couponDraft = couponInput.value;
        const cartInput = document.querySelector('form[data-form="group-cart"] input[name="url"]');
        if (cartInput) state.groupCartDraft = cartInput.value;
      } catch { /* window band ho gaya */ }
      const couponSheetBefore = content.querySelector('.coupon-sheet');
      const couponSheetScroll = couponSheetBefore ? couponSheetBefore.scrollTop : 0;
      const views = { accounts: renderAccounts, address: renderAddress, search: renderSearch, cart: renderCart, orders: renderOrders, tools: renderTools };
      content.innerHTML = state.auth ? (handoffShown() ? renderChatHandoff() : views[state.tab]()) : renderConnection();
      const couponSheetAfter = content.querySelector('.coupon-sheet');
      if (couponSheetAfter && couponSheetScroll) couponSheetAfter.scrollTop = couponSheetScroll;
      if (state.auth && state.tab === 'search' && state.menu && !handoffShown()) applyMenuSearch();
      const nextReceiverSources = receiverSources(content);
      restoreReceiverInputs(content, receiverDrafts, nextReceiverSources);
      // A newly resolved/selected address must keep its own auto-filled fields,
      // rather than inheriting focus/value from the previous recipient.
      if (focus?.field && Object.hasOwn(previousReceiverSources, focus.form) && previousReceiverSources[focus.form] !== nextReceiverSources[focus.form]) focus = null;
      renderedReceiverSources = nextReceiverSources;
      renderNav();
      renderThemeControl();
      const couponOpen = Boolean(content.querySelector('.coupon-sheet'));
      setCouponChromeInert(couponOpen);
      if (couponOpen && !wasCouponOpen) {
        try { content.querySelector('.coupon-sheet [data-action="coupon-back"]')?.focus({ preventScroll: true }); } catch { /* WebView closed */ }
      } else if (focus && !restoreFocus(content, focus) && couponOpen) {
        try { content.querySelector('.coupon-sheet [data-action="coupon-back"]')?.focus({ preventScroll: true }); } catch { /* WebView closed */ }
      }
      if (renderedView !== nextView) {
        content.classList.remove('view-enter');
        void content.offsetWidth;
        content.classList.add('view-enter');
        clearTimeout(viewAnimationTimer);
        viewAnimationTimer = setTimeout(() => content.classList.remove('view-enter'), 260);
      }
      renderedView = nextView;
      $('#connection-notice').hidden = true;
      if (state.idleClosed) {
        const closed = state.idleClosed;
        state.idleClosed = null;
        toast(closed.message || 'Draft order band ho gaya (2 minute tak koi activity nahi).');
      }
      maybeAutoBill();
      maybeFetchHandoff();
      scheduleIdleRefresh();
      schedulePaymentPoll();
    } catch { /* window band ho gaya */ }
  }
  async function reconnect() {
    if (!initData || state.connecting) return;
    state.connecting = true;
    state.auth = false;
    state.authError = '';
    state.authErrorCode = '';
    render();
    try {
      merge(await api('bootstrap'));
      state.auth = true;
    } catch (err) {
      state.authError = err?.message || 'Could not connect. Please retry.';
      state.authErrorCode = err?.code || '';
    } finally {
      state.connecting = false;
      render();
    }
  }
  async function navigate(tab) {
    menuRequestVersion++; searchRequestVersion++;
    state.menuLoading = false; state.resultsLoading = false;
    if (tab === 'orders' && state.ordersScope !== 'active') {
      state.ordersScope = 'active';
      state.orders = null;
    }
    state.tab = tab;
    writeCache({ tab });
    state.order = null;
    if (tab !== 'search') state.menu = null;
    render(); window.scrollTo({ top: 0, behavior: 'auto' });
    if (state.auth && state.activeAccount && tab === 'address' && !state.addresses.length) await loadAddresses();
    if (state.auth && state.activeAccount && tab === 'orders' && state.orders === null) await loadOrders();
    if (state.auth && state.user?.isBoss && tab === 'tools' && !state.access) await loadAccountAccess();
  }
  async function loadAccountAccess() {
    if (state.accessLoading) return;
    state.accessLoading = true; render();
    try {
      const out = await api('boss/account-access');
      state.access = out.access;
      if (!(state.access?.users || []).some(u => u.id === state.accessUser)) state.accessUser = state.access?.users?.[0]?.id || '';
    } finally { state.accessLoading = false; if (state.tab === 'tools') render(); }
  }
  let addressRequestVersion = 0;
  let ordersRequestVersion = 0;
  async function loadAddresses() {
    const request = ++addressRequestVersion;
    const accountKey = state.activeAccount?.key || '';
    state.addressesLoading = true; render();
    try {
      const data = await api('addresses');
      if (request !== addressRequestVersion || (state.activeAccount?.key || '') !== accountKey) return;
      state.addresses = data.addresses; state.addressNote = data.note || '';
    } finally {
      if (request === addressRequestVersion) state.addressesLoading = false;
      if (request === addressRequestVersion && state.tab === 'address') render();
    }
  }
  async function loadOrders() {
    const request = ++ordersRequestVersion;
    const accountKey = state.activeAccount?.key || '';
    const scope = state.ordersScope;
    state.ordersLoading = true; render();
    try {
      const data = await api('orders' + (scope === 'checkout' ? '?scope=checkout' : ''));
      if (request !== ordersRequestVersion || (state.activeAccount?.key || '') !== accountKey || state.ordersScope !== scope) return;
      state.orders = data.orders;
      if (typeof data.detailAllowed === 'boolean') state.ordersDetailAllowed = data.detailAllowed;
    } finally {
      if (request === ordersRequestVersion) state.ordersLoading = false;
      if (request === ordersRequestVersion && state.tab === 'orders') render();
    }
  }
  async function search(q) {
    const request = ++searchRequestVersion;
    menuRequestVersion++;
    const context = JSON.stringify([state.activeAccount?.key || '', state.selectedAddress || null]);
    state.searchQuery = q; state.resultsLoading = true; render();
    try {
      const data = await api('search?q=' + encodeURIComponent(q));
      if (request !== searchRequestVersion || state.tab !== 'search' || context !== JSON.stringify([state.activeAccount?.key || '', state.selectedAddress || null])) return;
      state.results = data.restaurants; state.menu = null;
    } finally {
      if (request === searchRequestVersion) state.resultsLoading = false;
      if (request === searchRequestVersion && state.tab === 'search') render();
    }
  }
  // ── Meal rail, coupons aur tracking ────────────────────────────────────────
  /** Isi restaurant ka menu ek hi baar load hota hai ("Complete your meal"). */
  function maybeLoadMeal(cart) {
    const id = String(cart?.restaurantId || '');
    if (!id || state.mealFor === id || state.mealLoading) return;
    const request = ++mealRequestVersion;
    const context = cartSourceContext();
    const current = () => request === mealRequestVersion && context === cartSourceContext();
    state.mealFor = id;
    state.mealLoading = true;
    api('menu?id=' + encodeURIComponent(id))
      .then(out => { if (current()) state.meal = out; })
      // A failed or stale request must not trigger a repaint/refetch loop.
      .catch(() => { if (current()) state.meal = null; })
      .finally(() => { if (request === mealRequestVersion) { state.mealLoading = false; if (state.tab === 'cart' && !state.track) render(); } });
  }
  /**
   * Round 29 (boss): "EK PAGE ME SAARI INFORMATION WO DE RAHA" — coupons bhi
   * cart page par hi, isliye cart khulte hi ek baar list khud aa jati hai.
   * Same restaurant ke liye dobara nahi (loop nahi).
   */
  function maybeAutoCoupons() {
    if (state.coupons !== null || state.couponsLoading) return;
    const id = String(state.cart?.restaurantId || '');
    if (!id) return;
    if (state.autoCouponsFor === id) return;
    state.autoCouponsFor = id;
    loadCoupons();
  }
  async function loadCoupons(force = false) {
    if (state.couponsLoading && !force) return;
    const id = String(state.cart?.restaurantId || '');
    if (!id) return;
    const request = ++couponRequestVersion;
    const context = cartSourceContext();
    const current = () => request === couponRequestVersion && context === cartSourceContext();
    state.couponsLoading = true; state.couponsError = ''; render();
    try {
      const out = await api('coupons?id=' + encodeURIComponent(id));
      if (!current()) return;
      state.coupons = Array.isArray(out.coupons) ? out.coupons : [];
      state.couponsNote = out.note || '';
      state.couponsError = '';
    } catch (e) {
      if (!current()) return;
      state.coupons = [];
      state.couponsError = e.message || 'Coupon list nahi aayi.';
      state.couponsNote = state.couponsError;
    } finally {
      if (request === couponRequestVersion) { state.couponsLoading = false; if (state.tab === 'cart' && !state.track) render(); }
    }
  }
  let trackTimer = null;
  function stopTrackPolling() { if (trackTimer) { clearTimeout(trackTimer); trackTimer = null; } }
  function scheduleTrackPolling() {
    stopTrackPolling();
    trackTimer = setTimeout(() => { trackTimer = null; if (state.track && document.getElementById('content')) loadTrack(); }, 20000);
  }
  /** Order detail ka tracking + share link khud laata hai (Refresh dabana zaroori nahi). */
  async function loadOrderTracking(id) {
    if (!id || String(state.order?.id || '') !== String(id)) return null;
    const scope = state.ordersScope === 'checkout' ? '&scope=checkout' : '';
    const accountKey = state.activeAccount?.key || '';
    const stillCurrent = () => String(state.order?.id || '') === String(id) && (state.activeAccount?.key || '') === accountKey && (state.ordersScope === 'checkout' ? '&scope=checkout' : '') === scope;
    state.orderLinkLoading = true;
    render();
    try {
      const out = await api('orders/tracking?id=' + encodeURIComponent(id) + scope);
      if (!stillCurrent()) return null;
      state.orderTracking = out.tracking || null;
      state.orderSms = out.sms || null;
      return state.orderTracking;
    } catch {
      if (stillCurrent()) state.orderTracking = null;
      return null;
    } finally {
      if (stillCurrent()) { state.orderLinkLoading = false; render(); }
    }
  }
  async function loadTrack() {
    if (!state.track) return;
    const scope = state.track.scope === 'checkout' ? '&scope=checkout' : '';
    state.trackBusy = true; render();
    try {
      const out = await api('orders/tracking?id=' + encodeURIComponent(state.track.id) + scope);
      state.trackData = out.tracking || null;
      state.trackSms = out.sms || null;
      state.trackError = '';
    } catch (e) {
      state.trackError = e.message || 'Tracking nahi mili.';
    } finally {
      state.trackBusy = false; render(); scheduleTrackPolling();
    }
  }
  function startTracking(orderId, scope = 'active') {
    if (!orderId) return;
    if (state.chatHandoff) state.handoffHidden = true;
    state.track = { id: String(orderId), scope };
    state.trackData = null;
    state.trackError = '';
    state.couponView = false;
    state.tab = 'cart';
    writeCache({ tab: 'cart' });
    render(); window.scrollTo(0, 0);
    loadTrack();
  }
  /** Receiver ka naam + 10-digit mobile Swiggy maangta hai — pehle wahin bhejo. */
  function receiverReady() {
    const addr = state.selectedAddress;
    if (!addr) {
      state.tab = 'address'; writeCache({ tab: 'address' }); render();
      toast('Pehle delivery address chunein.', 'bad');
      return false;
    }
    const mobile = String(addr.mobile || '').replace(/\D/g, '').slice(-10);
    if (!String(addr.name || '').trim() || mobile.length !== 10) {
      state.tab = 'address'; state.contactEdit = true; writeCache({ tab: 'address' }); render();
      toast('Receiver ka naam aur 10-digit mobile bhar dein — Swiggy iske bina bill/order nahi deta.', 'bad');
      return false;
    }
    return true;
  }
  let couponReturnAction = 'coupon-open';
  let couponReturnY = 0;
  /** Coupon APPLY — seedha Swiggy bill. Koi code type nahi, koi extra tap nahi. */
  function closeCouponSheet() {
    state.couponView = false; render();
    window.scrollTo({ top: couponReturnY, behavior: 'auto' });
    const original = document.querySelector(`[data-action="${couponReturnAction}"]`);
    const trigger = original || document.querySelector('[data-action="toggle-coupon"]');
    if (trigger) {
      if (!original) trigger.scrollIntoView?.({ block: 'center', behavior: 'auto' });
      try { trigger.focus({ preventScroll: true }); } catch { trigger.focus(); }
    }
  }
  async function applyCoupon(code, button) {
    const value = String(code || '').trim().toUpperCase();
    if (!value || state.couponBusy || cartLocked()) return;
    if (!receiverReady()) return;
    const request = ++couponWriteVersion;
    const signature = billSyncSignature();
    const current = () => request === couponWriteVersion && signature === billSyncSignature();
    state.couponBusy = value; render();
    try {
      const out = await api('cart/sync', 'POST', {
        coupon: value, autoCoupon: false,
        forSomeoneElse: state.cart?.forSomeoneElse === true,
        confirmReplaceSwiggyCart: true, phase: 'full'
      });
      if (!current()) return;
      merge(out);
      const q = state.cart?.quote;
      const actual = String(q?.couponCode || q?.coupon || '').toUpperCase();
      const saved = couponSaving(q);
      const applied = actual === value && (saved > 0 || q?.discountAlreadyApplied === true);
      state.couponResults = { ...(state.couponResults || {}), [value]: applied
        ? { ok: true, saved }
        : { ok: false, message: q?.couponReason || 'Swiggy ne is code par discount nahi diya.' } };
      render();
      toast(applied ? `${value} applied${saved > 0 ? ' — ' + money(saved) + ' saved' : ''}` : `${value} par Swiggy ne discount nahi diya.`, applied ? 'ok' : 'bad');
    } catch (e) {
      if (!current()) return;
      state.couponResults = { ...(state.couponResults || {}), [value]: { ok: false, message: e?.message || 'Swiggy ne ye coupon nahi liya.' } };
      render();
      throw e;
    } finally {
      if (request === couponWriteVersion) { state.couponBusy = ''; render(); }
    }
  }
  async function removeCoupon() {
    if (state.couponBusy || cartLocked() || !receiverReady()) return;
    const request = ++couponWriteVersion;
    const signature = billSyncSignature();
    state.couponBusy = '__remove__'; render();
    try {
      const out = await api('cart/sync', 'POST', {
        coupon: '', autoCoupon: false,
        forSomeoneElse: state.cart?.forSomeoneElse === true,
        confirmReplaceSwiggyCart: true, phase: 'full'
      });
      if (request !== couponWriteVersion || signature !== billSyncSignature()) return;
      merge(out);
      state.couponResults = {};
      render();
      toast('Coupon removed', 'ok');
    } finally {
      if (request === couponWriteVersion) { state.couponBusy = ''; render(); }
    }
  }
  function forms(event) {
    const form = event.target.closest('form[data-form]');
    if (!form) return;
    event.preventDefault();
    const type = form.dataset.form; const data = new FormData(form); const button = form.querySelector('button[type="submit"],button:not([type])');
    const confirmWithTrigger = options => confirmInApp({ ...options, opener: button });
    run(async () => {
      if (type === 'handoff-address') {
        const out = await api('chat-handoff/confirm-address', 'POST', {
          handoffId: state.chatHandoff?.activeId, confirmAddress: true,
          name: String(data.get('receiver_name') || '').trim(), mobile: String(data.get('receiver_mobile') || '').trim()
        });
        merge(out); state.handoffError = ''; render();
      } else if (type === 'send-otp') {
        const phone = String(data.get('phone') || '').trim();
        try {
          await api('accounts/send-otp', 'POST', { phone });
        } catch (e) {
          if (e.code !== 'SWIGGY_ACCOUNT_NOT_REGISTERED') throw e;
          // Boss (31-10-2026): "NAYA ACCOUNT HAI TO LOGIN HI NAHI HOTA."
          if (!await confirmWithTrigger({
            title: 'Naya Swiggy account banayein?',
            message: `${phone} Swiggy par naya number hai. Isi number se naya Swiggy account banega (naam: ${state.user?.name || 'aapka naam'}), phir OTP aayega. Aage ke order isi account se honge.`,
            confirmText: 'Account banayein'
          })) return;
          await api('accounts/send-otp', 'POST', { phone, signup: true });
        }
        state.otpSent = true; render(); toast('OTP request accepted by Swiggy.');
      } else if (type === 'verify-otp') {
        const out = await api('accounts/verify-otp', 'POST', { otp: data.get('otp') }); merge(out); state.otpSent = false; state.addresses = []; state.orders = null; render(); toast('Account added.');
      } else if (type === 'import') {
        const raw = String(data.get('session') || ''); let session;
        try { session = JSON.parse(raw); } catch { throw new Error('Please paste valid JSON.'); }
        const out = await api('accounts/import', 'POST', { session }); merge(out); state.addresses = []; state.orders = null; render(); toast('Session verified and added.');
      } else if (type === 'address-link') {
        const out = await api('addresses/resolve', 'POST', { url: data.get('url') }); state.pendingAddress = out.address; render();
      } else if (type === 'confirm-address' || type === 'contact') {
        const out = await api(type === 'contact' ? 'addresses/update-contact' : 'addresses/confirm', 'POST', { name: data.get('name'), mobile: data.get('mobile') });
        merge(out); state.pendingAddress = null; state.contactEdit = false; render(); toast('Receiver details selected.');
      } else if (type === 'search') {
        await search(String(data.get('q') || '').trim());
      } else if (type === 'group-cart') {
        const url = String(data.get('url') || state.groupCartDraft || '').trim();
        if (!url) { toast('Pehle group cart ka link paste karein.', 'bad'); return; }
        if (state.cart && !await confirmWithTrigger({ title: 'Draft cart replace karein?', message: 'Aapka draft cart is group cart se replace ho jayega. Purana draft chala jayega.', confirmText: 'Replace karein' })) return;
        const out = await api('cart/import-group', 'POST', { url, replace: Boolean(state.cart) });
        state.groupCartDraft = '';
        merge(out);
        const count = out.cart?.items?.reduce((n, i) => n + Number(i.qty || 0), 0) || 0;
        state.tab = 'cart'; writeCache({ tab: 'cart' }); render();
        toast(`Cart parse ho gaya — ${count} item${count === 1 ? '' : 's'}. Ab bill check karein.`);
      } else if (type === 'delete-otp') {
        const out = await api('accounts/remove/confirm', 'POST', { key: state.deleteFlow?.key, otp: data.get('otp') });
        merge(out); state.deleteFlow = null; state.addresses = []; state.orders = null; render(); toast('Account Swiggy se delete ho gaya.');
      } else if (type === 'coupon-apply') {
        const code = String(data.get('coupon') || state.couponDraft || '').trim().toUpperCase();
        if (!code) { toast('Pehle coupon code likhein.'); return; }
        await applyCoupon(code, button);
      } else if (type === 'sync') {
        // Coupon page ka APPLY bhi yahi raasta use karta hai (ek hi sach).
        const code = String(data.get('coupon') || state.couponDraft || '').trim().toUpperCase();
        if (code && !/^[A-Z0-9_-]{3,28}$/.test(code)) throw new Error('Coupon code galat lag raha hai (3-28 letters/numbers).');
        if (!await confirmWithTrigger({ title: 'Sync cart with Swiggy?', message: 'This replaces the current cart on your selected Swiggy account and may save the address there.', confirmText: 'Sync cart' })) return;
        if (!receiverReady()) return;
        // The prior quote is stale as soon as sync starts, including when the
        // response times out after Swiggy has changed the cart.
        state.cart.quote = null; render();
        const out = await api('cart/sync', 'POST', { coupon: code, forSomeoneElse: data.has('forSomeoneElse'), confirmReplaceSwiggyCart: true });
        state.couponDraft = '';
        merge(out); render();
        const applied = Number(out.cart?.quote?.discount || 0);
        toast(code ? (applied > 0 ? `Coupon ${code} lag gaya — ${money(applied)} bachaya.` : `Swiggy ne ${code} par discount nahi diya (bill me 0).`) : 'Bill returned by Swiggy. Check it before paying.');
      }
    }, button);
  }
  // Keep keyboard focus inside the coupon sheet, and allow the same Escape
  // dismissal as the in-app confirmation and outlet sheet.
  document.addEventListener('keydown', event => {
    if (confirmationOpen || dismissOutletSheet) return;
    const sheet = document.querySelector('.coupon-sheet');
    if (!sheet) return;
    if (event.key === 'Escape') { event.preventDefault(); closeCouponSheet(); return; }
    trapDialogTab(event, sheet);
  });

  // In Telegram, the on-screen keyboard may shrink either the layout viewport
  // or only visualViewport. Hide fixed bottom controls only while it obscures
  // a focused text field; they return as soon as the keyboard closes.
  let stableViewportHeight = window.innerHeight;
  function syncKeyboardViewport() {
    const active = document.activeElement;
    const editing = active && (/^(TEXTAREA)$/.test(active.tagName) || (active.tagName === 'INPUT' && !/^(button|checkbox|radio|submit|reset|file)$/i.test(active.type)) || active.isContentEditable);
    if (!editing) {
      stableViewportHeight = window.innerHeight;
      document.body.classList.remove('keyboard-open');
      return;
    }
    const viewport = window.visualViewport;
    const visibleHeight = viewport ? viewport.height + viewport.offsetTop : window.innerHeight;
    const obscured = Math.max(stableViewportHeight - window.innerHeight, window.innerHeight - visibleHeight);
    document.body.classList.toggle('keyboard-open', obscured > 140);
  }
  window.addEventListener('resize', syncKeyboardViewport);
  window.addEventListener('orientationchange', () => { stableViewportHeight = window.innerHeight; syncKeyboardViewport(); });
  window.visualViewport?.addEventListener('resize', syncKeyboardViewport);
  window.visualViewport?.addEventListener('scroll', syncKeyboardViewport);
  document.addEventListener('focusin', syncKeyboardViewport);
  document.addEventListener('focusout', () => setTimeout(syncKeyboardViewport, 0));

  function applyMenuSearch() {
    const q = String(state.menuQuery || '').trim().toLowerCase();
    for (const row of document.querySelectorAll('[data-menu-item]')) {
      row.hidden = Boolean(q) && !String(row.dataset.name || '').includes(q);
    }
    for (const block of document.querySelectorAll('[data-category-block]')) {
      block.hidden = !Array.from(block.querySelectorAll('[data-menu-item]')).some(row => !row.hidden);
    }
  }
  // Menu filtering stays in place even if an unrelated response repaints.
  document.addEventListener('input', event => {
    if (event.target.closest('form[data-form="handoff-address"]')) {
      if (event.target.name === 'receiver_name') state.handoffName = event.target.value;
      if (event.target.name === 'receiver_mobile') state.handoffMobile = event.target.value;
      return;
    }
    // Accounts search: rows DOM me hi filter hoti hain, isliye re-render nahi
    // hota aur keyboard band nahi hota (typing smooth).
    const acSearch = event.target.closest('[data-input="account-search"]');
    if (acSearch) {
      const q = String(acSearch.value || '').trim().toLowerCase();
      state.accountQuery = acSearch.value || '';
      let any = false;
      for (const row of document.querySelectorAll('.ac-row[data-search]')) {
        const hit = !q || String(row.dataset.search || '').includes(q);
        row.hidden = !hit;
        if (hit) any = true;
      }
      const none = document.querySelector('.ac-noresult-live');
      if (none) none.hidden = any || !q;
      return;
    }
    const input = event.target.closest('[data-input="menu-search"]');
    if (!input) return;
    state.menuQuery = input.value || '';
    applyMenuSearch();
  });
  document.addEventListener('change', event => {
    if (event.target.matches('[data-input="access-user"]')) { state.accessUser = event.target.value; render(); }
  });
  document.addEventListener('submit', forms);
  document.addEventListener('click', event => {
    // Clicking the background/checkmark of an account card selects the same
    // account as its primary button. Copy/delete remain separate actions.
    let button = event.target.closest('[data-action]');
    if (!button) button = event.target.closest('[data-account-row]')?.querySelector('.ac-main[data-action="account-select"]');
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    if (action === 'account-select' && button.getAttribute('aria-pressed') === 'true') return;
    if (action === 'retry-auth') { reconnect(); return; }
    if (action === 'handoff-resume') { state.handoffHidden = false; render(); return; }
    if (action === 'handoff-keep') { state.handoffIgnorePending = state.chatHandoff?.pendingId || ''; render(); return; }
    if (action === 'handoff-retry') { state.handoffError = ''; state.handoffAutoFor = ''; render(); return; }
    if (action === 'handoff-refresh') { reconnect(); return; }
    // Boss (31-10-2026): "ADDRESS PAGE LOAD HO RAHA HAI TO KISI AUR PAGE PAR
    // SHIFT NAHI HO PAA RAHA." Nav par koi busy-lock nahi — tab turant badalta hai.
    if (action === 'nav') {
      if (state.chatHandoff) state.handoffHidden = true;
      stopTrackPolling();
      if (button.dataset.tab !== 'cart') { state.track = null; state.couponView = false; }
      startLoading();
      // navigate apna render turant karta hai (await se pehle) — isliye seedha
      // bulate hain taaki tap ka asar usi pal dikhe.
      try {
        const pending = navigate(button.dataset.tab);
        if (pending && typeof pending.catch === 'function') {
          pending.catch(err => toast(err?.message || 'Page nahi khula. Dobara dabaiye.')).finally(() => stopLoading());
        } else stopLoading();
      } catch (err) {
        stopLoading();
        toast(err?.message || 'Page nahi khula. Dobara dabaiye.');
      }
      return;
    }
    if (action === 'theme') { document.body.classList.toggle('dark'); renderThemeControl(); try { localStorage.setItem('pro-theme', document.body.classList.contains('dark') ? 'dark' : 'light'); } catch {} writeCache({ theme: document.body.classList.contains('dark') ? 'dark' : 'light' }); return; }
    if (action === 'account-mode') { state.mode = button.dataset.mode; state.otpSent = false; render(); return; }
    if (action === 'otp-reset') { state.otpSent = false; render(); return; }
    if (action === 'group-cart-toggle') {
      state.groupCartOn = state.groupCartOn === false;
      render();
      return;
    }
    if (action === 'toggle-coupon' || action === 'coupon-open') { couponReturnAction = action; couponReturnY = window.scrollY || 0; state.couponView = true; state.couponOpen = true; render(); if (state.coupons === null) loadCoupons(); return; }
    if (action === 'coupon-back') { closeCouponSheet(); return; }
    if (action === 'coupon-retry') { state.coupons = null; state.couponsError = ''; loadCoupons(true); return; }
    if (action === 'coupon-sheet-stop') { return; }
    if (action === 'track-close') { stopTrackPolling(); state.track = null; state.trackData = null; state.trackError = ''; render(); window.scrollTo(0, 0); return; }
    if (action === 'outlets-toggle') {
      if (!state.cart) return;
      const restaurant = { id: state.cart.restaurantId, name: state.cart.restaurantName };
      const key = outletContext(restaurant);
      state.outletsOpen = !(state.outletsOpen && state.outletOpenFor === key);
      state.outletOpenFor = key;
      refreshOutletSlots(key);
      return;
    }
    if (action === 'delete-cancel') { state.deleteFlow = null; render(); return; }
    if (action === 'contact-edit') { state.contactEdit = !state.contactEdit; render(); return; }
    if (action === 'menu-back') { menuRequestVersion++; state.menu = null; state.menuQuery = ''; render(); return; }
    if (action === 'orders-back') { state.order = null; state.orderTracking = null; render(); return; }
    if (action === 'account-copy-json') {
      const key = String(button.dataset.key || '');
      const label = String(button.dataset.name || 'account');
      button.disabled = true;
      api('accounts/session?key=' + encodeURIComponent(key))
        .then(async out => {
          const text = JSON.stringify(out.session ?? {}, null, 2);
          try {
            if (!navigator.clipboard?.writeText) throw new Error('clipboard nahi');
            await navigator.clipboard.writeText(text);
            toast(`${label} ka JSON copy ho gaya.`, 'ok');
          } catch {
            // Purane WebView me clipboard API nahi hoti — textarea + execCommand
            // se copy karte hain, warna user ko chup-chaap kuch na milta.
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.append(ta);
            ta.select();
            let ok = false;
            try { ok = document.execCommand('copy'); } catch { ok = false; }
            ta.remove();
            toast(ok ? `${label} ka JSON copy ho gaya.` : 'Copy nahi ho paya — is phone ka browser clipboard band karta hai.', ok ? 'ok' : 'bad');
          }
        })
        .catch(err => toast(err?.message || 'JSON nahi mila.', 'bad'))
        .finally(() => { button.disabled = false; });
      return;
    }
    if (action === 'account-filter') {
      const id = String(button.dataset.filter || '');
      const list = Array.isArray(state.accountFilters) ? state.accountFilters.slice() : [];
      if (!id) state.accountFilters = [];
      else state.accountFilters = list.includes(id) ? list.filter(x => x !== id) : [...list, id];
      render();
      return;
    }
    if (action === 'orders-filter') {
      state.ordersFilter = button.dataset.filter === 'hour' ? 'hour' : 'all';
      render(); return;
    }
    if (action === 'order-detail') {
      state.order = state.orders?.find(o => String(o.id) === button.dataset.id) || null;
      state.orderTracking = null; state.orderLinkLoading = Boolean(state.order?.id);
      render(); window.scrollTo(0,0);
      if (state.order?.id) loadOrderTracking(state.order.id);
      return;
    }
    const hadFocus = document.activeElement === button;
    const confirmWithTrigger = options => confirmInApp({ ...options, opener: button });
    run(async () => {
      if (action === 'access-refresh') { await loadAccountAccess(); }
      else if (action === 'access-toggle') {
        const target = (state.access?.users || []).find(u => u.id === button.dataset.user);
        const account = (state.access?.accounts || []).find(a => a.key === button.dataset.key);
        if (!target || !account) throw new Error('User ya ID dobara choose karein.');
        const allow = button.dataset.allow === '1';
        if (!await confirmWithTrigger({ title: allow ? 'ID allow karein?' : 'ID access hataein?',
          message: `${target.name} · ${account.name}${account.phoneMasked ? ' · ' + account.phoneMasked : ''}`,
          confirmText: allow ? 'Allow' : 'Remove' })) return;
        const out = await api('boss/account-access', 'POST', { userId: target.id, accountKey: account.key, allow, confirm: true });
        state.access = out.access; render();
        toast(allow ? 'ID access allow hua.' : 'ID access hata diya.');
      }
      else if (action === 'handoff-start') {
        const h = state.chatHandoff;
        if (!h?.pendingId) return;
        if (h.existingDraft && !await confirmWithTrigger({ title: 'Draft replace karein?', message: 'Pehla Mini App draft backup mein rahega; naye links se naya draft khulega.', confirmText: 'Naya draft' })) return;
        const out = await api('chat-handoff/start', 'POST', { handoffId: h.pendingId, confirmReplaceDraft: h.existingDraft === true });
        state.handoffIgnorePending = ''; state.handoffError = ''; state.handoffAutoFor = ''; state.handoffName = null; state.handoffMobile = null;
        merge(out); render();
      }
      else if (action === 'handoff-auto' || action === 'handoff-choose') {
        const row = action === 'handoff-choose' ? state.accounts.find(a => a.key === button.dataset.key) : null;
        let confirmUsed = false;
        if (row?.needsConfirm) {
          if (!await confirmWithTrigger({ title: 'ID pehle use ho chuki hai', message: 'Is ID ko phir bhi select karna hai?', confirmText: 'Select ID' })) return;
          confirmUsed = true;
        }
        state.handoffBusy = true; state.handoffError = ''; render();
        try {
          const out = await api('chat-handoff/select', 'POST', { handoffId: state.chatHandoff?.activeId, auto: action === 'handoff-auto', key: row?.key || '', confirmUsed });
          state.handoffAutoFor = ''; merge(out);
        } finally { state.handoffBusy = false; render(); }
      }
      else if (action === 'handoff-reselect') {
        if (!await confirmWithTrigger({ title: 'ID badlein?', message: 'Address aur cart ko nayi ID ke liye phir check karna hoga.', confirmText: 'ID badlein' })) return;
        const out = await api('chat-handoff/reselect', 'POST', { handoffId: state.chatHandoff?.activeId, confirmChange: true });
        state.handoffError = ''; state.handoffAutoFor = ''; state.handoffName = null; state.handoffMobile = null; merge(out); render();
      }
      else if (action === 'handoff-leave') {
        if (!await confirmWithTrigger({ title: 'Link flow band karein?', message: 'Draft backup mein rahega. Naye links chat mein bhej sakte hain.', confirmText: 'Band karein' })) return;
        const out = await api('chat-handoff/leave', 'POST', { handoffId: state.chatHandoff?.activeId, confirmLeave: true });
        state.handoffError = ''; state.handoffAutoFor = ''; merge(out); render();
      }
      else if (action === 'handoff-bill' || action === 'handoff-offers') {
        const offers = action === 'handoff-offers';
        if (!await confirmWithTrigger({
          title: offers ? 'Offers check karein?' : 'Swiggy cart replace karein?',
          message: offers ? 'Selected ID ka cart phir sync hoga. One Lite subscription add nahi ki jayegi.' : 'Selected ID ka existing Swiggy cart replace hoga aur yeh address save hoga.',
          confirmText: offers ? 'Check offers' : 'Continue'
        })) return;
        state.handoffBusy = true; state.handoffError = '';
        if (offers && state.cart) { state.cart.quote = null; state.chatHandoff.stage = 'CART'; state.chatHandoff.cartFetched = true; }
        render();
        try {
          const out = await api('chat-handoff/' + (offers ? 'offers' : 'bill'), 'POST', {
            handoffId: state.chatHandoff?.activeId, ...(offers ? { confirmResync: true } : { confirmReplaceSwiggyCart: true })
          });
          merge(out);
        } catch (e) {
          try { merge(await api('bootstrap')); } catch {}
          throw e;
        } finally { state.handoffBusy = false; render(); }
      }
      else if (action === 'account-select') {
        let out;
        try { out = await api('accounts/select', 'POST', { key: button.dataset.key }); }
        catch (e) {
          if (e.code !== 'ACCOUNT_NEEDS_CONFIRM') throw e;
          // Boss (31-10-2026): used ID par warning, phir user chaahe to select.
          if (!await confirmWithTrigger({
            title: 'Ye ID pehle use ho chuki hai',
            message: `${e.message}\n\nPhir bhi isi ID se order karna hai? Naya order isi ID par jayega.`,
            confirmText: 'Haan, select karein'
          })) return;
          out = await api('accounts/select', 'POST', { key: button.dataset.key, confirmUsed: true });
        }
        merge(out); state.addresses = []; state.orders = null; render();
      }
      else if (action === 'account-remove') {
        // Boss (31-10-2026): DELETE par DO option — database se, ya Swiggy se
        // (Swiggy se delete par unka delete OTP jayega).
        const choice = await confirmWithTrigger({
          title: 'Delete kaise karein?',
          message: 'Database se hatao: sirf yahan se ID hategi, Swiggy account chalta rahega.\n\nSwiggy se delete: Swiggy delete OTP bhejega aur account hamesha ke liye delete ho jayega — ye wapas nahi aata.',
          choices: [
            { id: 'local', label: 'Database se hatao' },
            { id: 'swiggy', label: 'Swiggy se delete', danger: true }
          ]
        });
        if (!choice) return;
        if (choice === 'swiggy') {
          const out = await api('accounts/remove', 'POST', { key: button.dataset.key, mode: 'swiggy' });
          state.deleteFlow = { key: button.dataset.key, phoneMasked: out.phoneMasked || '' };
          state.tab = 'accounts'; render(); toast('Swiggy delete OTP bheja gaya.');
          return;
        }
        const out = await api('accounts/remove', 'POST', { key: button.dataset.key }); merge(out); state.addresses = []; state.orders = null; render(); toast('Account hata diya (Swiggy account chalta hai).');
      }
      else if (action === 'claim-offers') {
        const key = button.dataset.key;
        state.claimBusyKey = key; render();
        try {
          const out = await api('offers/claim', 'POST', { key });
          merge(out); state.claimResult = out.claim || null; toast('Claim ka result aa gaya.');
        } finally { state.claimBusyKey = ''; render(); }
      } else if (action === 'identities-backup' || action === 'identities-verify') {
        const verify = action === 'identities-verify';
        state.identityBusy = true; state.identityNote = ''; render();
        try {
          const out = await api('boss/identities', 'POST', verify ? { verify: true } : {});
          if (out.identities) state.identities = out.identities;
          if (verify) {
            const rows = out.results || [];
            const dead = rows.filter(r => !r.valid);
            state.identityNote = rows.length
              ? `${rows.length} ID check hui — ${rows.length - dead.length} live, ${dead.length} ka session Swiggy par khatam.${dead.length ? ' ' + dead.map(d => d.name || d.key).join(', ') + ' ko dobara login karein.' : ''}`
              : (out.note || '');
            toast(dead.length ? `${dead.length} ID ka session khatam — dobara login karein.` : 'Saari IDs live hain.');
          } else {
            state.identityNote = out.message || '';
            toast(out.message || 'Backup ho gaya.');
          }
        } finally { state.identityBusy = false; render(); }
      } else if (action === 'doctor-run') {
        state.doctorBusy = true; state.doctorNote = ''; render();
        try {
          const out = await api('boss/durability');
          state.doctor = out.doctor; state.doctorNote = '';
          render();
          toast(out.doctor?.verdictLine || 'Jaanch poori hui.');
        } finally { state.doctorBusy = false; render(); }
      } else if (action === 'doctor-restore') {
        state.restoreBusy = true; render();
        try {
          const out = await api('boss/durability/restore', 'POST', {});
          state.doctorNote = out.message || '';
          if (out.identities) state.identities = out.identities;
          if (out.durability) state.durability = out.durability;
          merge(out);
          render();
          toast(out.message || 'Restore ho gaya.');
        } finally { state.restoreBusy = false; render(); }
      } else if (action === 'identities-refresh') {
        const out = await api('boss/identities'); state.identities = out.identities || null; render();
      } else if (action === 'backup-now') {
        state.backupBusy = true; render();
        try {
          const out = await api('backup', 'POST', {});
          merge(out);
          const cloud = out.result?.cloud;
          toast(cloud?.ok ? 'Backup ho gaya — cloud + mirror dono.' : (out.result?.mirrored ? 'Mirror me save ho gaya (cloud OFF/fail).' : 'Backup fail — wajah upar likhi hai.'));
        } finally { state.backupBusy = false; render(); }
      } else if (action === 'addresses-refresh') await loadAddresses();
      else if (action === 'cart-clear') {
        if (!await confirmWithTrigger({ title: 'Cart clear karein?', message: 'Draft cart ke saare items hat jayenge. Swiggy cart tab tak waisa hi rahega jab tak naya sync na ho.', confirmText: 'Clear cart', danger: true })) return;
        await api('cart/clear', 'POST', { confirmClear: true });
        state.cart = null; state.outlets = null; state.outletsOpen = false; state.couponOpen = false;
        render(); toast('Cart clear ho gaya.');
      }
      else if (action === 'coupon-remove') { await removeCoupon(); }
      else if (action === 'coupon-pick') { await applyCoupon(button.dataset.code, button); }
      else if (action === 'track-refresh') { await loadTrack(); }
      else if (action === 'track-open') {
        const id = button.dataset.id || state.checkout?.orderId;
        if (!id) throw new Error('Order ID nahi mila. Orders tab me check karein.');
        startTracking(id, 'checkout');
      }
      else if (action === 'bill-refresh') {
        const signature = billSyncSignature();
        if (!await confirmWithTrigger({ title: 'Fresh bill check?', message: 'Swiggy par cart dobara sync hoga aur naya bill aayega.', confirmText: 'Check bill' })) return;
        if (signature !== billSyncSignature()) throw new Error('Cart or account changed. Review the bill again.');
        // Bill refresh = poora hisaab ek saath (offers + One Lite + coupon).
        const out = await api('cart/sync', 'POST', { confirmReplaceSwiggyCart: true, forSomeoneElse: state.cart?.forSomeoneElse === true, coupon: String(state.cart?.quote?.couponCode || state.cart?.quote?.coupon || ''), autoCoupon: true, phase: 'full' });
        if (signature !== billSyncSignature()) return;
        merge(out); render(); toast('Bill update ho gaya.');
      }
      else if (action === 'outlet-pick') {
        if (state.cart && !await confirmWithTrigger({ title: 'Doosra outlet?', message: 'Naye outlet ka item add karne par cart replace karna padega (Swiggy ek cart me do restaurant nahi leta).', confirmText: 'Outlet kholein' })) return;
        state.outletsOpen = false; state.outlets = null;
        await openMenu(button.dataset.id);
      }
      else if (action === 'address-select') { const out = await api('addresses/select', 'POST', { ref: button.dataset.ref }); merge(out); state.contactEdit = !out.selectedAddress?.mobile || !out.selectedAddress?.name; render(); toast('Address selected.'); }
      else if (action === 'popular') await search(button.dataset.query);
      else if (action === 'restaurant') {
        // Boss (31-10-2026): Swiggy ki tarah pehle outlet/location, phir menu.
        const sameName = outletsForName(button.dataset.name || '');
        if (sameName.length > 1) { openOutletSheet(button.dataset.name, sameName, '', button); return; }
        await openMenu(button.dataset.id);
      }
      else if (action === 'menu-outlets') {
        const restaurant = state.menu?.restaurant;
        if (!restaurant) return;
        const data = outletData(restaurant);
        if (data.alternatives.length) openOutletSheet(restaurant.name, allOutletChoices(restaurant, data), restaurant.id, button);
      }
      else if (action === 'dish-add') {
        let out;
        const itemId = button.dataset.id;
        const restaurantId = button.dataset.restaurant;
        try { out = await api('cart/add', 'POST', { itemId, restaurantId }); }
        catch (e) {
          if (e.status !== 409 || (state.checkout && state.checkout.status !== 'PAID')) throw e;
          if (!await confirmWithTrigger({ title: 'Replace draft cart?', message: 'The existing draft will be replaced with items from this restaurant.', confirmText: 'Replace draft' })) return;
          out = await api('cart/add', 'POST', { itemId, restaurantId, replace: true });
        }
        merge(out); updateMenuCartControls(button, hadFocus);
      } else if (action === 'qty') {
        const out = await api('cart/quantity', 'POST', { lineKey: button.dataset.key, qty: Number(button.dataset.qty) });
        merge(out); updateMenuCartControls(button, hadFocus);
      }
      else if (action === 'checkout-start') {
        if (!state.activeAccount) { state.tab = 'accounts'; writeCache({ tab: 'accounts' }); render(); toast('Pehle Swiggy ID chunein.'); return; }
        if (!state.cart?.items?.length) throw new Error('Cart khaali hai — pehle koi item add karein.');
        // Address/receiver pehle — warna Swiggy bill/order deta hi nahi aur user
        // ko lagta hai "checkout kaam nahi kar raha".
        if (!receiverReady()) return;
        let quote = state.cart?.quote;
        if (!quote) {
          if (state.chatHandoff?.activeId) { state.handoffHidden = false; render(); toast('Pehle Mini App mein cart aur bill check karein.'); return; }
          const syncSignature = billSyncSignature();
          if (!await confirmWithTrigger({ title: 'Swiggy cart sync karein?', message: 'Selected ID ka existing Swiggy cart replace hoga aur address save hoga.', confirmText: 'Sync cart' })) return;
          if (syncSignature !== billSyncSignature()) throw new Error('Cart or account changed. Review it again.');
          const synced = await api('cart/sync', 'POST', { confirmReplaceSwiggyCart: true, forSomeoneElse: state.cart?.forSomeoneElse === true, coupon: String(state.cart?.quote?.couponCode || state.cart?.quote?.coupon || ''), autoCoupon: true, phase: 'full' });
          if (syncSignature !== billSyncSignature()) throw new Error('Cart or account changed. Review it again.');
          merge(synced); quote = state.cart?.quote; render();
          if (!quote) throw new Error('Swiggy ne bill nahi diya. Dobara Pay Now dabayein.');
        }
        const approvalSignature = billSyncSignature();
        if (!await confirmWithTrigger({
          title: `Pay ${money(quote.total)} — order confirm?`,
          message: `${state.cart.restaurantName || 'Restaurant'} · ${state.selectedAddress.name} · +91 ${state.selectedAddress.mobile}\n${state.selectedAddress.address}\n${state.orderFee?.exempt ? 'Order fee: free.' : `Order fee ${money(Number(state.orderFee?.paise || 0) / 100)} (bot wallet); Swiggy bill alag.`}\nSwiggy par order jayega. Result na aaye to dobara order na karein.`,
          confirmText: `Pay ${money(quote.total)}`
        })) return;
        if (approvalSignature !== billSyncSignature() || state.cart?.quote?.total !== quote.total || state.cart?.quote?.fetchedAt !== quote.fetchedAt) {
          throw new Error('Cart or bill changed. Review it again before paying.');
        }
        try {
          const out = await api('checkout', 'POST', { confirmCheckout: true, expectedTotal: quote.total, quoteFetchedAt: quote.fetchedAt });
          state.checkoutWarning = ''; merge(out); render();
          toast(out.checkout?.status === 'PAYMENT_PENDING' ? 'Payment details returned. Verify before paying.' : 'Check Swiggy My Orders; do not retry.');
        } catch (e) {
          // Boss (31-10-2026): "PAY PAR CLICK KARTA HU TO ... COULD NOT BE
          // CONFIRMED" — ab har wajah alag dikhti hai. Bill badla ho to naya
          // bill save ho chuka hai; order nahi gaya, dobara Pay dabaiye.
          if (e.code === 'WALLET_LOW_BALANCE') {
            state.checkoutWarning = e.message || 'Balance kam hai. Bot me Wallet se add karein.';
            render();
            toast(state.checkoutWarning);
            return;
          }
          const prePlacement = ['BILL_CHANGED', 'CART_ITEMS', 'ADDRESS', 'OFO', 'CART_FETCH', 'CART_PARSE', 'COUPON', 'AMOUNT', 'AMOUNT_MISSING', 'CART_ID', 'RESTAURANT'].includes(String(e.code || ''));
          if (prePlacement) {
            try { merge(await api('bootstrap')); } catch {}
            render();
            toast(e.message || 'Order place nahi hua — naya bill dekh kar dobara Pay dabaiye.');
            return;
          }
          // A lost browser response is not proof that the server never sent the
          // request. Hide retry until an authenticated bootstrap resolves it.
          state.checkout = { status: 'OUTCOME_UNKNOWN', message: 'The response was lost. Check Swiggy My Orders; do not place another order.' };
          try { merge(await api('bootstrap')); } catch {}
          render();
          throw e;
        }
      }
      else if (action === 'checkout-status') {
        // Boss (round 33): "I HAVE PAID" — ek hi button. Paisa de diya ho to
        // seedha My Orders khulta hai, wahi order khulta hai, aur Swiggy ka
        // share link + copy wahan milta hai.
        const out = await api('checkout/status', 'POST', {});
        merge(out); render();
        if (out.checkout?.status === 'PAID' && out.checkout.orderId) {
          stopPaymentPoll();
          state.payWindow = null;
          state.payExpired = false;
          toast('Payment mil gayi — My Orders me order khul gaya.', 'ok');
          await openOrdersForOrder(out.checkout.orderId, { share: true });
          return;
        }
        toast('Payment abhi confirm nahi hui. Thodi der me phir dabaiye — paisa dobara na dein.', 'bad');
      }
      else if (action === 'checkout-cancel') {
        const ok = await confirmInApp({
          title: 'Order cancel karein?',
          message: 'Aapka checkout band ho jayega aur cart wapas khulega. Paisa nahi katega.\n\nSach: Swiggy par ye order bana hua hai to use hum cancel nahi kar sakte — Swiggy unpaid order khud cancel kar deta hai.',
          confirmText: 'Haan, cancel', danger: true
        });
        if (!ok) return;
        const out = await api('checkout/cancel', 'POST', { confirmCancel: true });
        stopPaymentPoll();
        state.payWindow = null; state.payExpired = false; state.payTicks = 0;
        state.checkout = null;
        state.cart = out.cart ?? state.cart;
        state.tab = 'cart';
        writeCache({ tab: 'cart' });
        render(); window.scrollTo(0, 0);
        toast(out.message || 'Checkout cancel ho gaya. Cart wapas khula hai.', 'ok');
      }
      else if (action === 'back-to-cart') {
        // Payment ke baad share link dikh raha hota hai — "Go back" dabate hi
        // wahi normal cart page khulta hai.
        state.order = null;
        state.orderTracking = null;
        state.shareWanted = false;
        state.shareNote = '';
        state.tab = 'cart';
        writeCache({ tab: 'cart' });
        render(); window.scrollTo(0, 0);
      }
      else if (action === 'checkout-finish') {
        if (!await confirmWithTrigger({ title: 'Start a new draft?', message: 'The paid order remains in Swiggy order history.', confirmText: 'Start new draft' })) return;
        const out = await api('checkout/finish', 'POST', { confirmNewDraft: true }); merge(out); state.orders = null; state.ordersScope = 'active'; render();
      }
      else if (action === 'checkout-orders') {
        if (state.chatHandoff) state.handoffHidden = true;
        state.ordersScope = 'checkout'; state.orders = null; state.order = null; state.orderTracking = null; state.tab = 'orders';
        render(); window.scrollTo(0, 0); await loadOrders();
      }
      else if (action === 'order-tracking') await loadOrderTracking(state.order?.id);
      else if (action === 'share-copy' || action === 'share-send') {
        const link = orderShareLink();
        if (!link) { toast('Share link unavailable.', 'bad'); return; }
        const copyOnly = action === 'share-copy';
        let copied = false;
        try {
          if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(link); copied = true; }
        } catch { copied = false; }
        if (!copied) {
          const ta = document.createElement('textarea');
          ta.value = link; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.append(ta); ta.select();
          try { copied = document.execCommand('copy'); } catch { copied = false; }
          ta.remove();
        }
        if (copyOnly) {
          toast(copied ? 'Share link copy ho gaya.' : 'Copy nahi ho paya — link upar se haath se copy karein.', copied ? 'ok' : 'bad');
          return;
        }
        // Telegram ka apna share sheet — user wahan se kisi ko bhej sakta hai.
        // Mini app ke andar se browser nahi khulta (bahar navigation band).
        const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Mera Swiggy order')}`;
        try {
          if (window.Telegram?.WebApp?.openTelegramLink) { window.Telegram.WebApp.openTelegramLink(shareUrl); toast('Telegram share khul gaya. Link copy bhi hai.', 'ok'); return; }
        } catch { /* niche sach */ }
        toast(copied ? 'Link copy ho gaya — Telegram me paste kar dein.' : 'Telegram share yahan nahi khulta. Link upar se copy karein.', copied ? 'ok' : 'bad');
      }
      else if (action === 'orders-refresh') await loadOrders();
    }, button);
  });
  // Update ke baad bhi phone par jo tha wahi dikhe — theme, aakhri tab aur
  // pehle dikhi ID ki yaad (boss: "data reset na ho").
  const cached = readCache();
  try { if (localStorage.getItem('pro-theme') === 'dark' || cached.theme === 'dark') document.body.classList.add('dark'); } catch {}
  if (Array.isArray(cached.accounts)) state.cachedAccounts = cached.accounts;
  if (typeof cached.tab === 'string' && ['accounts','address','search','cart','orders','tools'].includes(cached.tab)) state.tab = cached.tab;
  if (initData) reconnect();
  else render();
})();
