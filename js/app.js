import { Elm } from './elm.js';
import { BleTransport, bluetoothSupported, rememberedAdapters } from './ble.js';
import { SimulatorTransport, DEMO_VIN } from './simulator.js';
let demoMode = false; // connected to the built-in demo car: nothing it produces is saved
import * as obd from './obd.js';
import { PIDS } from './pids.js';
import { lookupUrl } from './dtc.js';
import { LEVEL_LABEL, priceSearchUrl } from './explain.js';
import { runHealthCheck, reportText, stateText, diffReports } from './report.js';
import { diagnoseAppConnect, dealerSummary, CHECKLIST } from './appconnect.js';
import { Trip, fuelRateFrom5E, fuelRateFromMaf, mpgUk } from './trip.js';
import { calendarUrl, calendarEvent, cleanReg, GOV_MOT_HISTORY, GOV_TAX_CHECK } from './vehicle.js';
import { takeHome, dividendTax, taxDeadlines, subscriptionsTotal, nextDue, meterUsage, moneyOverview, householdBalance } from './life.js';
import { fuelStats, renewals, countdown, upcomingReminders, parkMapsUrl, timeAgo, mileageSummary, mileageExport } from './garage.js';
import { Vault } from './vault.js';
import { CARRIER_NAMES, trackingUrl, parcelStatus, parseShared } from './deliveries.js';
import { biometricAvailable, biometricConfigured, enableBiometric, unlockBiometric, disableBiometric } from './biometric.js';
import { generateHouseholdCode, normalizeCode, householdId, writeToken } from './household.js';
import { parseICS, expandEvents } from './ical.js';
import { makeVerifier, checkVerifier } from './lost.js';
import { ageText, nextBirthday, mask, nhsNumberValid } from './family.js';
import { groupEvents, sameEvent } from './eventmatch.js';
import { summariseCar, looksLikeUkReg, isFullModernReg } from './cardata.js';
import { syncShared } from './sync.js';
import { savePhoto, loadPhoto, deletePhoto, exportAllPhotos, importAllPhotos } from './photos.js';
import { parseImport, importCount } from './import.js';
import { icon, TILE_ICON, SEC_ICON_NAME } from './icons.js';
import { tripChecks, tripStatus, tripCalendarRows, timeline, matchTrip, countryCode, countryName, flag, daysBetween, BOOKING_KINDS, adviceSlug } from './travel.js';
import { BILL_TYPES, BILL_ICON, CAN_SWITCH, COMPARE_LINKS, contractNudge, priceChange, councilTax, POLICY_KINDS, policyLabel, policyIcon, guessPolicyKind, INSURANCE_COMPARE, policyNudge } from './bills.js';
import { makeInboxKeys, newInboxId, unseal, inboxAddress } from './inbox.js';
import { capFor, nextCap, tariffCost, compareTariffs, yearlyFromReadings, TYPICAL, REGIONS } from './energy.js';
import { uploadSharedFile, downloadSharedFile, deleteSharedFile, savePrivateFile, loadPrivateFile, deletePrivateFile, exportPrivateFiles, importPrivateFiles, checkFileSize } from './files.js';

const haptic = (ms = 12) => { try { navigator.vibrate?.(ms); } catch { /* unsupported */ } };

const $ = (id) => document.getElementById(id);

/** Tiny element builder; text is always set via textContent (car data is untrusted). */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

let elm = null;
let busy = false;
let liveRunning = false;
let supportedPids = null;
const logLines = [];

// Debounce frequent writes (typing) so the encrypted store isn't rewritten per keystroke.
const debounce = (fn, ms = 500) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

// Encrypted on-device store. Every collection below lives inside the vault, so
// it is only readable after the user unlocks with their passphrase.
const vault = new Vault();
let mediaKey = null; // stable key for encrypting photos in IndexedDB
const store = {
  load(key, fallback) {
    return vault.get(key, fallback);
  },
  save(key, value) {
    vault.set(key, value).catch((e) => {
      log('info', 'Save failed: ' + e.message);
      // Never fail silently — losing data quietly is the worst outcome.
      if (Date.now() - (store._warned || 0) > 60000) {
        store._warned = Date.now();
        const full = /quota|exceeded/i.test(e.name + ' ' + e.message);
        toast(full ? "This phone's storage for Evergreen is full — remove some photos or old items, then try again." : "Couldn't save that change on this phone — please try again.", { ms: 8000 });
      }
    });
  },
};

// ---------- toast feedback (+ undo) ----------
let toastTimer = null;
function toast(message, { actionLabel, onAction, ms = 5000 } = {}) {
  const t = $('toast');
  t.replaceChildren(el('span', { text: message }));
  if (actionLabel) {
    const btn = el('button', { text: actionLabel });
    btn.addEventListener('click', () => { clearTimeout(toastTimer); t.hidden = true; onAction && onAction(); });
    t.append(btn);
  }
  t.hidden = false;
  haptic(10);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

/** Delete an item from an array collection with a 5s Undo (no scary dialog). */
function deleteItem(key, id, rerender, { photoId, label } = {}) {
  const files = (store.load(key, []).find((x) => x.id === id) || {}).files || [];
  const items = store.load(key, []);
  const index = items.findIndex((x) => x.id === id);
  if (index < 0) return;
  const item = items[index];
  store.save(key, items.filter((x) => x.id !== id));
  rerender();
  let undone = false;
  toast(`Deleted${label ? ' ' + label : ''}`, {
    actionLabel: 'Undo',
    onAction: () => {
      undone = true;
      const now = store.load(key, []);
      now.splice(Math.min(index, now.length), 0, item);
      store.save(key, now);
      rerender();
    },
  });
  if (photoId) setTimeout(() => { if (!undone) deletePhoto(photoId); }, 5300); // keep the photo until Undo expires
  if (files.length) setTimeout(() => { if (!undone) dropFiles(files); }, 5300);
}

// ---------- technical log ----------
function log(direction, text) {
  const stamp = new Date().toTimeString().slice(0, 8);
  logLines.push(`${stamp} ${direction === 'tx' ? '>>' : direction === 'rx' ? '<<' : '--'} ${text}`);
  if (logLines.length > 800) logLines.splice(0, logLines.length - 800);
  if ($('tech').open && $('tab-help').classList.contains('active')) renderLog();
}
const renderLog = () => ($('log').textContent = logLines.join('\n'));
$('tech').addEventListener('toggle', renderLog);

function setStatus(id, text, isError = false) {
  const node = $(id);
  node.textContent = text;
  node.classList.toggle('error', isError);
}

/** Turn low-level errors into something a driver can act on. */
function friendly(e) {
  const m = e && e.message ? e.message : String(e);
  if (/did not answer|GATT|disconnected|NetworkError/i.test(m)) {
    return 'Lost contact with the adapter. Check it is pushed in firmly and the ignition is on, then connect again.';
  }
  return m;
}

// ---------- navigation ----------
let currentTab = 'home';
// ----- Car: Overview · Running costs · Service · Parking (Diagnostics opens the car check) -----
let carSection = 'overview';
function initCarNav() {
  const tab = $('tab-car');
  let cur = 'overview';
  for (const child of [...tab.children]) {
    if (child.id === 'car-nav') continue;
    if (child.tagName === 'H3' && child.dataset.car) cur = child.dataset.car;
    child.dataset.carSec = child.dataset.carBlock || cur;
  }
  tab.querySelectorAll('[data-car-go]').forEach((b) => b.addEventListener('click', () => { haptic(); showCarSection(b.dataset.carGo); }));
}
function showCarSection(name) {
  carSection = name || 'overview';
  const tab = $('tab-car');
  for (const child of tab.children) if (child.dataset.carSec) child.classList.toggle('sec-off', child.dataset.carSec !== carSection);
  tab.querySelectorAll('[data-car-go]').forEach((b) => b.classList.toggle('current', b.dataset.carGo === carSection));
}
let currentLifeSection = null;
function showTab(name) {
  currentTab = name;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  const bottom = ['check', 'live', 'trips'].includes(name) ? 'car' : name; // diagnostics live inside Car
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === bottom));
  document.querySelectorAll('.nav-pill').forEach((b) => b.classList.toggle('current', b.dataset.go === name));
  if (name !== 'live') stopLive();
  if (name === 'help') { renderLog(); renderPush(); }
  if (name === 'car') showCarSection(carSection);
  if (name === 'home') renderHome();
  if (name === 'life') { showLifeSection(pendingLifeSection); pendingLifeSection = null; }
  else clearInterval(trainTimer);
  // The connection pill only matters on the car screens.
  $('conn').style.display = ['check', 'live', 'trips'].includes(name) || elm ? '' : 'none';
  window.scrollTo(0, 0);
  syncNav();
}
document.querySelectorAll('.tabs button').forEach((btn) => btn.addEventListener('click', () => showTab(btn.dataset.tab)));
document.querySelectorAll('.nav-pill[data-go]').forEach((btn) => btn.addEventListener('click', () => showTab(btn.dataset.go)));

// The phone's status bar matches the dark green opening screen, then the app.
(() => {
  const meta = document.querySelector('meta[name="theme-color"]');
  const lock = $('lock-screen');
  if (!meta || !lock) return;
  const appColour = meta.content;
  const apply = () => { meta.content = lock.hidden ? appColour : '#0d4f30'; };
  new MutationObserver(apply).observe(lock, { attributes: true, attributeFilter: ['hidden'] });
  apply();
})();

// ---------- Android back button / back gesture: go up one level, exit only from Home ----------
// Each open level (a tab other than Home, a Life section, a sheet, a full-screen
// viewer) gets one browser history entry, so "back" closes the top one.
let navDepth = 0;
let navIgnorePops = 0;
function navLevels() {
  let n = 0;
  if (currentTab !== 'home') n++;
  if (currentTab === 'life' && currentLifeSection) n++;
  if (['check', 'live', 'trips'].includes(currentTab)) n++; // Home → Car → Diagnostics
  if (!$('sheet')?.hidden) n++;
  if (document.querySelector('.file-viewer')) n++;
  if ($('rec-modal') && !$('rec-modal').hidden) n++;
  if ($('scan-modal') && !$('scan-modal').hidden) n++;
  return n;
}
function syncNav() {
  if (vault.locked) return;
  const want = navLevels();
  if (want > navDepth) {
    for (let i = navDepth; i < want; i++) history.pushState({ evergreen: i + 1 }, '');
    navDepth = want;
  } else if (want < navDepth) {
    // closed by a button — drop the spare history entries quietly
    navIgnorePops++;
    history.go(want - navDepth);
    navDepth = want;
  }
}
function closeTopLevel() {
  const viewer = document.querySelector('.file-viewer');
  if (viewer) { viewer.remove(); return; }
  if (!$('sheet').hidden) { $('sheet').hidden = true; $('sheet-body').replaceChildren(); return; }
  if (!$('rec-modal').hidden) { $('rec-modal').hidden = true; return; }
  if (!$('scan-modal').hidden) { stopScan(); return; }
  if (currentTab === 'life' && currentLifeSection) { showLifeSection(null); return; }
  if (['check', 'live', 'trips'].includes(currentTab)) { showTab('car'); return; }
  if (currentTab !== 'home') { showTab('home'); }
}
window.addEventListener('popstate', () => {
  if (navIgnorePops > 0) { navIgnorePops--; return; }
  navDepth = Math.max(0, navDepth - 1);
  closeTopLevel();
  syncNav(); // in case closing changed more than one level
});
// ----- Life tab as a focused hub-and-spoke -----
const SEC_ICON = { deliveries: '📦', documents: '📄', utilities: '⚡', subscriptions: '🔁', tax: '💷', home: '🏠', health: '❤️', loyalty: '💳', sharing: '📅', shopping: '🛒' };
let pendingLifeSection = null;
const LIFE_GROUPS = [
  ['Today', ['calendar', 'shopping', 'tasks', 'deliveries', 'trains']],
  ['In an emergency', ['emergency']],
  ['Home', ['utilities', 'insurance', 'home']],
  ['Family', ['family', 'health', 'travel']],
  ['Money', ['tax', 'subscriptions', 'bills']],
  ['Wallet', ['documents', 'loyalty']],
];
function initLifeNav() {
  const tab = $('tab-life');
  const back = el('div', { id: 'life-back', class: 'life-back', hidden: '' });
  const backBtn = el('button', { class: 'nav-pill', text: '‹ All' });
  backBtn.addEventListener('click', () => showLifeSection(null));
  back.append(backBtn, el('span', { id: 'life-back-title', class: 'name' }));

  // The menu is grouped: what you use daily, the house, the family, money, papers, settings.
  const menu = el('div', { id: 'life-menu' });
  const heads = Object.fromEntries([...tab.querySelectorAll(':scope > h3[id^="sec-"]')].map((h) => [h.id.slice(4), h.textContent]));
  const placed = new Set();
  const groups = LIFE_GROUPS.map(([title, names]) => [title, names.filter((n) => heads[n])]);
  const rest = Object.keys(heads).filter((n) => !LIFE_GROUPS.some(([, names]) => names.includes(n)));
  if (rest.length) groups.push(['More', rest]);
  for (const [title, names] of groups) {
    if (!names.length) continue;
    const tiles = el('div', { class: 'tiles' });
    for (const name of names) {
      placed.add(name);
      const btn = el('button', { class: 'tile-btn' }, icon(SEC_ICON_NAME[name] || 'doc'), el('span', { class: 'tile-label', text: heads[name] }));
      btn.addEventListener('click', () => { haptic(); showLifeSection(name); });
      tiles.append(btn);
    }
    menu.append(el('h4', { class: 'menu-group', text: title }), tiles);
  }
  tab.prepend(menu);
  tab.insertBefore(back, menu);

  let cur = '';
  for (const child of [...tab.children]) {
    if (child === menu || child === back) continue;
    if (child.id === 'rec-modal' || child.id === 'scan-modal') { child.dataset.lifeAlways = '1'; continue; }
    if (child.tagName === 'H3' && child.id.startsWith('sec-')) cur = child.id.slice(4);
    child.dataset.lifeSec = cur;
  }
  showLifeSection(null);
}
function showLifeSection(name) {
  const tab = $('tab-life');
  const menu = $('life-menu');
  const back = $('life-back');
  const showMenu = !name;
  currentLifeSection = name || null;
  menu.hidden = !showMenu;
  back.hidden = showMenu;
  if (!showMenu) $('life-back-title').textContent = $('sec-' + name)?.textContent || '';
  for (const child of tab.children) {
    if (child === menu || child === back || child.dataset.lifeAlways) continue;
    // A separate class (not `hidden`) so elements that hide themselves stay hidden.
    child.classList.toggle('sec-off', showMenu || child.dataset.lifeSec !== name);
  }
  window.scrollTo(0, 0);
  if (name === 'trains') { renderTrains(); startTrainRefresh(); } else clearInterval(trainTimer);
  if (name === 'tax') renderCompany();
  if (name === 'deliveries') renderInbox();
  if (name === 'health') renderCheckups();
  if (name === 'family') renderFamily();
  if (name === 'documents') renderDocs();
  if (name === 'emergency') renderHouse();
  syncNav();
}
function goLife(section) {
  pendingLifeSection = section;
  showTab('life');
}

// ---------- connection ----------
function setConnected(connected, label = '') {
  $('conn').textContent = connected ? label : 'Not connected';
  $('conn').className = 'pill ' + (connected ? 'on' : 'off');
  $('connect-card').hidden = connected;
  $('check-home').hidden = !connected;
  $('btn-disconnect').hidden = !connected;
  document.querySelectorAll('[data-needs-conn]').forEach((b) => (b.disabled = !connected));
}

async function connect(transport) {
  setStatus('connect-status', 'Connecting…');
  $('btn-connect').disabled = $('btn-demo').disabled = true;
  try {
    const candidate = new Elm(transport, log);
    transport.onClose = () => handleDisconnect('The adapter disconnected.');
    await candidate.init();
    elm = candidate;
    demoMode = transport instanceof SimulatorTransport;
    supportedPids = null;
    setConnected(true, transport.name || 'Connected');
    setStatus('connect-status', '');
    setStatus('check-status', '');
  } catch (e) {
    log('info', 'Connect failed: ' + e.message);
    try {
      await transport.close();
    } catch {
      /* ignore */
    }
    const cancelled = e.name === 'NotFoundError';
    setStatus('connect-status', cancelled ? 'No adapter chosen.' : friendly(e), !cancelled);
  } finally {
    $('btn-connect').disabled = !bluetoothSupported();
    $('btn-demo').disabled = false;
  }
}

function handleDisconnect(message) {
  if (!elm) return;
  stopLive();
  stopTrip(true);
  elm = null;
  demoMode = false;
  setConnected(false);
  setStatus('connect-status', message);
  log('info', message);
}

$('btn-connect').addEventListener('click', () => connect(new BleTransport()));
$('btn-demo').addEventListener('click', () => connect(new SimulatorTransport()));
$('btn-reconnect').addEventListener('click', () => connect(new BleTransport({ remembered: true })));
async function refreshReconnect() {
  const remembered = await rememberedAdapters();
  $('btn-reconnect').hidden = remembered.length === 0;
  if (remembered.length) $('btn-reconnect').textContent = `Reconnect to ${remembered[0].name || 'my adapter'}`;
}
$('btn-disconnect').addEventListener('click', async () => {
  const current = elm;
  handleDisconnect('Disconnected.');
  if (current) await current.close();
});

// ---------- health check ----------
async function healthCheck() {
  if (!elm || busy) return;
  busy = true;
  stopLive();
  $('btn-check').disabled = true;
  $('progress').hidden = false;
  try {
    const report = await runHealthCheck(elm, (fraction, message) => {
      $('progress-bar').style.width = Math.round(fraction * 100) + '%';
      setStatus('check-status', message);
    });
    const previous = loadHistory()[0];
    if (demoMode) report.demo = true; else saveReport(report);
    renderReport(report, { previous: demoMode ? null : previous });
    renderHistory();
    setStatus('check-status', demoMode ? 'Demo car — this is example data, so it isn’t saved to your history.' : '');
    $('btn-check').textContent = 'Check again';
  } catch (e) {
    log('info', 'Check failed: ' + e.message);
    setStatus('check-status', friendly(e), true);
  } finally {
    busy = false;
    $('progress').hidden = true;
    $('progress-bar').style.width = '0';
    $('btn-check').disabled = !elm;
  }
}
$('btn-check').addEventListener('click', healthCheck);

function issueCard(i) {
  const card = el(
    'div',
    { class: 'card issue ' + i.level },
    el('span', { class: 'tag ' + i.level, text: LEVEL_LABEL[i.level] }),
    el('h2', { text: i.title }),
    el('div', { class: 'where', text: `${i.system} · ${stateText(i.state)}` })
  );
  if (i.stateNote) card.append(el('p', { class: 'state-note', text: i.stateNote }));
  card.append(
    el(
      'dl',
      { class: 'qa' },
      el('dt', { text: 'What it means' }),
      el('dd', { text: i.meaning }),
      el('dt', { text: 'Can I keep driving?' }),
      el('dd', { text: i.drive }),
      el('dt', { text: 'What to do' }),
      el('dd', { text: i.action })
    )
  );
  if (i.cost) {
    card.append(
      el(
        'div',
        { class: 'cost' },
        el('div', {}, el('span', { class: 'cost-label', text: 'Rough cost guide ' }), el('span', { text: i.cost })),
        el('a', { class: 'cost-link', href: priceSearchUrl(i.title), target: '_blank', rel: 'noopener', text: 'Check current prices →' })
      )
    );
  }
  card.append(
    el(
      'details',
      { class: 'inner' },
      el('summary', { text: 'Details for a garage' }),
      el(
        'dl',
        { class: 'facts' },
        el('div', {}, el('dt', { text: 'Fault code' }), el('dd', { text: i.code })),
        i.vwCode ? el('div', {}, el('dt', { text: 'VW reference' }), el('dd', { text: i.vwCode })) : null,
        el('div', {}, el('dt', { text: 'Reported by' }), el('dd', { text: i.system }))
      ),
      el('p', {}, el('a', { href: lookupUrl(i.code), target: '_blank', rel: 'noopener', text: 'Look up this code online' }))
    )
  );
  return card;
}

const SYSTEM_TAG = { ok: ['OK', 'ok'], fault: ['Fault logged', 'fault'], unknown: ['Could not check', 'unknown'] };

function systemRow(s) {
  const [label, cls] = SYSTEM_TAG[s.status];
  const facts = el('dl', { class: 'facts' });
  for (const [k, v] of [
    ['VW name', s.systemName],
    ['Part number', s.partNumber],
    ['Software version', s.softwareVersion],
    ['Hardware number', s.hardwareNumber],
  ]) {
    if (v) facts.append(el('div', {}, el('dt', { text: k }), el('dd', { text: v })));
  }
  return el(
    'li',
    {},
    el(
      'div',
      { class: 'line' },
      el('div', {}, el('div', { class: 'name', text: s.name }), el('div', { class: 'sub', text: s.plain || '' })),
      el('span', { class: 'tag ' + cls, text: label })
    ),
    facts.children.length ? el('details', { class: 'inner' }, el('summary', { text: 'Part and software details' }), facts) : null
  );
}

function changeCard(diff) {
  const card = el('div', { class: 'card change' }, el('h2', { text: 'What\'s changed' }));
  const since = `since your last check on ${new Date(diff.prevDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
  if (!diff.changed) {
    card.append(el('p', { class: 'muted', text: `No change ${since}.` }));
    return card;
  }
  const list = el('ul', { class: 'list' });
  const row = (text, tagText, cls) => el('li', {}, el('div', { class: 'line' }, el('div', { class: 'name', text }), el('span', { class: 'tag ' + cls, text: tagText })));
  for (const i of diff.added) list.append(row(i.title, 'New', 'urgent'));
  for (const i of diff.cleared) list.append(row(i.title, 'Gone', 'ok'));
  if (diff.milChanged) list.append(row('Engine warning light', diff.milNow ? 'Now on' : 'Now off', diff.milNow ? 'soon' : 'ok'));
  if (diff.batteryDelta != null && Math.abs(diff.batteryDelta) >= 0.3) {
    const up = diff.batteryDelta > 0;
    list.append(row('Battery voltage', `${up ? '+' : ''}${diff.batteryDelta.toFixed(1)} V`, up ? 'ok' : 'minor'));
  }
  card.append(el('p', { class: 'muted small', text: 'Compared ' + since + '.' }), list);
  return card;
}

function renderReport(r, { past = false, previous = null } = {}) {
  const out = $('report');
  out.replaceChildren();

  out.append(
    el(
      'div',
      { class: 'verdict ' + r.level },
      el('div', { class: 'headline', text: r.headline }),
      el('p', { text: r.summary }),
      el('div', { class: 'when', text: r.demo ? 'Demo car — example data, not saved' : (past ? 'Saved check from ' : 'Checked ') + new Date(r.date).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) })
    )
  );

  const diff = diffReports(r, previous);
  if (diff) out.append(changeCard(diff));

  // At a glance
  const glance = el('ul', { class: 'list' });
  const line = (name, sub, tagText, tagClass) =>
    el('li', {}, el('div', { class: 'line' }, el('div', {}, el('div', { class: 'name', text: name }), sub ? el('div', { class: 'sub', text: sub }) : null), el('span', { class: 'tag ' + tagClass, text: tagText })));
  if (r.mil != null) {
    glance.append(line('Engine warning light', r.mil ? 'The car has switched the amber engine light on.' : 'The car has not switched the engine light on.', r.mil ? 'On' : 'Off', r.mil ? 'soon' : 'ok'));
  }
  if (r.battery) {
    glance.append(line('Battery', `${r.battery.text} (engine ${r.battery.engineRunning ? 'running' : 'off'})`, r.battery.volts.toFixed(1) + ' V', r.battery.level));
  }
  if (r.monitors.length) {
    const ready = r.monitors.filter((m) => m.ready).length;
    const all = ready === r.monitors.length;
    glance.append(
      line('Emissions self-tests', all ? 'The car has finished all its own emissions checks.' : 'Some are still running. Normal after a battery change or after faults were cleared; they finish with everyday driving.', `${ready} of ${r.monitors.length} done`, all ? 'ok' : 'minor')
    );
  }
  if (glance.children.length) out.append(el('div', { class: 'card' }, el('h2', { text: 'At a glance' }), glance));

  if (r.issues.length) {
    out.append(el('h3', { text: 'What we found' }));
    for (const i of r.issues) out.append(issueCard(i));
  }

  out.append(el('h3', { text: 'Systems checked' }));
  if (r.systems.length) {
    const list = el('ul', { class: 'list' });
    for (const s of r.systems) list.append(systemRow(s));
    out.append(el('div', { class: 'card' }, list, el('p', { class: 'muted small', text: 'Only systems fitted to your car and reachable by your adapter are listed.' })));
  } else {
    out.append(el('div', { class: 'card' }, el('p', { class: 'muted', text: 'Only the engine could be checked. Your adapter could not reach the car\'s other computers; a better adapter (see Help) usually fixes this.' })));
  }

  const share = el('button', { text: 'Share this report' });
  share.addEventListener('click', async () => {
    const text = reportText(r);
    try {
      if (navigator.share) await navigator.share({ title: 'Tiguan health check', text });
      else {
        await navigator.clipboard.writeText(text);
        share.textContent = 'Copied. Paste it into a message';
      }
    } catch {
      /* user closed the share sheet */
    }
  });
  out.append(
    el('div', { class: 'card' }, el('h2', { text: 'Taking it to a garage?' }), el('p', { class: 'muted', text: 'Send them this report so they know exactly what the car said.' }), share),
    r.vin ? el('p', { class: 'muted small', text: `Car identity number (VIN): ${r.vin}` }) : null
  );
}

// ---------- saved checks (on this phone only) ----------
const HISTORY_KEY = 'tiguan-checks';
const loadHistory = () => store.load(HISTORY_KEY, []);
function saveReport(report) {
  store.save(HISTORY_KEY, [report, ...loadHistory()].slice(0, 12));
}
function renderHistory() {
  const items = loadHistory();
  $('history').hidden = !items.length;
  const list = $('history-list');
  list.replaceChildren();
  for (const r of items) {
    const btn = el('button', { class: 'link', text: 'View' });
    btn.style.width = 'auto';
    btn.addEventListener('click', () => {
      renderReport(r, { past: true });
      window.scrollTo(0, 0);
    });
    const del = el('button', { class: 'del', text: '✕', 'aria-label': 'Delete this check' });
    del.addEventListener('click', () => {
      const all = loadHistory();
      const i = all.findIndex((x) => x.date === r.date);
      if (i < 0) return;
      store.save(HISTORY_KEY, all.filter((_, j) => j !== i)); renderHistory();
      toast('Check deleted', { actionLabel: 'Undo', onAction: () => { const now = loadHistory(); now.splice(i, 0, r); store.save(HISTORY_KEY, now); renderHistory(); } });
    });
    list.append(
      el(
        'li',
        {},
        el(
          'div',
          { class: 'line' },
          el('div', {}, el('div', { class: 'name', text: new Date(r.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) }), el('span', { class: 'tag ' + r.level, text: r.headline })),
          el('div', { class: 'row', style: 'gap:4px;flex:0 0 auto;width:auto' }, btn, del)
        )
      )
    );
  }
}

// ---------- live readings ----------
function stopLive() {
  if (!liveRunning) return;
  liveRunning = false;
  $('btn-live').textContent = 'Start';
}

async function liveLoop() {
  if (!supportedPids) {
    setStatus('live-status', 'Finding out which readings your car provides…');
    supportedPids = await obd.readSupportedPids(elm);
  }
  const active = PIDS.filter((p) => supportedPids.has(p.pid));
  if (!active.length) throw new Error('Your car did not offer any live readings.');

  const out = $('live-out');
  out.replaceChildren();
  const cells = new Map();
  let group = null;
  let list = null;
  for (const p of active) {
    if (p.group !== group) {
      group = p.group;
      list = el('ul', { class: 'list' });
      out.append(el('h3', { text: group }), el('div', { class: 'card' }, list));
    }
    const value = el('span', { text: '–' });
    const tag = el('span', { class: 'tag', hidden: '' });
    cells.set(p.pid, { value, tag });
    list.append(
      el(
        'li',
        { class: 'reading' },
        el('div', { class: 'name', text: p.name }),
        el('div', { class: 'value' }, value, el('span', { class: 'unit', text: p.unit })),
        el('div', { class: 'sub', text: p.explain }),
        tag
      )
    );
  }
  setStatus('live-status', 'Updating continuously. Tap Stop when you are done.');

  while (liveRunning && elm) {
    for (const p of active) {
      if (!liveRunning || !elm) break;
      const data = await obd.readPid(elm, p.pid);
      if (!data) continue;
      const v = p.calc(data);
      const cell = cells.get(p.pid);
      cell.value.textContent = v.toFixed(p.digits);
      if (p.status) {
        const s = p.status(v);
        cell.tag.textContent = s.text;
        cell.tag.className = 'tag ' + s.level;
        cell.tag.hidden = false;
      }
    }
  }
}

$('btn-live').addEventListener('click', async () => {
  if (liveRunning) return stopLive();
  if (!elm || busy) return;
  if (tripRunning) {
    setStatus('live-status', 'A trip is being recorded. Stop it on the Trips tab first.', true);
    return;
  }
  liveRunning = true;
  $('btn-live').textContent = 'Stop';
  try {
    await liveLoop();
    if (elm) setStatus('live-status', 'Stopped.');
  } catch (e) {
    if (elm) setStatus('live-status', friendly(e), true);
    log('info', 'Live readings stopped: ' + e.message);
  } finally {
    stopLive();
  }
});

// ---------- turn off warning light ----------
$('btn-clear').addEventListener('click', async () => {
  if (!elm || busy) return;
  const ok = confirm(
    'Turn off the engine warning light and wipe the engine\'s stored faults?\n\n' +
      'This does not repair anything. Make sure the ignition is on and the engine is off.'
  );
  if (!ok) return;
  busy = true;
  $('btn-clear').disabled = true;
  setStatus('clear-status', 'Working…');
  try {
    const cleared = await obd.clearDtcs(elm);
    if (!cleared) throw new Error('The car did not confirm. Check the ignition is on and the engine is off, then try again.');
    setStatus('clear-status', 'Done. Run "Check my car" again to confirm.');
  } catch (e) {
    log('info', 'Clear failed: ' + e.message);
    setStatus('clear-status', friendly(e), true);
  } finally {
    busy = false;
    $('btn-clear').disabled = !elm;
  }
});

// ---------- Android Auto diagnosis ----------
const APPCONNECT_LIKELY = {
  no: ['Hardware not fitted', 'urgent'],
  maybe: ['Hardware may not be fitted', 'soon'],
  likely: ['Hardware likely fitted', 'ok'],
};

function renderChecklist(container) {
  // Walk the question tree one answer at a time.
  function ask(stepId) {
    const step = CHECKLIST.find((s) => s.id === stepId);
    if (!step) return;
    const box = el('div', { class: 'card' }, el('p', { class: 'name', text: step.question }));
    const buttons = el('div', { class: 'row' });
    for (const [key, outcome] of Object.entries(step.answers)) {
      const label = {
        no: 'No', yes: 'Yes', dealer: 'A "contact dealer" message', nothing: 'Nothing happens',
        'works-sometimes': 'Works on and off',
      }[key] || key;
      const btn = el('button', { text: label });
      btn.addEventListener('click', () => {
        buttons.replaceChildren(el('span', { class: 'tag minor', text: 'You chose: ' + label }));
        // Remove anything previously shown below this question.
        while (box.nextSibling) box.nextSibling.remove();
        if (outcome.next) ask(outcome.next);
        else container.append(el('div', { class: 'card issue ' + outcome.level }, el('span', { class: 'tag ' + outcome.level, text: 'Most likely' }), el('h2', { text: outcome.verdict }), el('p', { text: outcome.detail })));
      });
      buttons.append(btn);
    }
    box.append(buttons);
    container.append(box);
  }
  ask(CHECKLIST[0].id);
}

$('btn-aa').addEventListener('click', async () => {
  if (!elm || busy) return;
  busy = true;
  $('btn-aa').disabled = true;
  stopLive();
  const out = $('aa-out');
  out.replaceChildren();
  setStatus('aa-status', 'Reading the touchscreen unit…');
  try {
    const d = await diagnoseAppConnect(elm);
    setStatus('aa-status', '');

    if (d.reachable) {
      const facts = el('dl', { class: 'facts' });
      for (const [k, v] of [
        ['VW name', d.systemName],
        ['Part number', d.partNumber],
        ['Software version', d.softwareVersion],
        ['Software suffix', d.suffix ? `"${d.suffix}" — tell this to a coder; it decides which activation code is needed` : null],
      ]) {
        if (v) facts.append(el('div', {}, el('dt', { text: k }), el('dd', { text: v })));
      }
      const card = el('div', { class: 'card' }, el('h2', { text: 'Your touchscreen unit' }), facts);
      if (d.hint) {
        const [label, cls] = APPCONNECT_LIKELY[d.hint.appConnect];
        card.append(el('p', { class: 'state-note', style: 'margin-top:12px' }, el('span', { class: 'tag ' + cls, text: label }), el('span', { text: '  Likely ' + d.hint.likely + '. ' + d.hint.note })));
      } else if (d.partNumber) {
        card.append(el('p', { class: 'muted small', text: 'This app can\'t tell the exact model from the part number above — show it to a specialist to confirm whether App-Connect hardware is fitted.' }));
      }
      if (d.faults.length) card.append(el('p', { class: 'muted small', text: `The unit has ${d.faults.length} stored fault(s) — see the full "Check my car" report.` }));

      const share = el('button', { text: 'Send these details to a dealer' });
      share.addEventListener('click', async () => {
        const text = dealerSummary(d);
        try {
          if (navigator.share) await navigator.share({ title: 'VW Tiguan infotainment unit', text });
          else {
            await navigator.clipboard.writeText(text);
            share.textContent = 'Copied. Paste it into a message';
          }
        } catch {
          /* share sheet closed */
        }
      });
      card.append(el('p', { class: 'muted small', style: 'margin-top:12px', text: 'Hand these to a VW dealer or specialist to ask about activating App-Connect:' }), share);
      out.append(card);
    } else {
      out.append(el('div', { class: 'card' }, el('p', { class: 'muted', text: d.summary })));
    }

    out.append(el('h3', { text: 'Answer these to narrow it down' }));
    renderChecklist(out);
  } catch (e) {
    log('info', 'Android Auto check failed: ' + e.message);
    setStatus('aa-status', friendly(e), true);
  } finally {
    busy = false;
    $('btn-aa').disabled = !elm;
  }
});

// ---------- trips & fuel economy ----------
let tripRunning = false;
let trip = null;

const SVGNS = 'http://www.w3.org/2000/svg';
function sparkline(samples, key, color) {
  const w = 320, h = 80, pad = 4;
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'spark');
  if (samples.length < 2) return svg;
  const t0 = samples[0].t;
  const t1 = samples[samples.length - 1].t || t0 + 1;
  const ys = samples.map((s) => s[key]);
  const lo = Math.min(...ys, 0);
  const hi = Math.max(...ys, lo + 1);
  const px = (t) => pad + ((t - t0) / (t1 - t0 || 1)) * (w - 2 * pad);
  const py = (v) => h - pad - ((v - lo) / (hi - lo || 1)) * (h - 2 * pad);
  const d = samples.map((s, i) => `${i ? 'L' : 'M'}${px(s.t).toFixed(1)} ${py(s[key]).toFixed(1)}`).join(' ');
  const path = document.createElementNS(SVGNS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', color);
  path.setAttribute('stroke-width', '2');
  path.setAttribute('vector-effect', 'non-scaling-stroke');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

const KMH_TO_MPH = 1 / 1.609344;
let chartTick = 0;

function renderTripStats(t, currentSpeedKmh, fuelLph) {
  const tiles = [
    ['Distance', t.miles.toFixed(1), 'miles'],
    ['Average economy', t.avgMpg > 0 ? t.avgMpg.toFixed(1) : '—', 'mpg'],
    ['Speed now', Math.round(currentSpeedKmh * KMH_TO_MPH), 'mph'],
    ['Fuel used', t.fuelL > 0 ? t.fuelL.toFixed(2) : '—', 'litres'],
    ['Average speed', Math.round(t.avgSpeedKmh * KMH_TO_MPH), 'mph'],
    ['Time', formatDuration(t.seconds), ''],
  ];
  const grid = $('trip-stats');
  grid.replaceChildren(
    ...tiles.map(([label, value, unit]) =>
      el('div', { class: 'tile' }, el('div', { class: 'label', text: label }), el('div', { class: 'value' }, el('span', { text: String(value) }), unit ? el('span', { class: 'unit', text: ' ' + unit }) : null))
    )
  );
  if (chartTick++ % 4 === 0) {
    $('chart-speed').replaceChildren(sparkline(t.samples.map((s) => ({ t: s.t, v: s.speedKmh * KMH_TO_MPH })), 'v', 'var(--accent)'));
    $('chart-mpg').replaceChildren(sparkline(t.samples.filter((s) => s.mpg > 0), 'mpg', 'var(--ok)'));
  }
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m ? `${m}m ${s}s` : `${s}s`;
}

async function tripLoop() {
  if (!supportedPids) {
    setStatus('trip-status', 'Checking which readings your car provides…');
    supportedPids = await obd.readSupportedPids(elm);
  }
  const has5E = supportedPids.has(0x5e);
  const hasMaf = supportedPids.has(0x10);
  if (!supportedPids.has(0x0d)) throw new Error('Your car does not report road speed, so trips cannot be tracked.');
  trip = new Trip();
  chartTick = 0;
  $('trip-live').hidden = false;
  setStatus('trip-status', has5E || hasMaf ? 'Recording. Drive as normal; tap Stop at the end.' : 'Recording distance and speed. Your car does not report fuel use, so economy figures are unavailable.');
  let last = Date.now();
  while (tripRunning && elm) {
    const sd = await obd.readPid(elm, 0x0d);
    const speed = sd ? sd[0] : 0;
    let fuelLph = null;
    if (has5E) {
      const d = await obd.readPid(elm, 0x5e);
      if (d) fuelLph = fuelRateFrom5E(d);
    } else if (hasMaf) {
      const d = await obd.readPid(elm, 0x10);
      if (d) fuelLph = fuelRateFromMaf((d[0] * 256 + d[1]) / 100);
    }
    const now = Date.now();
    trip.add(speed, fuelLph, (now - last) / 1000);
    last = now;
    renderTripStats(trip, speed, fuelLph);
  }
}

function stopTrip(save = true) {
  if (!tripRunning) return;
  tripRunning = false;
  $('btn-trip').textContent = 'Start recording';
  if (save && demoMode) {
    setStatus('trip-status', 'Demo trip — example data, not saved.');
  } else if (save && trip && trip.distanceKm > 0.05) {
    saveTrip(trip.summary());
    renderTrips();
    setStatus('trip-status', `Trip saved: ${trip.miles.toFixed(1)} miles${trip.avgMpg > 0 ? `, ${trip.avgMpg.toFixed(1)} mpg` : ''}.`);
  } else if (save) {
    setStatus('trip-status', 'Stopped. Too short to save.');
  }
}

$('btn-trip').addEventListener('click', async () => {
  if (tripRunning) return stopTrip(true);
  if (!elm || busy) return;
  stopLive();
  tripRunning = true;
  $('btn-trip').textContent = 'Stop recording';
  try {
    await tripLoop();
  } catch (e) {
    if (elm) setStatus('trip-status', friendly(e), true);
    log('info', 'Trip recording stopped: ' + e.message);
    stopTrip(false);
  }
});

const TRIPS_KEY = 'tiguan-trips';
const loadTrips = () => store.load(TRIPS_KEY, []);
function saveTrip(summary) {
  store.save(TRIPS_KEY, [summary, ...loadTrips()].slice(0, 30));
}
function renderTrips() {
  const trips = loadTrips();
  $('trips-history').hidden = !trips.length;
  const list = $('trips-list');
  list.replaceChildren();
  for (const t of trips) {
    const when = new Date(t.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const detail = `${t.miles.toFixed(1)} miles · ${formatDuration(t.seconds)}${t.avgMpg > 0 ? ` · ${t.avgMpg.toFixed(1)} mpg` : ''}`;
    const del = el('button', { class: 'del', text: '✕', 'aria-label': 'Delete this trip' });
    del.addEventListener('click', () => {
      const all = loadTrips(); const i = all.findIndex((x) => x.date === t.date);
      if (i < 0) return;
      store.save(TRIPS_KEY, all.filter((_, j) => j !== i)); renderTrips();
      toast('Trip deleted', { actionLabel: 'Undo', onAction: () => { const now = loadTrips(); now.splice(i, 0, t); store.save(TRIPS_KEY, now); renderTrips(); } });
    });
    list.append(el('li', {}, el('div', { class: 'line' }, el('div', {}, el('div', { class: 'name', text: when }), el('div', { class: 'sub', text: detail })), del)));
  }
}

// ---------- car hub: shared storage ----------
const VEHICLE_KEY = 'tiguan-vehicle';
const FUEL_KEY = 'tiguan-fuel';
const SERVICE_KEY = 'tiguan-service';
const MILEAGE_KEY = 'tiguan-mileage';
const PARK_KEY = 'tiguan-park';
const loadVehicle = () => store.load(VEHICLE_KEY, {});
const saveVehicle = (v) => store.save(VEHICLE_KEY, v);

const fmtDate = (iso) => new Date(iso + (iso.length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

// Renewals + registration
function refreshRenewals() {
  const v = loadVehicle();
  const out = $('renewals-out');
  const list = renewals({ mot: v.mot, tax: v.tax, insurance: v.insurance, service: v.service });
  out.replaceChildren();
  if (!list.length) {
    out.append(el('p', { class: 'muted small', text: 'Add any dates below to get reminders here.' }));
  } else {
    const ul = el('ul', { class: 'list' });
    for (const r of list) ul.append(el('li', {}, el('div', { class: 'line' }, el('div', { class: 'name', text: r.label }), el('span', { class: 'tag ' + r.level, text: r.text.replace(r.label + ' ', '') }))));
    out.append(ul);
  }
  $('lnk-mot').href = GOV_MOT_HISTORY;
  $('lnk-tax').href = GOV_TAX_CHECK;
  const cal = v.mot ? calendarUrl(v.reg, v.mot, partnerEmail()) : null;
  $('lnk-cal').hidden = !cal;
  if (cal) $('lnk-cal').href = cal;
  renderDashboard();
}
$('reg-input').addEventListener('input', (e) => {
  const v = loadVehicle();
  v.reg = cleanReg(e.target.value);
  saveVehicle(v);
  refreshRenewals();
  autoLookupCar(false);
});
// Short / private plates are looked up when you leave the box.
$('reg-input').addEventListener('change', () => autoLookupCar(true));
// Look the car up by itself once a complete UK registration has been typed.
let regTimer = null;
function autoLookupCar(leftBox) {
  clearTimeout(regTimer);
  regTimer = setTimeout(() => {
    const reg = cleanReg($('reg-input').value);
    const v = loadVehicle();
    if (!(leftBox ? looksLikeUkReg(reg) : isFullModernReg(reg))) return;
    if (v.official && cleanReg(v.official.reg || '') === reg && Date.now() - (v.officialAt || 0) < 3600000) return; // just done
    lookupCar(true);
  }, leftBox ? 50 : 900);
}
for (const key of ['mot', 'tax', 'insurance', 'service']) {
  $(key + '-input').addEventListener('change', (e) => {
    const v = loadVehicle();
    v[key] = e.target.value;
    saveVehicle(v);
    refreshRenewals();
  });
}

// Where did I park?
function renderPark() {
  const spot = store.load(PARK_KEY, null);
  const out = $('park-out');
  if (!spot) {
    out.textContent = 'No spot saved yet.';
    $('lnk-park').hidden = true;
    return;
  }
  out.textContent = `Saved ${timeAgo(spot.time)}.`;
  $('lnk-park').hidden = false;
  $('lnk-park').href = parkMapsUrl(spot);
}
$('btn-park').addEventListener('click', () => {
  if (!navigator.geolocation) {
    $('park-out').textContent = 'This phone will not share its location with the app.';
    return;
  }
  $('park-out').textContent = 'Getting your location…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      store.save(PARK_KEY, { lat: pos.coords.latitude, lng: pos.coords.longitude, time: new Date().toISOString() });
      renderPark();
    },
    () => {
      $('park-out').textContent = 'Could not get your location. Allow location access and try again.';
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

// Fuel log
const num = (id) => parseFloat($(id).value) || 0;
function renderFuel() {
  const fills = store.load(FUEL_KEY, []);
  const s = fuelStats(fills);
  const tiles = [
    ['Latest', s.latestMpg ? s.latestMpg.toFixed(1) : '—', 'mpg'],
    ['Average', s.avgMpg ? s.avgMpg.toFixed(1) : '—', 'mpg'],
    ['Total spent', '£' + s.totalSpend.toFixed(0), ''],
    ['Pump price', s.lastPricePerLitre ? s.lastPricePerLitre.toFixed(1) : '—', 'p/L'],
  ];
  $('fuel-stats').replaceChildren(
    ...tiles.map(([label, value, unit]) => el('div', { class: 'tile' }, el('div', { class: 'label', text: label }), el('div', { class: 'value' }, el('span', { text: value }), unit ? el('span', { class: 'unit', text: ' ' + unit }) : null)))
  );
  const list = $('fuel-list');
  list.replaceChildren();
  const bySeg = new Map(s.segments.map((seg) => [seg.toOdo, seg]));
  for (const f of [...fills].sort((a, b) => b.odo - a.odo)) {
    const seg = bySeg.get(f.odo);
    const detail = `${f.litres.toFixed(1)} L${f.cost ? ` · £${f.cost.toFixed(2)}` : ''} · ${f.odo.toLocaleString('en-GB')} mi${seg ? ` · ${seg.mpg.toFixed(1)} mpg` : ''}`;
    list.append(deletableRow(fmtDate(f.date), detail, () => {
      store.save(FUEL_KEY, store.load(FUEL_KEY, []).filter((x) => x.id !== f.id));
      renderFuel();
    }));
  }
}
$('btn-fuel-add').addEventListener('click', () => {
  const odo = num('fuel-odo');
  const litres = num('fuel-litres');
  if (!odo || !litres) {
    alert('Please enter at least the mileage and litres.');
    return;
  }
  const entry = { id: Date.now(), date: $('fuel-date').value || todayISO(), odo, litres, cost: num('fuel-cost'), full: $('fuel-full').checked };
  store.save(FUEL_KEY, [entry, ...store.load(FUEL_KEY, [])]);
  for (const id of ['fuel-odo', 'fuel-litres', 'fuel-cost']) $(id).value = '';
  renderFuel();
});

// Service history
function renderService() {
  const items = store.load(SERVICE_KEY, []);
  const list = $('svc-list');
  list.replaceChildren();
  for (const r of [...items].sort((a, b) => (a.date < b.date ? 1 : -1))) {
    const detail = `${r.odo ? r.odo.toLocaleString('en-GB') + ' mi' : ''}${r.odo && r.cost ? ' · ' : ''}${r.cost ? '£' + r.cost.toFixed(2) : ''}`;
    list.append(deletableRow(`${fmtDate(r.date)} — ${r.what}`, detail, () => {
      store.save(SERVICE_KEY, store.load(SERVICE_KEY, []).filter((x) => x.id !== r.id));
      renderService();
    }));
  }
}
$('btn-svc-add').addEventListener('click', () => {
  const what = $('svc-what').value.trim();
  if (!what) {
    alert('Please say what was done.');
    return;
  }
  const entry = { id: Date.now(), date: $('svc-date').value || todayISO(), odo: num('svc-odo'), what, cost: num('svc-cost') };
  store.save(SERVICE_KEY, [entry, ...store.load(SERVICE_KEY, [])]);
  for (const id of ['svc-odo', 'svc-what', 'svc-cost']) $(id).value = '';
  renderService();
});

// Mileage log
function renderMileage() {
  const trips = store.load(MILEAGE_KEY, []);
  const m = mileageSummary(trips);
  $('mileage-summary').replaceChildren(
    el('div', { class: 'tile' }, el('div', { class: 'label', text: 'Business miles (this tax year)' }), el('div', { class: 'value' }, el('span', { text: Math.round(m.businessMiles).toLocaleString('en-GB') }))),
    el('div', { class: 'tile' }, el('div', { class: 'label', text: 'Reclaim estimate' }), el('div', { class: 'value' }, el('span', { text: '£' + m.reclaim.toFixed(0) })))
  );
  $('btn-mile-export').hidden = trips.length === 0;
  const list = $('mileage-list');
  list.replaceChildren();
  for (const t of [...trips].sort((a, b) => (a.date < b.date ? 1 : -1))) {
    const detail = `${t.miles} mi${t.business ? ' · business' : ''}`;
    list.append(deletableRow(`${fmtDate(t.date)}${t.purpose ? ' — ' + t.purpose : ''}`, detail, () => {
      store.save(MILEAGE_KEY, store.load(MILEAGE_KEY, []).filter((x) => x.id !== t.id));
      renderMileage();
    }));
  }
}
$('btn-mile-add').addEventListener('click', () => {
  const miles = num('mile-miles');
  if (!miles) {
    alert('Please enter the miles.');
    return;
  }
  const entry = { id: Date.now(), date: $('mile-date').value || todayISO(), miles, purpose: $('mile-purpose').value.trim(), business: $('mile-business').checked };
  store.save(MILEAGE_KEY, [entry, ...store.load(MILEAGE_KEY, [])]);
  $('mile-miles').value = '';
  $('mile-purpose').value = '';
  renderMileage();
});
$('btn-mile-export').addEventListener('click', async () => {
  const text = mileageExport(store.load(MILEAGE_KEY, []));
  try {
    if (navigator.share) await navigator.share({ title: 'Mileage log', text });
    else {
      await navigator.clipboard.writeText(text);
      $('btn-mile-export').textContent = 'Copied as spreadsheet text';
      setTimeout(() => ($('btn-mile-export').textContent = 'Export for expenses'), 2000);
    }
  } catch {
    /* share sheet closed */
  }
});

/** A list row with a small delete button. */
function deletableRow(name, detail, onDelete) {
  const del = el('button', { class: 'del', 'aria-label': 'Delete', text: '✕' });
  del.addEventListener('click', onDelete);
  return el('li', {}, el('div', { class: 'line' }, el('div', {}, el('div', { class: 'name', text: name }), detail ? el('div', { class: 'sub', text: detail }) : null), del));
}

function initCarTab() {
  const v = loadVehicle();
  if (v.reg) $('reg-input').value = v.reg;
  for (const key of ['mot', 'tax', 'insurance', 'service']) if (v[key]) $(key + '-input').value = v[key];
  refreshRenewals();
  renderOfficial();
  $('car-files').replaceChildren(el('div', { class: 'card' }, lazyFiles({ shared: false, hint: 'V5C logbook, insurance certificate, service and repair receipts.',
    get: () => loadVehicle().files || [], save: (list) => saveVehicle({ ...loadVehicle(), files: list }) })));
  // Keep the official record (and so the MOT / tax reminders) fresh — weekly.
  if (v.reg && paired() && (!v.officialAt || Date.now() - v.officialAt > CAR_REFRESH_MS)) lookupCar(false);
  renderPark();
  renderFuel();
  renderService();
  renderMileage();
}

// ---------- life admin: documents & reminders ----------
const DOCS_KEY = 'tiguan-docs';

// On-device passport scanner. Tesseract runs the OCR locally; the image never
// leaves the phone. The library is fetched once (needs internet the first time).
let tesseractPromise = null;
function loadTesseract() {
  if (tesseractPromise) return tesseractPromise;
  tesseractPromise = new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve(window.Tesseract);
    const s = document.createElement('script');
    // Served from Evergreen's own site with its fingerprint pinned, so a changed copy is refused.
    s.src = 'js/vendor/tesseract-5.1.1.min.js';
    s.integrity = 'sha384-GJqSu7vueQ9qN0E9yLPb3Wtpd7OrgK8KmYzC8T1IysG1bcvxvIO4qtYR/D3A991F';
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => { tesseractPromise = null; reject(new Error('Could not load the scanner (it needs internet the first time).')); };
    document.head.appendChild(s);
  });
  return tesseractPromise;
}
$('btn-scan-passport').addEventListener('click', (e) => { e.preventDefault(); $('passport-photo').click(); });
$('passport-photo').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $('scan-ocr').hidden = true;
  setStatus('passport-status', 'Reading on your phone… this can take a few seconds.');
  try {
    const { parseMRZ } = await import('./mrz.js');
    const T = await loadTesseract();
    const { data } = await T.recognize(file, 'eng');
    const mrz = parseMRZ(data.text);
    if (mrz && mrz.number) {
      // Passport: the machine-readable zone decodes reliably, so fill directly.
      if (mrz.name) $('doc-label').value = mrz.name;
      if (mrz.expiry) $('doc-expiry').value = mrz.expiry;
      $('doc-note').value = `Passport no. ${mrz.number}${mrz.nationality ? ' · ' + mrz.nationality : ''}`;
      $('doc-category').value = 'Passport';
      setStatus('passport-status', `Found: ${mrz.name || 'name'}, expires ${mrz.expiry}. Please check it before saving.`);
      return;
    }
    // Any other document: show the recognised text to hand to Claude.
    const text = (data.text || '').trim();
    if (!text) throw new Error('readfail');
    $('scan-ocr-text').textContent = text;
    $('scan-ocr').hidden = false;
    setStatus('passport-status', 'Read the text below. Copy it and paste it to Claude to turn it into details you can import.');
  } catch (err) {
    log('info', 'Document scan: ' + err.message);
    setStatus('passport-status', err.message === 'readfail'
      ? 'Couldn\'t read it. Lay it flat in good light, fill the frame, and try again.'
      : err.message, true);
  } finally {
    e.target.value = '';
  }
});
$('btn-scan-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('scan-ocr-text').textContent);
    $('btn-scan-copy').textContent = 'Copied — paste it to Claude';
    setTimeout(() => ($('btn-scan-copy').textContent = 'Copy text for Claude'), 2500);
  } catch {
    $('btn-scan-copy').textContent = 'Copy failed — select the text above';
  }
});

/** Shrink an image file to a small JPEG data URL so it fits in on-device storage. */
// Shrink a photo to a JPEG data URL. Tries the browser's fast decoder first
// (which also respects the photo's rotation), then a plain <img>.
async function compressImage(file, maxSize = 900, quality = 0.6) {
  const heic = /hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name || '');
  let source = null;
  try { source = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* try an <img> instead */ }
  if (!source) {
    const url = URL.createObjectURL(file);
    try {
      source = await new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = url; });
    } catch {
      throw new Error(heic
        ? "This phone's browser can't open HEIC photos. In your camera settings turn off 'High efficiency pictures' (Samsung) or choose 'Most Compatible' (iPhone) — or take a screenshot of the photo and add that."
        : "Couldn't open that photo — try another, or take a screenshot of it and add that.");
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
  const w = source.width, h = source.height;
  const scale = Math.min(1, maxSize / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  if (source.close) source.close();
  return canvas.toDataURL('image/jpeg', quality);
}

// ---------- deliveries ----------
const DELIVERIES_KEY = 'tiguan-deliveries';
const EVENTS_KEY = 'tiguan-events';

function renderDeliveries() {
  const sel = $('del-carrier');
  if (sel && !sel.options.length) for (const name of CARRIER_NAMES) sel.add(new Option(name, name));
  const items = sharedItems('delivery').filter((d) => !d.done);
  const list = $('del-list');
  list.replaceChildren();
  const withStatus = items.map((d) => ({ d, s: parcelStatus(d.expected) }));
  withStatus.sort((a, b) => (a.s.days ?? 9999) - (b.s.days ?? 9999));
  for (const { d, s } of withStatus) {
    const head = el('div', { class: 'line' },
      el('div', {}, el('div', { class: 'name', text: d.item || 'Parcel' }), el('div', { class: 'sub', text: d.carrier })),
      el('span', { class: 'tag ' + s.level, text: s.text })
    );
    const row = el('div', { class: 'card doc' }, head);
    const actions = el('div', { class: 'row', style: 'margin-top:10px' });
    const track = el('a', { class: 'btn-a', href: trackingUrl(d.carrier, d.tracking), target: '_blank', rel: 'noopener', text: 'Track parcel →' });
    track.style.flex = '1';
    const arrived = el('button', { text: 'Arrived' });
    arrived.addEventListener('click', () => {
      sharedRemove(d.id);
      renderDeliveries();
      renderDashboard();
      scheduleSync();
    });
    actions.append(track, arrived);
    row.append(actions);
    list.append(row);
  }
  if (!items.length) list.append(el('li', { class: 'muted small', text: 'No parcels being tracked.' }));
}
$('btn-del-add').addEventListener('click', () => {
  const item = $('del-item').value.trim();
  const tracking = $('del-tracking').value.trim();
  if (!item && !tracking) {
    alert('Add at least a name or a tracking number.');
    return;
  }
  sharedAdd('delivery', { item, carrier: $('del-carrier').value, tracking, expected: $('del-expected').value, done: false });
  scheduleSync();
  for (const id of ['del-item', 'del-tracking', 'del-expected']) $(id).value = '';
  renderDeliveries();
  renderDashboard();
  toast('Delivery added ✓');
});

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function isAppEmpty() {
  const v = loadVehicle();
  const anyList = [DOCS_KEY, SUBS_KEY, LOYAL_KEY, MAINT_KEY, CHECK_KEY, INV_KEY].some((k) => store.load(k, []).length);
  const anyShopping = Object.values(store.load(SHARED_KEY, {})).some((i) => !i.deleted); // anything shared counts as 'not empty'
  return !anyList && !anyShopping && !v.reg && !v.mot;
}
function welcomeCard() {
  const card = el('div', { class: 'card' },
    el('h2', { text: 'Welcome to Evergreen 🌲' }),
    el('p', { class: 'muted', text: 'Your private home for life admin. The quickest way to fill it in: tell Claude your details and paste them in with Quick Import, or scan a document. Or just tap a tile below to add things one at a time.' }));
  const row = el('div', { class: 'row' });
  const imp = el('button', { class: 'primary', text: 'Quick import' });
  imp.addEventListener('click', () => { showTab('help'); $('import-card').open = true; $('import-card').scrollIntoView({ behavior: 'smooth' }); });
  const scan = el('button', { text: 'Scan a document' });
  scan.addEventListener('click', () => goLife('documents'));
  row.append(imp, scan);
  card.append(row);
  return card;
}

const HOME_TILES = [
  { icon: '📅', label: 'Calendar', go: () => goLife('calendar'), badge: () => { const n = upcomingEvents(0).length; return n ? { text: n + ' today', cls: 'minor' } : null; } },
  { icon: '🛒', label: 'Shopping list', go: () => goLife('shopping'), badge: () => { const n = sharedItems('shop').filter((i) => !i.done).length; return n ? { text: String(n), cls: 'minor' } : null; } },
  { icon: '✅', label: 'To-do list', go: () => goLife('tasks'), badge: () => { const n = sharedItems('task').filter((i) => !i.done).length; return n ? { text: String(n), cls: 'minor' } : null; } },
  { icon: '📦', label: 'Deliveries', go: () => goLife('deliveries'), badge: () => { const n = sharedItems('delivery').filter((d) => !d.done).length; return n ? { text: String(n), cls: 'minor' } : null; } },
  { icon: '📄', label: 'Documents', go: () => goLife('documents'), badge: () => { const soon = store.load(DOCS_KEY, []).filter((d) => d.expiry && countdown(d.expiry, '').days <= 30).length; return soon ? { text: String(soon), cls: 'soon' } : null; } },
  { icon: '🛡️', label: 'Insurance', go: () => goLife('insurance'), badge: () => { const n = policies().filter((p) => { const cd = p.renewal && countdown(p.renewal, ''); return cd && cd.days <= 30; }).length; return n ? { text: String(n), cls: 'soon' } : null; } },
  { icon: '⚡', label: 'Bills & suppliers', go: () => goLife('utilities'), badge: () => { const soon = utilities().filter((u) => { const cd = u.renewal && countdown(u.renewal, ''); return cd && cd.days >= 0 && cd.days <= 30; }).length; return soon ? { text: String(soon), cls: 'soon' } : null; } },
  { icon: '💷', label: 'Money & tax', go: () => goLife('tax') },
  { icon: '🏠', label: 'Home', go: () => goLife('home') },
  { icon: '❤️', label: 'Health', go: () => goLife('health') },
  { icon: '💳', label: 'Loyalty', go: () => goLife('loyalty') },
  { icon: '🚗', label: 'Car', go: () => showTab('car'), badge: () => { const v = loadVehicle(); const n = ['mot', 'tax', 'insurance', 'service'].filter((k) => { const cd = v[k] && countdown(v[k], ''); return cd && cd.days <= 30; }).length; return n ? { text: String(n), cls: 'soon' } : null; } },
  { icon: '🚆', label: 'Trains', go: () => goLife('trains'), badge: () => { const b = settings().trainBad; return b && b.n && Date.now() - b.at < 30 * 60000 ? { text: `${b.n} disrupted`, cls: 'soon' } : null; } },
  { icon: '✈️', label: 'Travel', go: () => goLife('travel'), badge: () => { const t = upcomingTrip(); return t ? { text: tripStatus(t, todayISO()), cls: 'minor' } : null; } },
  { icon: '👨‍👩‍👧', label: 'Family', go: () => goLife('family'), badge: () => { const n = sharedItems('child').filter((c) => { const cd = c.passportExpiry && countdown(c.passportExpiry, ''); return cd && cd.days <= 180; }).length; return n ? { text: String(n), cls: 'soon' } : null; } },
  { icon: '⚙️', label: 'Settings', go: () => showTab('help') },
];
// Home shows your favourite sections; everything else is one tap away under Life.
const DEFAULT_TILES = ['Calendar', 'Shopping list', 'To-do list', 'Deliveries', 'Family', 'Bills & suppliers', 'Insurance', 'Travel', 'Car'];
const favouriteTiles = () => { const f = settings().homeTiles; return Array.isArray(f) && f.length ? f : DEFAULT_TILES; };
function openTilePicker() {
  const chosen = new Set(favouriteTiles());
  const boxes = HOME_TILES.map((t) => { const cb = el('input', { type: 'checkbox' }); cb.checked = chosen.has(t.label); cb.addEventListener('change', () => (cb.checked ? chosen.add(t.label) : chosen.delete(t.label))); return el('label', { class: 'check tile-pick' }, cb, ` ${t.label}`); });
  const save = el('button', { class: 'primary', type: 'button', text: 'Save' });
  save.addEventListener('click', () => { saveSettings({ homeTiles: HOME_TILES.map((t) => t.label).filter((l) => chosen.has(l)) }); closeSheet(); renderTiles(); toast('Home updated ✓'); });
  const reset = el('button', { type: 'button', text: 'Reset' });
  reset.addEventListener('click', () => { saveSettings({ homeTiles: [] }); closeSheet(); renderTiles(); });
  openSheet(el('h2', { text: 'Choose your Home shortcuts' }), el('p', { class: 'muted small', text: 'Just on this phone. Everything else is under Life.' }), el('div', { class: 'tile-picks' }, ...boxes), el('div', { class: 'row' }, reset, save));
}
function renderTiles() {
  const grid = $('home-tiles');
  if (!grid) return;
  grid.replaceChildren();
  const favs = favouriteTiles();
  for (const t of HOME_TILES.filter((x) => favs.includes(x.label))) {
    const tile = el('button', { class: 'tile-btn' }, icon(TILE_ICON[t.label] || 'doc'), el('span', { class: 'tile-label', text: t.label }));
    const badge = t.badge && t.badge();
    if (badge) tile.append(el('span', { class: 'tag ' + badge.cls, text: badge.text }));
    tile.addEventListener('click', () => { haptic(); t.go(); });
    grid.append(tile);
  }
  const all = el('button', { class: 'tile-btn tile-more' }, el('span', { class: 'tile-more-ico', text: '⋯' }), el('span', { class: 'tile-label', text: 'Everything else' }));
  all.addEventListener('click', () => { haptic(); goLife(null); });
  grid.append(all);
  const edit = el('button', { class: 'link tiles-edit', type: 'button', text: 'Choose shortcuts' });
  edit.addEventListener('click', openTilePicker);
  grid.parentNode?.querySelectorAll(':scope > .tiles-edit').forEach((x) => x.remove());
  grid.after(edit);
}
function renderHome() {
  renderDashboard();
  renderTiles();
}

// ---------- this-week agenda (a glanceable snapshot of the family calendar) ----------
function eventStart(e) {
  const t = (e.time || '').trim();
  const hhmm = /^\d{1,2}:\d{2}$/.test(t) ? (t.length === 4 ? '0' + t : t) : '00:00';
  const d = new Date((e.date || '') + 'T' + hhmm + ':00');
  return isNaN(d) ? null : d;
}
/** Future events within `days` of today, soonest first. */
function upcomingEvents(days = 7) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const horizon = new Date(today); horizon.setDate(horizon.getDate() + days + 1);
  const rows = sharedItems('event').filter((e) => {
    if (!e.date) return false;
    const d = new Date(e.date + 'T00:00:00');
    return !isNaN(d) && d >= today && d < horizon;
  });
  // Birthdays from Family appear automatically.
  for (const c of sharedItems('child')) {
    const nb = c.dob && nextBirthday(c.dob, todayISO());
    if (!nb) continue;
    const d = new Date(nb.date + 'T00:00:00');
    if (d >= today && d < horizon) rows.push({ id: 'bday-' + c.id, title: `🎂 ${c.name}'s birthday${nb.turning ? ` (${nb.turning})` : ''}`, date: nb.date, time: '', who: 'Birthdays', virtual: true });
  }
  // Trips (and their flights, hotel check-ins…) appear automatically too.
  const fromISO = todayISO(), toISO = isoPlus(fromISO, days);
  for (const t of trips()) rows.push(...tripCalendarRows(t, fromISO, toISO));
  rows.push(...bankHolidayRows(fromISO, toISO));
  // Events from a connected calendar always belong to someone: if that phone had
  // no name set, it's yours (your calendar) or your partner's (theirs).
  const mySrc = settings().calSrc;
  const labelled = rows.map((e) => (e.src && !e.who ? { ...e, who: e.src === mySrc ? myName() : partnerName() } : e));
  labelled.sort((a, b) => ((eventStart(a)?.getTime() || 0) - (eventStart(b)?.getTime() || 0)));
  return groupEvents(labelled); // the same event in both calendars (or an old copy) shows once
}
/** Drop events whose day has passed, so the store doesn't grow forever. */
function pruneEvents() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let removed = 0;
  for (const e of sharedItems('event')) {
    const d = new Date((e.date || '') + 'T00:00:00');
    if (e.date && !isNaN(d) && d < today) { sharedRemove(e.id); removed++; }
  }
  if (removed) scheduleSync();
}
function dayLabel(isoDate) {
  const d = new Date(isoDate + 'T00:00:00');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((d - today) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
}
// ----- bottom sheet (used for event details, adding events, the fingerprint offer)
function openSheet(...nodes) {
  $('sheet-body').replaceChildren(...nodes.filter(Boolean));
  $('sheet').hidden = false;
  syncNav();
}
function closeSheet() { $('sheet').hidden = true; $('sheet-body').replaceChildren(); syncNav(); }
$('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeSheet(); });

// ----- people colours on the calendar
const ADDED_HERE = '#d98a00';
function personColour(who) {
  if (!who) return ADDED_HERE;
  if (who === 'Birthdays') return '#8a4fd6';
  if (who === 'Trips') return '#0b8b80';
  if (who === 'Bank holiday') return '#64748b';
  if (who === 'Both') return '#2b6cd6'; // in both your calendars
  return who === myName() ? '#1f9a5d' : '#d6457a'; // you green, your partner pink
}
const whenText = (e) => (/^\d/.test((e.time || '').trim()) ? e.time.trim() : 'All day');
function eventCard(e, compact = false) {
  const card = el('button', { class: 'cal-ev' + (compact ? ' compact' : '') },
    el('div', { class: 'cal-ev-when', text: whenText(e) + (e.who ? ` · ${e.who === 'Both' ? 'Both of you' : e.who}` : '') }),
    el('div', { class: 'cal-ev-title', text: e.title || 'Event' }),
    e.where ? el('div', { class: 'cal-ev-where', text: e.where }) : null);
  card.style.setProperty('--c', personColour(e.who));
  card.addEventListener('click', () => (e.tripId ? openTrip(e.tripId) : showEvent(e)));
  return card;
}
function eventCards(rows, compact) { const box = el('div', { class: 'cal-evs' }); for (const e of rows) box.append(eventCard(e, compact)); return box; }
function showEvent(e) {
  const d = new Date(e.date + 'T00:00:00');
  const tag = el('div', { class: 'sheet-tag', text: e.who === 'Both' ? `In both calendars — ${e.people.join(' & ')}` : e.who === 'Birthdays' ? 'Birthday from Family' : e.who ? `${e.who}'s calendar` : 'Added in Evergreen' });
  tag.style.setProperty('--c', personColour(e.who));
  const nodes = [tag, el('h2', { text: e.title || 'Event' }),
    el('p', { class: 'muted', text: `${d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })} · ${whenText(e)}` })];
  if (e.where) nodes.push(el('p', { text: '📍 ' + e.where }));
  const row = el('div', { class: 'row' });
  if (e.virtual) {
    nodes.push(el('p', { class: 'muted small', text: 'From Family — change the date of birth there and this updates.' }));
  } else if (e.src) {
    nodes.push(el('p', { class: 'muted small', text: `This comes from ${e.who ? e.who + "'s" : 'a connected'} Google Calendar — change or delete it there and it updates here.` }));
  } else {
    const del = el('button', { text: 'Delete event' });
    del.addEventListener('click', () => { sharedRemove(e.id); scheduleSync(); renderCalendar(); renderHome(); closeSheet(); toast('Event deleted'); });
    row.append(del);
  }
  const close = el('button', { class: 'primary', text: 'Close' });
  close.addEventListener('click', closeSheet);
  row.append(close);
  openSheet(...nodes, row);
}
function openAddEvent(dateISO) {
  const title = el('input', { type: 'text', placeholder: 'e.g. Dentist — Maddy' });
  const date = el('input', { type: 'date' }); date.value = dateISO || todayISO();
  const time = el('input', { type: 'time' });
  const where = el('input', { type: 'text', placeholder: 'optional' });
  const add = el('button', { class: 'primary', text: 'Add' });
  add.addEventListener('click', () => {
    if (!title.value.trim()) { title.focus(); return toast('Give the event a name.'); }
    sharedAdd('event', { title: title.value.trim(), date: date.value || todayISO(), time: time.value || '', where: where.value.trim() });
    scheduleSync(); renderCalendar(); renderHome(); closeSheet(); haptic();
    toast('Event added ✓');
  });
  const cancel = el('button', { text: 'Cancel' });
  cancel.addEventListener('click', closeSheet);
  openSheet(el('h2', { text: 'Add to the family calendar' }),
    el('label', { class: 'field' }, 'What', title),
    el('div', { class: 'grid2' }, el('label', { class: 'field' }, 'Date', date), el('label', { class: 'field' }, 'Time (optional)', time)),
    el('label', { class: 'field' }, 'Where (optional)', where),
    el('div', { class: 'row' }, cancel, add));
  setTimeout(() => title.focus(), 60);
}
$('btn-cal-new').addEventListener('click', () => openAddEvent(calSelected));

function isoPlus(iso, n) { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
let calDays = 14;
let calSelected = null;
function renderCalendar() {
  const list = $('cal-list');
  if (!list) return;
  pruneEvents();
  const today = todayISO();
  const all = upcomingEvents(CAL_DAYS);
  // Legend: whose events are on the calendar (you first, "Added here" last)
  const rank = (p) => (p === myName() ? 0 : p === 'Both' ? 2 : p === 'Birthdays' ? 3 : p === 'Trips' ? 4 : p === 'Bank holiday' ? 5 : !p ? 6 : 1); // you, partner, both, birthdays, trips, added here
  const people = [...new Set(all.map((e) => e.who || ''))].sort((x, y) => rank(x) - rank(y) || x.localeCompare(y));
  $('cal-legend').replaceChildren(...people.map((p) => { const k = el('span', { class: 'cal-key', text: p === 'Both' ? 'Both of you' : p || 'Added here' }); k.style.setProperty('--c', personColour(p)); return k; }));
  // Day strip: the next 14 days, with a dot for each person who has something on
  const strip = $('cal-strip');
  strip.replaceChildren();
  const months = new Set();
  for (let i = 0; i < 14; i++) {
    const iso = isoPlus(today, i);
    const d = new Date(iso + 'T00:00:00');
    months.add(d.toLocaleDateString('en-GB', { month: 'long' }));
    const colours = [...new Set(all.filter((e) => e.date === iso).map((e) => personColour(e.who)))].slice(0, 3);
    const dots = el('span', { class: 'cal-dots' }, ...colours.map((c) => { const dot = el('i'); dot.style.background = c; return dot; }));
    const pill = el('button', { class: 'cal-pill' + (iso === today ? ' today' : '') + (iso === calSelected ? ' sel' : ''), 'aria-label': dayLabel(iso) },
      el('span', { class: 'cal-dow', text: d.toLocaleDateString('en-GB', { weekday: 'short' }) }),
      el('span', { class: 'cal-num', text: String(d.getDate()) }), dots);
    pill.addEventListener('click', () => {
      calSelected = iso;
      for (const p of strip.children) p.classList.toggle('sel', p === pill);
      const block = document.getElementById('cal-d-' + iso);
      if (block) block.scrollIntoView({ behavior: 'smooth', block: 'center' });
      else toast(`Nothing on ${dayLabel(iso)} — tap + Add to add something`);
    });
    strip.append(pill);
  }
  $('cal-month').textContent = [...months].join(' – ');
  // Agenda, grouped by day
  list.replaceChildren();
  if (!all.length) {
    list.append(el('div', { class: 'cal-empty' }, el('div', { class: 'cal-empty-icon', text: '📅' }),
      el('p', { text: settings().icsUrl ? 'Nothing coming up in the next two months.' : 'Nothing here yet — connect your Google Calendar, or tap + Add.' })));
  }
  const rows = all.filter((e) => e.date < isoPlus(today, calDays));
  for (const iso of [...new Set(rows.map((e) => e.date))]) {
    const d = new Date(iso + 'T00:00:00');
    const label = dayLabel(iso);
    const dateBox = el('div', { class: 'cal-date' + (iso === today ? ' today' : '') },
      el('span', { class: 'cal-dow', text: label === 'Today' ? 'Today' : d.toLocaleDateString('en-GB', { weekday: 'short' }) }),
      el('span', { class: 'cal-num', text: String(d.getDate()) }),
      el('span', { class: 'cal-mon', text: d.toLocaleDateString('en-GB', { month: 'short' }) }));
    list.append(el('div', { class: 'cal-dayblock', id: 'cal-d-' + iso }, dateBox, eventCards(rows.filter((e) => e.date === iso))));
  }
  const more = all.length - rows.length;
  $('btn-cal-more').hidden = !more;
  $('btn-cal-more').textContent = `Show ${more} more ▾`;
}
$('btn-cal-more').addEventListener('click', () => { calDays = Math.min(CAL_DAYS, calDays + 14); renderCalendar(); });

const WEEK_OPEN_KEY = 'evergreen-week-open';
function renderToday(out) {
  pruneEvents();
  const today = todayISO();
  const todays = upcomingEvents(0);
  const week = upcomingEvents(6).filter((e) => e.date !== today);
  const card = el('div', { class: 'card today-card' },
    el('div', { class: 'today-head' }, el('h2', { text: 'Family calendar' })));
  if (todays.length) card.append(eventCards(todays, true));
  else card.append(el('p', { class: 'muted', style: 'margin:4px 0 0', text: 'Nothing in the calendar today.' }));
  if (week.length) {
    let open = false;
    try { open = localStorage.getItem(WEEK_OPEN_KEY) === '1'; } catch { /* ignore */ }
    const more = el('div', {});
    let lastDay = null;
    for (const e of week) {
      if (e.date !== lastDay) { more.append(el('div', { class: 'cal-day', text: dayLabel(e.date) }), eventCards(week.filter((x) => x.date === e.date), true)); lastDay = e.date; }
    }
    more.hidden = !open;
    const btn = el('button', { class: 'link today-toggle' });
    const label = () => { btn.textContent = more.hidden ? `Show the rest of the week (${week.length}) ▾` : 'Hide the rest of the week ▴'; };
    label();
    btn.addEventListener('click', () => {
      more.hidden = !more.hidden; label(); haptic();
      try { localStorage.setItem(WEEK_OPEN_KEY, more.hidden ? '0' : '1'); } catch { /* ignore */ }
    });
    card.append(btn, more);
  }
  if (!settings().icsUrl) {
    const connect = el('button', { class: 'link today-toggle', text: 'Connect your Google Calendar →' });
    connect.addEventListener('click', () => goLife('calendar'));
    card.append(connect);
  }
  out.append(card);
}


// ----- the daily briefing at the top of Home: only what matters today -----
function briefingCard(items) {
  const lines = []; // { icon, text, level, go }
  const now = new Date();
  const today = todayISO();
  const evening = now.getHours() >= 18;
  // Weather (and any Met Office warning)
  const place = (settings().weatherPlace || 'Berkhamsted').trim();
  const w = ((settings().infoCache || {})['hw:' + place.toLowerCase()] || {}).value;
  if (w && w.now) {
    const nowISO = localNowISO();
    const wet = (w.hours || []).filter((h) => h.t >= nowISO.slice(0, 13)).slice(0, 12).find((h) => h.rain >= 50);
    const d0 = (w.days || [])[0];
    lines.push({ icon: WX(w.now.code), text: `${Math.round(w.now.temp)}° now${d0 ? `, high ${Math.round(d0.max)}°` : ''} — ${wet ? `rain likely ${wet.t.slice(11, 13) === nowISO.slice(11, 13) ? 'now' : 'from ' + wet.t.slice(11, 16)}, take a coat` : 'staying dry'}` });
    const terms = [w.county, w.region].filter(Boolean);
    const warn = (((settings().infoCache || {})['warn:' + terms.join('|').toLowerCase()] || {}).value || {}).warnings || [];
    for (const x of warn.slice(0, 1)) lines.push({ icon: '⚠️', text: x.title, level: x.level === 'yellow' ? 'soon' : 'urgent' });
  }
  // Calendar: today (or tomorrow, in the evening)
  const dayISO = evening ? isoPlus(today, 1) : today;
  const evs = upcomingEvents(evening ? 1 : 0).filter((e) => e.date === dayISO && !(e.time && dayISO === today && e.time < now.toTimeString().slice(0, 5)));
  if (evs.length) {
    const first = evs[0];
    lines.push({ icon: '📅', text: `${evening ? 'Tomorrow' : 'Today'}: ${evs.length === 1 ? '' : evs.length + ' things — '}${/^\d/.test(first.time || '') ? first.time + ' ' : ''}${first.title}${evs.length > 1 ? ' first' : ''}`, go: () => goLife('calendar') });
  }
  // Parcels due
  const parcels = sharedItems('delivery').filter((d) => !d.done && d.expected && d.expected <= (evening ? isoPlus(today, 1) : today) && d.expected >= isoPlus(today, -1));
  if (parcels.length) lines.push({ icon: '📦', text: parcels.length === 1 ? `Parcel ${parcels[0].expected === today ? 'arriving today' : parcels[0].expected > today ? 'arriving tomorrow' : 'was due yesterday'}: ${parcels[0].item}` : `${parcels.length} parcels due`, go: () => goLife('deliveries') });
  // Trip soon / away
  const t = upcomingTrip();
  if (t && daysBetween(today, t.start) <= 3) lines.push({ icon: tripFlag(t), text: `${t.title}: ${tripStatus(t, today)}`, go: () => openTrip(t.id) });
  // Trains
  const tb = settings().trainBad;
  if (tb && tb.n && Date.now() - tb.at < 30 * 60000) lines.push({ icon: '🚆', text: `${tb.n} train${tb.n === 1 ? '' : 's'} delayed or cancelled on your route`, level: 'soon', go: () => goLife('trains') });
  // Overdue / urgent, then due this week
  const urgent = items.filter((i) => i.level === 'urgent' && i.sub !== 'Delivery');
  for (const i of urgent.slice(0, 2)) lines.push({ icon: '❗', text: `${i.label}${i.days < 0 ? ' — overdue' : i.text && !/^\d/.test(i.text) ? ` — ${i.text.replace(i.label + ' ', '')}` : ''}`, level: 'urgent', go: i.go });
  const week = items.filter((i) => i.level !== 'urgent' && i.days >= 0 && i.days <= 7 && i.sub !== 'Delivery');
  if (week.length) lines.push({ icon: '🗓️', text: `Due this week: ${week.slice(0, 3).map((i) => i.label).join(', ')}${week.length > 3 ? ` +${week.length - 3}` : ''}`, level: 'soon' });
  // Lists
  const shop = sharedItems('shop').filter((i) => !i.done).length, tasks = sharedItems('task').filter((i) => !i.done).length;
  if (shop || tasks) lines.push({ icon: '🛒', text: [shop ? `${shop} on the shopping list` : '', tasks ? `${tasks} to-do${tasks === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · '), go: () => goLife(shop ? 'shopping' : 'tasks') });

  const name = myName() !== 'Me' ? `, ${myName()}` : '';
  const level = lines.some((l) => l.level === 'urgent') ? 'urgent' : lines.some((l) => l.level === 'soon') ? 'soon' : 'ok';
  const card = el('div', { class: 'verdict briefing ' + level },
    el('div', { class: 'headline', text: `${greeting()}${name}` }),
    el('div', { class: 'muted small', text: now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) }));
  if (!lines.length) card.append(el('p', { text: 'Nothing pressing today — you’re on top of things.' }));
  else {
    const ul = el('ul', { class: 'brief-list' });
    for (const l of lines.slice(0, 7)) {
      const li = el('li', { class: l.level || '' }, el('span', { class: 'brief-ico', text: l.icon }), el('span', { text: l.text }));
      if (l.go) { li.classList.add('tappable'); li.addEventListener('click', l.go); }
      ul.append(li);
    }
    card.append(ul);
  }
  return card;
}

function renderDashboard() {
  const out = $('dashboard');
  if (!out) return;
  const v = loadVehicle();
  const items = upcomingReminders({
    renewalDates: { mot: v.mot, tax: v.tax, insurance: v.insurance, service: v.service },
    documents: store.load(DOCS_KEY, []),
  });
  for (const d of sharedItems('delivery')) {
    if (d.done || !d.expected) continue;
    const s = parcelStatus(d.expected);
    if (s.days == null) continue;
    items.push({ label: d.item || 'Parcel', sub: 'Delivery', days: s.days, level: s.level === 'dim' ? 'ok' : s.level, text: s.text });
  }
  items.push(...collectExtraReminders());
  items.sort((a, b) => a.days - b.days);
  out.replaceChildren(briefingCard(items));
  renderToday(out);
  const wx = weatherCard();
  if (wx) out.append(wx);

  if (isAppEmpty()) out.append(welcomeCard());


  if (items.length) {
    const list = el('ul', { class: 'list' });
    for (const i of items.slice(0, 8)) {
      const li = el('li', {}, el('div', { class: 'line' },
        el('div', {}, el('div', { class: 'name', text: i.label }), el('div', { class: 'sub', text: i.sub })),
        el('span', { class: 'tag ' + i.level, text: i.text.replace(i.label + ' ', '') })
      ));
      if (i.go) { li.classList.add('tappable'); li.addEventListener('click', i.go); }
      list.append(li);
    }
    out.append(el('div', { class: 'card' }, el('h2', { text: 'Coming up' }), list));
  }

  // "Time to compare" nudge for utilities renewing within ~30 days.
  const dueUtils = utilities().filter((u) => {
    if (!u.renewal) return false;
    const cd = countdown(u.renewal, u.type);
    return cd && cd.days >= 0 && cd.days <= 30;
  });
  if (dueUtils.length) {
    const card = el('div', { class: 'card change' }, el('h2', { text: 'Time to compare' }),
      el('p', { class: 'muted small', text: 'A renewal is coming up — switching now is when you save the most. Tap to compare, or ask Claude for a shortlist.' }));
    for (const u of dueUtils) {
      card.append(el('a', { class: 'btn-a', href: COMPARE[u.type] || ('https://www.google.com/search?q=' + encodeURIComponent('compare ' + u.type + ' deals')), target: '_blank', rel: 'noopener', text: `Compare ${u.type}${u.provider ? ' (' + u.provider + ')' : ''}` }));
    }
    out.append(card);
  }
}

function renderDocs() {
  const docs = store.load(DOCS_KEY, []);
  const out = $('docs-out');
  out.replaceChildren();
  if (!docs.length) {
    out.append(el('p', { class: 'muted small', text: 'No documents yet. Add one above to start getting reminders.' }));
    return;
  }
  const withDays = docs.map((d) => ({ d, cd: d.expiry ? countdown(d.expiry, d.label) : null }));
  withDays.sort((a, b) => (a.cd ? a.cd.days : Infinity) - (b.cd ? b.cd.days : Infinity));
  for (const { d, cd } of withDays) {
    const head = el('div', { class: 'line' },
      el('div', {}, el('div', { class: 'name', text: d.label }), el('div', { class: 'sub', text: d.category + (d.note ? ' · ' + d.note : '') })),
      cd ? el('span', { class: 'tag ' + cd.level, text: cd.text.replace(d.label + ' ', '') }) : el('span', { class: 'tag dim', text: 'No date' })
    );
    const card = el('div', { class: 'card doc' }, head);
    attachPhoto(card, d, d.label);
    card.append(privateFiles(DOCS_KEY, d.id, 'Keep a scan or PDF of the document with it.'));
    // Passports and licences belong with the person (Family), where trips check them.
    if (['Passport', 'Driving licence'].includes(d.category) && d.expiry && children().length) {
      const field = d.category === 'Passport' ? 'passportExpiry' : 'licenceExpiry';
      const pick = el('select', {}, el('option', { value: '', text: `Add this ${d.category.toLowerCase()} to…` }), ...children().map((c) => el('option', { value: c.id, text: c.name })));
      pick.addEventListener('change', () => {
        const c = children().find((x) => x.id === pick.value);
        if (!c) return;
        sharedUpdate(c.id, { [field]: d.expiry }); scheduleSync(); renderFamily(); renderDashboard();
        toast(`${c.name}'s ${d.category.toLowerCase()} expiry saved in Family ✓`);
        pick.value = '';
      });
      card.append(el('div', { class: 'doc-to-family' }, el('span', { class: 'muted small', text: 'Trips check passports in Family. ' }), pick));
    }
    const del = el('button', { class: 'link del-wide', text: 'Delete' });
    del.addEventListener('click', () => deleteItem(DOCS_KEY, d.id, renderDocs, { photoId: d.photoId, label: d.label }));
    card.append(del);
    out.append(card);
  }
  renderDashboard();
}

// Show an item's photo: legacy inline (pre-migration) or encrypted from IndexedDB.
function attachPhoto(card, item, alt) {
  if (item.photo) {
    const img = el('img', { class: 'doc-photo', src: item.photo, alt });
    img.addEventListener('click', () => window.open(item.photo, '_blank'));
    card.append(img);
  } else if (item.photoId && mediaKey) {
    const img = el('img', { class: 'doc-photo', alt });
    card.append(img);
    loadPhoto(item.photoId, mediaKey).then((url) => {
      if (url) { img.src = url; img.addEventListener('click', () => window.open(url, '_blank')); } else img.remove();
    });
  }
}

$('btn-doc-add').addEventListener('click', async () => {
  const label = $('doc-label').value.trim();
  if (!label) {
    alert('Please give the document a name.');
    return;
  }
  const btn = $('btn-doc-add');
  btn.disabled = true;
  try {
    const entry = { id: Date.now(), label, category: $('doc-category').value, expiry: $('doc-expiry').value, note: $('doc-note').value.trim() };
    const file = $('doc-photo').files[0];
    if (file && mediaKey) {
      entry.photoId = 'p' + Date.now() + Math.random().toString(36).slice(2, 6);
      await savePhoto(entry.photoId, await compressImage(file), mediaKey);
    }
    store.save(DOCS_KEY, [entry, ...store.load(DOCS_KEY, [])]);
    for (const id of ['doc-label', 'doc-note', 'doc-expiry', 'doc-photo']) $(id).value = '';
    $('doc-form').open = false;
    renderDocs();
    toast('Document added ✓');
  } catch (e) {
    alert(e.message || 'Could not add the document.');
  } finally {
    btn.disabled = false;
  }
});

// ---------- life sections: utilities, subscriptions, tax, home, health, sharing ----------
const UTIL_KEY = 'tiguan-utilities';
// Utility plans live in the shared space so both phones see the suppliers (and the meter readings under them).
// (The plan's service — Energy, Water… — is stored as `service`, since `type` marks the kind of shared item.)
const utilities = () => sharedItems('utility').map((u) => ({ ...u, type: u.service === 'TV / streaming' ? 'TV' : u.service || 'Other' }));
const SUBS_KEY = 'tiguan-subscriptions';
const INV_KEY = 'tiguan-inventory';
const METER_KEY = 'tiguan-meters';
const MAINT_KEY = 'tiguan-maintenance';
const CHECK_KEY = 'tiguan-checkups';
const MONEY_KEY = 'tiguan-money';
const EMG_KEY = 'tiguan-emergency';
const SETTINGS_KEY = 'tiguan-settings';

const partnerEmail = () => (store.load(SETTINGS_KEY, {}).partnerEmail || '').trim();
// Pence matter when splitting bills (£42.25, not £42); whole pounds stay tidy (£120).
const money = (n) => { const v = Math.round((Number(n) || 0) * 100) / 100; return (v < 0 ? '-£' : '£') + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 }); };
const COMPARE = { Energy: 'https://www.moneysavingexpert.com/utilities/', Broadband: 'https://www.moneysavingexpert.com/broadband/', Mobile: 'https://www.moneysavingexpert.com/mobiles/', Insurance: 'https://www.moneysavingexpert.com/insurance/' };

// Utilities
function renderUtilities() {
  const items = utilities();
  const list = $('util-list');
  list.replaceChildren();
  for (const u of [...items].sort((a, b) => (a.renewal || '9') < (b.renewal || '9') ? -1 : 1)) {
    const cd = u.renewal ? countdown(u.renewal, u.type) : null;
    const ct = u.type === 'Council tax' ? councilTax(u.annual, u.instalments) : null;
    const sub = ct ? [u.provider, `${money(u.annual)} a year`, `${ct.instalments} × ${money(ct.instalment)}`].filter(Boolean).join(' · ')
      : [u.provider, u.cost ? money(u.cost) + '/mo' : null, u.speed ? `${u.speed} Mbps` : null, u.handset ? HANDSET_LABEL[u.handset] : null].filter(Boolean).join(' · ');
    const title = `${BILL_ICON[u.type] || '🧾'} ${u.type === 'TV' ? 'TV & streaming' : u.type}${u.type === 'Mobile' && u.who ? ' — ' + u.who : ''}${u.type === 'Council tax' && u.band ? ` (band ${u.band})` : ''}`;
    const passed = cd && cd.days < 0 && CAN_SWITCH.has(u.type);
    const row = el('div', { class: 'card doc' }, el('div', { class: 'line' },
      el('div', {}, el('div', { class: 'name', text: title }), el('div', { class: 'sub', text: sub })),
      cd && CAN_SWITCH.has(u.type) ? el('span', { class: 'tag ' + (passed ? 'soon' : cd.level), text: passed ? 'out of contract' : cd.days <= 60 ? `ends in ${cd.days} days` : `ends ${fmtDate(u.renewal)}` } ) : null));
    const nudge = contractNudge(u, todayISO());
    if (nudge) row.append(el('div', { class: 'state-note small ' + nudge.level, style: 'margin-top:8px', text: nudge.text }));
    if (u.priceRise && ['Broadband', 'Mobile', 'TV'].includes(u.type)) row.append(el('div', { class: 'sub', style: 'margin-top:6px', text: `Goes up ${money(u.priceRise)} a month each April (it’s in the contract).` }));
    if (u.tariff || u.usage) {
      row.append(el('div', { class: 'sub', style: 'margin-top:6px', text: [u.tariff, u.usage].filter(Boolean).join(' · ') }));
    }
    const meters = METERS.filter((m) => planForMeter(m.kind, items) === u);
    if (meters.length) row.append(el('div', { class: 'util-meters' }, ...meters.map((m) => meterPanel(m, u))));
    const actions = el('div', { class: 'row', style: 'margin-top:10px' });
    if (['Energy', 'Electricity', 'Gas'].includes(u.type)) {
      const cmp = el('button', { class: 'primary', text: u.energy && (u.energy.elecUnit || u.energy.gasUnit) ? 'Compare deals' : 'Compare deals (add your rates)' });
      cmp.addEventListener('click', () => openEnergyCompare(u.id));
      actions.append(cmp);
    }
    const editBtn = el('button', { text: 'Edit' });
    editBtn.addEventListener('click', () => openSupplierEditor(u));
    actions.append(editBtn);
    const rec = el('button', { text: 'Ask Claude' });
    if (!CAN_SWITCH.has(u.type)) rec.hidden = true; // water and council tax can't be switched
    rec.addEventListener('click', async () => {
      const text = utilityBrief(u);
      try {
        if (navigator.share) await navigator.share({ title: `Compare my ${u.type} deal`, text });
        else { await navigator.clipboard.writeText(text); rec.textContent = 'Copied — paste it to Claude'; setTimeout(() => (rec.textContent = 'Ask Claude'), 2500); }
      } catch { /* share closed */ }
    });
    actions.append(rec);
    const saveRec = el('button', { text: u.recommendation ? 'Update options' : 'Save options' });
    if (!CAN_SWITCH.has(u.type)) saveRec.hidden = true;
    saveRec.addEventListener('click', () => openRecModal(u.id));
    actions.append(saveRec);
    for (const [label, href] of COMPARE_LINKS[u.type] || []) actions.append(el('a', { class: 'btn-a', href, target: '_blank', rel: 'noopener', text: label }));
    if (u.renewal) actions.append(el('a', { class: 'btn-a', href: calendarEvent(`${u.type} renewal${u.provider ? ' – ' + u.provider : ''}`, u.renewal, { guests: partnerEmail() }), target: '_blank', rel: 'noopener', text: 'Remind me' }));
    const del = el('button', { class: 'del', text: '✕' });
    del.addEventListener('click', () => {
      sharedRemove(u.id); scheduleSync(); renderUtilities(); renderDashboard();
      let undone = false;
      setTimeout(() => { if (!undone) dropFiles(u.files || []); }, 8500);
      toast(`Deleted ${u.type}`, { actionLabel: 'Undo', onAction: () => { undone = true; sharedSet({ ...u, type: 'utility', updatedAt: now(), deleted: false }); scheduleSync(); renderUtilities(); renderDashboard(); } });
    });
    actions.append(del);
    row.append(actions, lazyFiles({ shared: true, hint: 'Your contract, latest bill or a meter photo.', get: () => sharedItems('utility').find((x) => x.id === u.id)?.files || [], save: (list) => { sharedUpdate(u.id, { files: list }); scheduleSync(); } }));
    if (u.recommendation) {
      const r = u.recommendation;
      const saving = u.cost && r.bestMonthly && u.cost - r.bestMonthly > 0 ? u.cost - r.bestMonthly : null;
      const box = el('div', { class: 'state-note', style: 'margin-top:10px' });
      if (saving) box.append(el('div', {}, el('span', { class: 'tag ok', text: `Could save ~${money(saving)}/mo` }), el('span', { text: `  (~${money(saving * 12)}/yr)` })));
      box.append(el('details', { class: 'inner' }, el('summary', { text: `Saved options — ${fmtDate(r.savedAt.slice(0, 10))}` }), el('pre', { class: 'rec-text', text: r.text })));
      row.append(box);
    }
    list.append(row);
  }
  if (!items.length) list.append(el('li', { class: 'muted small', text: 'No plans added.' }));
  renderLooseMeters(items);
  renderMoneyOverview();
}
// Estimate the cheapest monthly figure mentioned in a recommendation.
function parseBestMonthly(text) {
  const matches = [...(text || '').matchAll(/£\s?(\d+(?:\.\d+)?)\s*(?:\/|per)?\s*(?:mo|month|pm|p\/m|p\.m)/gi)];
  const values = matches.map((m) => parseFloat(m[1])).filter((n) => n > 0);
  return values.length ? Math.min(...values) : null;
}
let recUtilId = null;
function openRecModal(id) {
  recUtilId = id;
  const u = utilities().find((x) => x.id === id);
  $('rec-text').value = u && u.recommendation ? u.recommendation.text : '';
  $('rec-modal').hidden = false;
  syncNav();
  $('rec-text').focus();
}
$('rec-cancel').addEventListener('click', () => { $('rec-modal').hidden = true; recUtilId = null; syncNav(); });
$('rec-save').addEventListener('click', () => {
  const text = $('rec-text').value.trim();
  if (recUtilId) {
    sharedUpdate(recUtilId, { recommendation: text ? { text, savedAt: new Date().toISOString(), bestMonthly: parseBestMonthly(text) } : null });
    scheduleSync();
  }
  $('rec-modal').hidden = true;
  recUtilId = null;
  syncNav();
  renderUtilities();
  renderDashboard();
});

function utilityBrief(u) {
  return [
    `I'd like to compare my ${u.type.toLowerCase()} deal and find something cheaper (UK).`,
    `Current provider: ${u.provider || '(not set)'}`,
    u.tariff ? `Tariff: ${u.tariff}` : null,
    u.cost ? `Paying: £${u.cost}/month (about £${Math.round(u.cost * 12)}/year)` : null,
    u.usage ? `My usage / package: ${u.usage}` : null,
    u.speed ? `Speed: about ${u.speed} Mbps` : null,
    u.type === 'Mobile' && u.handset ? `Phone: ${HANDSET_LABEL[u.handset]}` : null,
    u.priceRise ? `Annual price rise: £${u.priceRise}/month each April` : null,
    u.renewal ? `Contract ends / renews: ${fmtDate(u.renewal)}` : null,
    'Please find current deals that beat this and recommend the best value, flagging any exit fees or switching catches.',
  ].filter(Boolean).join('\n');
}


// Subscriptions
function renderSubs() {
  const subs = store.load(SUBS_KEY, []);
  const t = subscriptionsTotal(subs);
  $('subs-total').replaceChildren(
    el('div', { class: 'tile' }, el('div', { class: 'label', text: 'Per month' }), el('div', { class: 'value' }, el('span', { text: money(t.monthly) }))),
    el('div', { class: 'tile' }, el('div', { class: 'label', text: 'Per year' }), el('div', { class: 'value' }, el('span', { text: money(t.yearly) })))
  );
  const list = $('subs-list');
  list.replaceChildren();
  for (const s of subs) {
    list.append(deletableRow(s.name, `${money(s.cost)} ${s.cycle}${s.renewal ? ' · renews ' + fmtDate(s.renewal) : ''}`, () => {
      deleteItem(SUBS_KEY, s.id, () => { renderSubs(); renderDashboard(); }, { label: s.name });
    }));
  }
  renderMoneyOverview();
}
$('btn-subs-add').addEventListener('click', () => {
  const name = $('subs-name').value.trim();
  if (!name) return alert('Please name the subscription.');
  const entry = { id: Date.now(), name, cost: parseFloat($('subs-cost').value) || 0, cycle: $('subs-cycle').value, renewal: $('subs-renewal').value };
  store.save(SUBS_KEY, [entry, ...store.load(SUBS_KEY, [])]);
  for (const id of ['subs-name', 'subs-cost', 'subs-renewal']) $(id).value = '';
  renderSubs(); renderDashboard(); toast('Subscription added ✓');
});

// Money overview — all recurring outgoings in one place
const CAT_COLOR = { Subscriptions: 'var(--accent)', Utilities: 'var(--soon)' };
function renderMoneyOverview() {
  const out = $('money-overview');
  if (!out) return;
  const m = moneyOverview(store.load(SUBS_KEY, []), utilities(), policies());
  out.replaceChildren(el('h2', { text: 'Your outgoings' }));
  if (!m.items.length) {
    out.append(el('p', { class: 'muted small', text: 'Add your subscriptions and utility plans and your monthly spend appears here.' }));
    return;
  }
  out.append(el('div', { class: 'grid' },
    el('div', { class: 'tile' }, el('div', { class: 'label', text: 'Every month' }), el('div', { class: 'value' }, el('span', { text: money(m.monthly) }))),
    el('div', { class: 'tile' }, el('div', { class: 'label', text: 'Every year' }), el('div', { class: 'value' }, el('span', { text: money(m.yearly) })))
  ));
  // category breakdown bars
  const bars = el('div', { style: 'margin-top:14px' });
  for (const c of m.categories) {
    const pct = Math.round((c.monthly / m.monthly) * 100);
    bars.append(el('div', { style: 'margin-bottom:8px' },
      el('div', { class: 'line', style: 'margin-bottom:4px' }, el('span', { class: 'sub', text: c.label }), el('span', { class: 'sub', text: `${money(c.monthly)}/mo · ${pct}%` })),
      el('div', { class: 'bar' }, el('div', { class: 'bar-fill', style: `width:${pct}%;background:${CAT_COLOR[c.label] || 'var(--accent)'}` }))
    ));
  }
  out.append(bars);
  if (m.savings > 0) {
    out.append(el('p', { class: 'state-note', style: 'margin-top:12px' },
      el('span', { class: 'tag ok', text: `Could save ~${money(m.savings)}/mo` }), el('span', { text: '  from the options saved against your utilities.' })));
  }
  // biggest items
  const list = el('ul', { class: 'list', style: 'margin-top:10px' });
  for (const i of m.items.slice(0, 6)) {
    list.append(el('li', {}, el('div', { class: 'line' }, el('div', {}, el('div', { class: 'name', text: i.name }), el('div', { class: 'sub', text: i.cat })), el('span', { class: 'name', text: money(i.monthly) + '/mo' }))));
  }
  out.append(el('details', { class: 'inner' }, el('summary', { text: 'Where it goes' }), list));
}

// Tax
function renderTaxDates() {
  const list = $('tax-dates');
  list.replaceChildren();
  for (const d of taxDeadlines()) {
    const cd = countdown(d.date, d.label);
    list.append(el('li', {}, el('div', { class: 'line' }, el('div', { class: 'name', text: d.label }), el('span', { class: 'tag ' + cd.level, text: cd.text.replace(d.label + ' ', '') }))));
  }
}
function calcTax() {
  const salary = parseFloat($('tax-salary').value) || 0;
  const out = $('tax-salary-out');
  if (salary > 0) {
    const t = takeHome(salary);
    out.replaceChildren(...[['Income tax', money(t.tax)], ['NI', money(t.ni)], ['Take-home', money(t.net)]].map(([l, v]) =>
      el('div', { class: 'tile' }, el('div', { class: 'label', text: l }), el('div', { class: 'value' }, el('span', { text: v })))));
  } else out.replaceChildren();
  const div = parseFloat($('tax-div').value) || 0;
  $('tax-div-out').textContent = div > 0 ? `Estimated dividend tax: ${money(dividendTax(salary, div))}` : '';
}
$('tax-salary').addEventListener('input', calcTax);
$('tax-div').addEventListener('input', calcTax);
function allowanceBar(id, used, cap) {
  const pct = Math.min(100, Math.round((used / cap) * 100));
  $(id).textContent = `${money(used)} used · ${money(Math.max(0, cap - used))} left of ${money(cap)} (${pct}%)`;
  $(id).className = 'status tag ' + (used >= cap ? 'soon' : 'ok');
}
function renderMoney() {
  const m = store.load(MONEY_KEY, {});
  $('isa-used').value = m.isa || '';
  $('pension-used').value = m.pension || '';
  allowanceBar('isa-bar', m.isa || 0, 20000);
  allowanceBar('pension-bar', m.pension || 0, 60000);
}
$('isa-used').addEventListener('input', (e) => { const m = store.load(MONEY_KEY, {}); m.isa = parseFloat(e.target.value) || 0; store.save(MONEY_KEY, m); allowanceBar('isa-bar', m.isa, 20000); });
$('pension-used').addEventListener('input', (e) => { const m = store.load(MONEY_KEY, {}); m.pension = parseFloat(e.target.value) || 0; store.save(MONEY_KEY, m); allowanceBar('pension-bar', m.pension, 60000); });

// Home: inventory
function renderInventory() {
  const items = store.load(INV_KEY, []);
  const total = items.reduce((s, x) => s + (x.value || 0), 0);
  $('inv-total').textContent = items.length ? `${items.length} item${items.length === 1 ? '' : 's'} · ${money(total)} total` : '';
  const list = $('inv-list');
  list.replaceChildren();
  for (const it of items) {
    const sub = [it.room, it.value ? money(it.value) : null, it.serial ? 'S/N ' + it.serial : null, it.bought ? 'bought ' + fmtDate(it.bought) : null].filter(Boolean).join(' · ');
    const wcd = it.warrantyUntil ? countdown(it.warrantyUntil, '') : null;
    const card = el('div', { class: 'card doc' }, el('div', { class: 'line' }, el('div', {}, el('div', { class: 'name', text: it.name }), el('div', { class: 'sub', text: sub })),
      wcd ? el('span', { class: 'tag ' + (wcd.days < 0 ? 'dim' : wcd.days <= 60 ? 'soon' : 'ok'), text: wcd.days < 0 ? 'warranty ended' : `warranty to ${fmtDate(it.warrantyUntil)}` }) : null));
    attachPhoto(card, it, it.name);
    card.append(privateFiles(INV_KEY, it.id, 'Receipts, warranty cards and manuals.'));
    const del = el('button', { class: 'link del-wide', text: 'Delete' });
    del.addEventListener('click', () => deleteItem(INV_KEY, it.id, renderInventory, { photoId: it.photoId, label: it.name }));
    card.append(del);
    list.append(card);
  }
}
$('btn-inv-add').addEventListener('click', async () => {
  const name = $('inv-name').value.trim();
  if (!name) return alert('Please name the item.');
  const btn = $('btn-inv-add'); btn.disabled = true;
  try {
    const entry = { id: Date.now(), name, room: $('inv-room').value.trim(), value: parseFloat($('inv-value').value) || 0, serial: $('inv-serial').value.trim(), bought: $('inv-bought').value, warrantyUntil: $('inv-warranty').value };
    const file = $('inv-photo').files[0];
    if (file && mediaKey) {
      entry.photoId = 'p' + Date.now() + Math.random().toString(36).slice(2, 6);
      await savePhoto(entry.photoId, await compressImage(file), mediaKey);
    }
    store.save(INV_KEY, [entry, ...store.load(INV_KEY, [])]);
    for (const id of ['inv-name', 'inv-room', 'inv-value', 'inv-serial', 'inv-photo', 'inv-bought', 'inv-warranty']) $(id).value = '';
    renderInventory();
  } finally { btn.disabled = false; }
});

// Utilities: meter readings (shared, one panel per meter)
const METERS = [
  { kind: 'Electricity', unit: 'kWh', icon: 'bolt' },
  { kind: 'Gas', unit: 'm³', icon: 'flame' },
  { kind: 'Water', unit: 'm³', icon: 'drop' },
];
const fmtNum = (n) => Number(n).toLocaleString('en-GB', { maximumFractionDigits: 2 });
function todayISO() { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
// Which supplier a meter belongs to: a dedicated Electricity / Gas plan, else a
// dual-fuel Energy plan; water readings go with the Water plan.
function planForMeter(kind, plans) {
  const type = (p) => (p.type || '').toLowerCase();
  if (kind === 'Water') return plans.find((p) => type(p) === 'water');
  return plans.find((p) => type(p) === kind.toLowerCase()) || plans.find((p) => type(p) === 'energy');
}
function meterPanel(m, plan) {
  const rows = sharedItems('meter').filter((r) => r.kind === m.kind).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.updatedAt - a.updatedAt));
  const last = rows[0];
  const usage = meterUsage(rows);
  const panel = el('div', { class: 'meter' },
    el('div', { class: 'meter-head' }, icon(m.icon),
      el('div', {}, el('div', { class: 'name', text: `${m.kind} meter` }),
        el('div', { class: 'sub', text: last ? `Last: ${fmtNum(last.reading)} ${m.unit} · ${fmtDate(last.date)}` : 'No readings yet' }))));
  if (usage) panel.append(el('div', { class: 'meter-stat', text: `About ${usage.perDay.toFixed(1)} ${m.unit} a day (${fmtNum(usage.used)} ${m.unit} over ${Math.round(usage.days)} days)` }));
  const input = el('input', { type: 'number', inputmode: 'decimal', placeholder: 'New reading', 'aria-label': `New ${m.kind.toLowerCase()} reading` });
  const date = el('input', { type: 'date', 'aria-label': `${m.kind} reading date` });
  date.value = todayISO();
  const add = el('button', { class: 'primary', text: 'Add' });
  add.addEventListener('click', () => {
    const reading = parseFloat(input.value);
    if (isNaN(reading)) { input.focus(); return toast('Type the number shown on the meter.'); }
    const d = date.value || todayISO();
    if (last && reading < last.reading && d >= last.date && !confirm(`That's lower than your last ${m.kind.toLowerCase()} reading (${fmtNum(last.reading)}). Save it anyway?`)) return;
    // Keep the supplier with the reading, so switching supplier leaves a clear record.
    sharedAdd('meter', { kind: m.kind, reading, date: d, provider: plan?.provider || '' });
    renderUtilities();
    scheduleSync();
    haptic();
    toast(`${m.kind} reading saved ✓`);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add.click(); });
  panel.append(el('div', { class: 'row meter-add' }, input, add), el('label', { class: 'meter-date' }, 'Reading taken on', date));
  if (rows.length) {
    const ul = el('ul', { class: 'list' });
    for (const r of rows) {
      const detail = fmtDate(r.date) + (r.provider && r.provider !== plan?.provider ? ` · ${r.provider}` : '');
      ul.append(deletableRow(`${fmtNum(r.reading)} ${m.unit}`, detail, () => { sharedRemove(r.id); renderUtilities(); scheduleSync(); }));
    }
    panel.append(el('details', { class: 'inner' }, el('summary', { text: `History (${rows.length})` }), ul));
  }
  return panel;
}
// Meters with no matching supplier yet get their own card below the plans.
function renderLooseMeters(plans) {
  const loose = METERS.filter((m) => !planForMeter(m.kind, plans));
  $('meters-card').hidden = !loose.length;
  if (!loose.length) return;
  const names = loose.map((m) => m.kind.toLowerCase());
  $('meters-hint').textContent = loose.length === METERS.length
    ? 'Add your energy and water suppliers above and each meter will sit with its supplier. You can still log readings here meanwhile.'
    : `No ${names.join(' or ')} supplier added yet — add one above and ${loose.length === 1 ? 'this meter moves' : 'these meters move'} under it.`;
  $('meters').replaceChildren(...loose.map((m) => meterPanel(m, null)));
}
function renderMeters() { renderUtilities(); }

// One-time move of deliveries, calendar events and meter readings into the
// shared space, so they sync with your partner. Safe to run every start.
function migrateToShared() {
  const del = store.load(DELIVERIES_KEY, []), ev = store.load(EVENTS_KEY, []), met = store.load(METER_KEY, []), utl = store.load(UTIL_KEY, []);
  if (!del.length && !ev.length && !met.length && !utl.length) return;
  for (const u of utl) { const { id, type, ...rest } = u; sharedAdd('utility', { ...rest, service: type }); }
  for (const d of del) if (!d.done) { const { id, ...rest } = d; sharedAdd('delivery', rest); }
  for (const e of ev) { const { id, ...rest } = e; sharedAdd('event', rest); }
  for (const r of met) sharedAdd('meter', { kind: r.type, reading: r.reading, date: r.date });
  store.save(DELIVERIES_KEY, []); store.save(EVENTS_KEY, []); store.save(METER_KEY, []); store.save(UTIL_KEY, []);
}

// Home: maintenance
function renderMaint() {
  const items = store.load(MAINT_KEY, []);
  const list = $('maint-list');
  list.replaceChildren();
  for (const m of [...items].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    const cd = m.date ? countdown(m.date, m.task) : null;
    const row = el('li', {}, el('div', { class: 'line' },
      el('div', {}, el('div', { class: 'name', text: m.task }), m.date ? el('div', { class: 'sub', text: fmtDate(m.date) }) : null),
      cd ? el('span', { class: 'tag ' + cd.level, text: cd.text.replace(m.task + ' ', '') }) : null));
    const del = el('button', { class: 'del', text: '✕' });
    del.addEventListener('click', () => deleteItem(MAINT_KEY, m.id, () => { renderMaint(); renderDashboard(); }, { label: m.task }));
    row.querySelector('.line').append(del);
    row.append(privateFiles(MAINT_KEY, m.id, 'Quotes, invoices and guarantees.'));
    list.append(row);
  }
}
$('btn-maint-add').addEventListener('click', () => {
  const task = $('maint-task').value.trim();
  if (!task) return alert('Please name the task.');
  store.save(MAINT_KEY, [{ id: Date.now(), task, date: $('maint-date').value }, ...store.load(MAINT_KEY, [])]);
  $('maint-task').value = ''; $('maint-date').value = '';
  renderMaint(); renderDashboard();
});

// Health: check-ups
const familyNames = () => [...new Set([myName() !== 'Me' ? myName() : '', partnerName() !== 'Partner' ? partnerName() : '', ...children().map((c) => c.name)].filter(Boolean))];
function renderCheckups() {
  const items = store.load(CHECK_KEY, []);
  const list = $('check-list');
  const who = $('check-who');
  if (who) { const cur = who.value; who.replaceChildren(el('option', { value: '', text: 'Choose…' }), ...familyNames().map((n) => el('option', { value: n, text: n }))); who.value = cur; }
  list.replaceChildren();
  for (const c of items) {
    const due = nextDue(c.last, c.interval);
    const cd = due ? countdown(due, c.type) : null;
    const row = el('li', {}, el('div', { class: 'line' },
      el('div', {}, el('div', { class: 'name', text: c.type + (c.who ? ' — ' + c.who : '') }), el('div', { class: 'sub', text: [c.last ? 'last ' + fmtDate(c.last) : '', due ? 'next due ' + fmtDate(due) : ''].filter(Boolean).join(' · ') })),
      cd ? el('span', { class: 'tag ' + cd.level, text: cd.text.replace(c.type + ' ', '') }) : null));
    const del = el('button', { class: 'del', text: '✕' });
    del.addEventListener('click', () => deleteItem(CHECK_KEY, c.id, () => { renderCheckups(); renderDashboard(); }, { label: c.type }));
    row.querySelector('.line').append(del);
    row.append(privateFiles(CHECK_KEY, c.id, 'Letters, results and prescriptions.'));
    list.append(row);
  }
}
$('btn-check-add').addEventListener('click', () => {
  const type = $('check-type').value.trim();
  if (!type) return alert('Please name the check-up.');
  store.save(CHECK_KEY, [{ id: Date.now(), type, who: $('check-who').value, last: $('check-last').value, interval: parseInt($('check-interval').value) || 0 }, ...store.load(CHECK_KEY, [])]);
  for (const id of ['check-type', 'check-last', 'check-interval']) $(id).value = '';
  renderCheckups(); renderFamily(); renderDashboard();
});

// Emergency card + partner email (bound inputs)
const EMG_FIELDS = { 'emg-blood': 'blood', 'emg-nhs': 'nhs', 'emg-allergies': 'allergies', 'emg-meds': 'meds', 'emg-contact': 'contact' };
let emergencyBound = false;
const emergencyDraft = {};
function initEmergency() {
  const e = store.load(EMG_KEY, {});
  Object.assign(emergencyDraft, e);
  for (const [id, key] of Object.entries(EMG_FIELDS)) $(id).value = e[key] || '';
  $('partner-email').value = store.load(SETTINGS_KEY, {}).partnerEmail || '';
  if (emergencyBound) return; // attach listeners once, not on every unlock
  emergencyBound = true;
  const persistEmg = debounce(() => store.save(EMG_KEY, { ...emergencyDraft }), 600);
  for (const [id, key] of Object.entries(EMG_FIELDS)) {
    $(id).addEventListener('input', (ev) => { emergencyDraft[key] = ev.target.value; persistEmg(); });
  }
  const persistPartner = debounce((v) => { const s = store.load(SETTINGS_KEY, {}); s.partnerEmail = v; store.save(SETTINGS_KEY, s); }, 600);
  $('partner-email').addEventListener('input', (ev) => persistPartner(ev.target.value.trim()));
}

// Extra dashboard reminders from the new sections
// Subscriptions renew automatically, so a renewal date in the past means "the next one".
function nextRenewal(sub) {
  if (!sub.renewal) return '';
  let d = sub.renewal;
  const today = todayISO();
  for (let i = 0; d < today && i < 600; i++) {
    const [y, m, day] = d.split('-').map(Number);
    if (sub.cycle === 'weekly') d = isoPlus(d, 7);
    else {
      const add = sub.cycle === 'yearly' ? 12 : 1;
      const total = y * 12 + (m - 1) + add;
      const ny = Math.floor(total / 12), nm = (total % 12) + 1;
      const dim = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
      d = `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(day, dim)).padStart(2, '0')}`;
    }
  }
  return d;
}
function collectExtraReminders() {
  const items = [];
  const add = (date, label, sub) => { const cd = date ? countdown(date, label) : null; if (cd) items.push({ label, sub, days: cd.days, level: cd.level, text: cd.text }); };
  const todayR = todayISO();
  for (const u of utilities()) {
    const name = `${u.type === 'TV' ? 'TV' : u.type}${u.type === 'Mobile' && u.who ? ' — ' + u.who : ''}${u.provider ? ' (' + u.provider + ')' : ''}`;
    if (u.renewal && u.renewal < todayR && CAN_SWITCH.has(u.type)) {
      const n = contractNudge(u, todayR);
      if (n && n.level === 'urgent') items.push({ label: name, sub: 'Bills · ' + n.text, days: 0, level: 'urgent', text: u.type === 'Mobile' ? 'switch to SIM-only' : 'switch', go: () => goLife('utilities') });
      continue; // out of contract: shown on the bill itself, not as an overdue date
    }
    add(u.renewal, name, 'Bills');
  }
  for (const p of policies()) {
    if (p.kind === 'car' || !p.renewal) continue; // the car's insurance shows with the car's dates
    add(p.renewal, `${policyLabel(p.kind)} insurance${p.insurer ? ' (' + p.insurer + ')' : ''}`, 'Insurance');
  }
  for (const s of store.load(SUBS_KEY, [])) add(nextRenewal(s), s.name, 'Subscription');
  for (const m of store.load(MAINT_KEY, [])) add(m.date, m.task, 'Home');
  for (const c of store.load(CHECK_KEY, [])) add(nextDue(c.last, c.interval), c.type + (c.who ? ' — ' + c.who : ''), 'Check-ups');
  for (const it of store.load(INV_KEY, [])) if (it.warrantyUntil) { const cd = countdown(it.warrantyUntil, ''); if (cd && cd.days >= 0 && cd.days <= 30) add(it.warrantyUntil, `Warranty ends — ${it.name}`, 'Contents'); }
  for (const d of taxDeadlines()) add(d.date, d.label, 'Tax');
  for (const c of sharedItems('child')) if (c.passportExpiry) add(c.passportExpiry, `${c.name}'s passport`, 'Family');
  for (const c of sharedItems('child')) if (c.ghicExpiry) add(c.ghicExpiry, `${c.name}'s GHIC`, 'Family');
  for (const d of companyDeadlines()) add(d.date, d.label, d.sub);
  items.push(...adviceReminders());
  // Travel: the trip itself, plus anything to sort before you go.
  const today = todayISO();
  for (const t of trips()) {
    if (!t.start || t.end < today) continue;
    const until = daysBetween(today, t.start);
    if (until >= 0 && until <= 14) items.push({ label: `${tripFlag(t)} ${t.title || 'Trip'}`, sub: 'Travel', days: until, level: until <= 2 ? 'soon' : 'ok', text: until === 0 ? 'leaving today' : until === 1 ? 'leaving tomorrow' : `in ${until} days`, go: () => openTrip(t.id) });
    // One row per trip ("3 things to sort"), not one per check, so Home stays calm.
    const checks = tripChecks(t, children(), today, { hasInsurance: annualTravelCover(t) }).filter((c) => !(c.level === 'info' && until > 60));
    if (checks.length) {
      const heads = [...new Set(checks.map((c) => ({ passport: 'passport', auth: 'travel authorisation', ghic: 'GHIC', insurance: 'insurance', checkin: 'online check-in', advice: 'entry rules' }[c.kind] || 'check')))];
      items.push({ label: `${tripFlag(t)} ${t.title || 'Trip'}: ${checks.length === 1 ? '1 thing' : checks.length + ' things'} to sort`, sub: 'Travel · ' + heads.join(', '), days: Math.max(0, until), level: checks.some((c) => c.level === 'urgent') ? 'urgent' : 'soon', text: until > 0 ? `trip in ${until}d` : 'now', go: () => openTrip(t.id) });
    }
  }
  return items;
}

// Loyalty cards (with optional camera scan to capture the number)
const LOYAL_KEY = 'tiguan-loyalty';
function renderLoyalty() {
  const cards = store.load(LOYAL_KEY, []);
  const out = $('loyal-list');
  out.replaceChildren();
  for (const c of cards) {
    const card = el('div', { class: 'card' },
      el('div', { class: 'line' }, el('div', { class: 'name', text: c.name }), (() => { const d = el('button', { class: 'del', text: '✕' }); d.addEventListener('click', () => deleteItem(LOYAL_KEY, c.id, renderLoyalty, { label: c.name })); return d; })()),
      el('div', { class: 'loyal-number', text: c.number })
    );
    out.append(card);
  }
  if (!cards.length) out.append(el('p', { class: 'muted small', text: 'No cards saved.' }));
}
$('btn-loyal-add').addEventListener('click', () => {
  const name = $('loyal-name').value.trim();
  const number = $('loyal-number').value.trim();
  if (!name || !number) return alert('Add both a name and a number.');
  store.save(LOYAL_KEY, [{ id: Date.now(), name, number }, ...store.load(LOYAL_KEY, [])]);
  $('loyal-name').value = ''; $('loyal-number').value = '';
  renderLoyalty();
  toast('Card added ✓');
});

let scanStream = null;
function stopScan() {
  if (scanStream) scanStream.getTracks().forEach((t) => t.stop());
  scanStream = null;
  $('scan-modal').hidden = true;
  syncNav();
}
$('scan-cancel').addEventListener('click', stopScan);
$('btn-loyal-scan').addEventListener('click', async (e) => {
  e.preventDefault();
  if (!('BarcodeDetector' in window)) {
    alert('This phone/browser can\'t scan barcodes here. Type the number in instead.');
    return;
  }
  try {
    const detector = new window.BarcodeDetector();
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const video = $('scan-video');
    video.srcObject = scanStream;
    await video.play();
    $('scan-msg').textContent = 'Scanning…';
    $('scan-modal').hidden = false; syncNav();
    const tick = async () => {
      if (!scanStream) return;
      try {
        const codes = await detector.detect(video);
        if (codes.length) {
          $('loyal-number').value = codes[0].rawValue;
          stopScan();
          return;
        }
      } catch {
        /* keep trying */
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  } catch {
    stopScan();
    alert('Could not open the camera. Allow camera access, or type the number in.');
  }
});

// ---------- shared household (pairing + sync) ----------
const SHARED_KEY = 'tiguan-shared';
const now = () => Date.now();
const settings = () => store.load(SETTINGS_KEY, {});
const saveSettings = (patch) => store.save(SETTINGS_KEY, { ...settings(), ...patch });

function paired() {
  const s = settings();
  return Boolean(s.householdCode && s.syncUrl);
}
function refreshPairUI() {
  const s = settings();
  const isPaired = paired();
  $('pair-setup').hidden = isPaired;
  $('pair-active').hidden = !isPaired;
  if (isPaired) $('pair-code-show').textContent = s.householdCode;
  if (s.syncUrl) $('sync-url').value = s.syncUrl;
  renderLost();
  renderShared(); // the list works locally whether or not sharing is on
}
const persistSyncUrl = debounce((v) => saveSettings({ syncUrl: v }), 600);
$('sync-url').addEventListener('input', (e) => persistSyncUrl(e.target.value.trim()));
// Save the typed address immediately (don't wait for the input debounce).
function commitSyncUrl() { const v = $('sync-url').value.trim(); if (v) saveSettings({ syncUrl: v }); }
$('btn-pair-create').addEventListener('click', () => {
  commitSyncUrl();
  if (!settings().syncUrl) return setStatus('pair-status', 'Enter the sync server address first (see the sync-worker guide).', true);
  const code = generateHouseholdCode();
  saveSettings({ householdCode: code });
  $('pair-code').textContent = code;
  $('pair-code-box').hidden = false;
  setStatus('pair-status', 'Created. Share the code with your partner, then tap below once done.');
  refreshPairUI();
  updateLostCheck();
  syncNow();
});
$('btn-pair-join').addEventListener('click', () => {
  commitSyncUrl();
  if (!settings().syncUrl) return setStatus('pair-status', 'Enter the sync server address first.', true);
  const input = prompt('Enter the household code your partner shared:');
  if (!input) return;
  const code = normalizeCode(input);
  if (code.length < 12) return setStatus('pair-status', 'That code looks too short.', true);
  // Re-group for display (4x4).
  const grouped = code.match(/.{1,4}/g).join('-');
  saveSettings({ householdCode: grouped });
  refreshPairUI();
  setStatus('pair-status', '');
  updateLostCheck();
  syncNow();
});
$('btn-pair-leave').addEventListener('click', () => {
  if (!confirm('Leave the shared space on this phone? Your partner keeps theirs, and you can rejoin with the code.')) return;
  saveSettings({ householdCode: '' });
  store.save(SHARED_KEY, {});
  updateLostCheck();
  refreshPairUI();
});
$('btn-sync').addEventListener('click', () => syncNow());

// Automatic sync: when the app comes back to the screen, when the phone gets
// signal back, and every minute while it's open. Only ever while unlocked.
const AUTO_SYNC_MS = 60 * 1000;
function autoSync() {
  if (!vault.locked && !document.hidden && paired()) syncNow().then(() => { pullCalendar(); checkInbox(); });
}
document.addEventListener('visibilitychange', autoSync);
window.addEventListener('online', autoSync);
setInterval(autoSync, AUTO_SYNC_MS);

let syncTimer = null;
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 1200);
}
// Calls made while a sync is running share it (so callers can await it).
const TOMBSTONE_DAYS = 60;
let syncPromise = null;
// Things worth a "Jess added…" note (not calendar-feed events, meter readings or housekeeping).
const NOTIFY_TYPES = ['shop', 'task', 'bill', 'delivery', 'event', 'trip', 'child', 'utility', 'policy'];
const notable = (it) => it && !it.deleted && NOTIFY_TYPES.includes(it.type || 'shop') && !(it.type === 'event' && it.src);
let knownIds = null; // shared items this phone has already seen
function sharedLabel(it) {
  const t = it.type || 'shop';
  const name = it.text || it.title || it.name || it.item || it.service || '';
  return { shop: name, task: name, bill: name ? `bill: ${name}` : 'a bill', delivery: name ? `parcel: ${name}` : 'a parcel', event: name, trip: name ? `trip: ${name}` : 'a trip', child: name ? `${name} (Family)` : 'family details', utility: name ? `${name} (Bills)` : 'a bill', policy: `${policyLabel(it.kind)} insurance` }[t] || name;
}
const SECTION_FOR = { shop: 'shopping', task: 'tasks', bill: 'bills', delivery: 'deliveries', event: 'calendar', trip: 'travel', child: 'family', utility: 'utilities', policy: 'insurance' };
function syncNow() {
  if (!paired()) return Promise.resolve();
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    setStatus('sync-status', 'Syncing…');
    try {
      const s = settings();
      // Deleted-item markers older than 60 days have done their job; drop them so
      // the shared space doesn't fill up (the server drops them too).
      const cutoff = now() - TOMBSTONE_DAYS * 86400000;
      const local = store.load(SHARED_KEY, {});
      for (const [id, it] of Object.entries(local)) if (it.deleted && (it.updatedAt || 0) < cutoff) delete local[id];
      store.save(SHARED_KEY, local);
      const sent = Object.fromEntries(Object.entries(local).map(([id, it]) => [id, it.updatedAt]));
      if (!knownIds) knownIds = new Set(Object.keys(local));
      // Tell the server how many things this phone added (just a number) so it can let your partner know.
      const added = Object.entries(local).filter(([id, it]) => !knownIds.has(id) && notable(it)).length;
      const merged = await syncShared(s.syncUrl, s.householdCode, local, fetch, { device: deviceId(), added });
      // Keep only things changed on this phone while the request was in flight —
      // otherwise the server's answer wins (so it can't loop resending the same thing).
      let localNewer = false;
      for (const [id, it] of Object.entries(store.load(SHARED_KEY, {}))) {
        if (sent[id] === it.updatedAt) continue;
        const m = merged[id];
        if (!m || (it.updatedAt || 0) > (m.updatedAt || 0)) { merged[id] = it; localNewer = true; }
      }
      store.save(SHARED_KEY, merged);
      // Things your partner added since this phone last looked → a quick note.
      const fromPartner = Object.entries(merged).filter(([id, it]) => !(id in local) && !knownIds.has(id) && notable(it)).map(([, it]) => it);
      knownIds = new Set(Object.keys(merged));
      if (fromPartner.length && s.syncedOnce) {
        const names = fromPartner.map(sharedLabel).filter(Boolean);
        const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? ` and ${names.length - 3} more` : '');
        const where = SECTION_FOR[fromPartner[0].type || 'shop'];
        toast(`${partnerName()} added ${shown || fromPartner.length + ' things'}`, { actionLabel: 'View', onAction: () => goLife(where), ms: 7000 });
      }
      if (!s.syncedOnce) saveSettings({ syncedOnce: true });
      if (dedupeShared() || localNewer) scheduleSync();
      renderSharedAll();
      setStatus('sync-status', 'Synced ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
      updateLostCheck();
    } catch (e) {
      if (/410/.test(e.message)) {
        setStatus('sync-status', 'This shared space was closed (a phone was reported lost). Ask your partner for the new code and join again.', true);
        checkLostStatus(true);
      } else if (/413/.test(e.message)) {
        setStatus('sync-status', 'Your shared space is full — remove some shopping-list photos or old items, then sync again.', true);
      } else {
        setStatus('sync-status', 'Could not sync (offline, or check the server address).', true);
      }
      log('info', 'Sync failed: ' + e.message);
    }
  })().finally(() => { syncPromise = null; });
  return syncPromise;
}

// The same parcel or event can be added on both phones (e.g. both tap the
// morning link while offline). Keep the one with the lowest id — both phones
// pick the same one — and remove the rest.
const deliveryKey = (d) => (d.tracking || '').trim().toLowerCase(); // no tracking number = never treated as a duplicate
const eventKey = (e) => (e.date || '') + '|' + (e.time || '').trim() + '|' + (e.title || '').trim().toLowerCase();
function dedupeShared() {
  let removed = 0;
  for (const [type, keyFn] of [['delivery', deliveryKey], ['event', eventKey]]) {
    const seen = new Set();
    for (const it of sharedItems(type).filter((x) => !(type === 'event' && x.src)).sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const k = keyFn(it);
      if (!k) continue;
      if (seen.has(k)) { sharedRemove(it.id); removed++; } else seen.add(k);
    }
  }
  return removed;
}

// Shared space helpers (all shared types live in SHARED_KEY, tagged by `type`).
// Every change is stamped later than the version it replaces, even if this phone's
// clock is behind the other phone's (last-write-wins would otherwise drop it).
const stamp = (prev) => Math.max(now(), ((prev && prev.updatedAt) || 0) + 1);
function sharedSet(item) {
  const all = store.load(SHARED_KEY, {});
  const prev = all[item.id];
  all[item.id] = prev && (item.updatedAt || 0) <= (prev.updatedAt || 0) ? { ...item, updatedAt: stamp(prev) } : item;
  store.save(SHARED_KEY, all);
}
// A deleted item keeps only a tiny marker, plus (for parcels and events) a short
// fingerprint so the same thing can't be added back by tapping an old link.
function tombstone(prev) {
  const t = { id: prev.id, type: prev.type, deleted: true, updatedAt: stamp(prev) };
  const key = prev.type === 'delivery' ? deliveryKey(prev) : prev.type === 'event' ? eventKey(prev) : '';
  if (key) t.k = fnv(key);
  return t;
}
function sharedUpdate(id, patch) { const all = store.load(SHARED_KEY, {}); if (all[id]) { all[id] = { ...all[id], ...patch, updatedAt: stamp(all[id]) }; store.save(SHARED_KEY, all); } }
const sharedItems = (type) => Object.values(store.load(SHARED_KEY, {})).filter((i) => !i.deleted && (i.type || 'shop') === type);
function sharedAdd(type, data) { const id = type.charAt(0) + uid(); sharedSet({ ...data, id, type, updatedAt: now(), deleted: false }); return id; }
// Deleting keeps only a tiny marker, so the removal syncs without keeping the content around.
function sharedRemove(id) { const all = store.load(SHARED_KEY, {}); if (!all[id]) return; all[id] = tombstone(all[id]); store.save(SHARED_KEY, all); }
const myName = () => (settings().myName || '').trim() || 'Me';
const partnerName = () => (settings().partnerName || '').trim() || 'Partner';
function peopleOptions(sel, includeAnyone) {
  const keep = sel.value;
  sel.replaceChildren();
  if (includeAnyone) sel.add(new Option('Anyone', 'Anyone'));
  for (const n of [myName(), partnerName()]) sel.add(new Option(n, n));
  if (keep) sel.value = keep;
}
function renderSharedAll() { renderShared(); renderBills(); renderTasks(); renderDeliveries(); renderUtilities(); renderFamily(); renderTravel(); renderPolicies(); renderHouse(); renderCalendar(); renderHome(); renderLost(); }

// Shared bills with who-owes-whom
function renderBills() {
  const bills = sharedItems('bill');
  const bal = householdBalance(bills, myName());
  const box = $('bill-balance');
  if (!bills.length) { box.textContent = ''; box.className = 'status'; }
  else if (bal.net === 0) { box.textContent = 'All square 👍'; box.className = 'status tag ok'; }
  else if (bal.net > 0) { box.textContent = `${partnerName()} owes you ${money(bal.net)}`; box.className = 'status tag ok'; }
  else { box.textContent = `You owe ${partnerName()} ${money(-bal.net)}`; box.className = 'status tag soon'; }
  peopleOptions($('bill-paidby'), false);
  const list = $('bill-list');
  list.replaceChildren();
  for (const b of bills.sort((a, b) => (a.date < b.date ? 1 : -1))) {
    const sub = [`${b.paidBy} paid`, b.split ? 'split' : 'their own', b.date ? fmtDate(b.date) : null, b.settled ? 'settled' : null].filter(Boolean).join(' · ');
    const row = el('li', {}, el('div', { class: 'line' }, el('div', {}, el('div', { class: 'name', text: b.name || 'Bill' }), el('div', { class: 'sub', text: sub })), el('span', { class: 'name', text: money(b.amount) })));
    const actions = el('div', { class: 'row', style: 'margin-top:6px' });
    if (b.split && !b.settled) { const s = el('button', { text: 'Mark settled' }); s.addEventListener('click', () => { sharedUpdate(b.id, { settled: true }); renderBills(); scheduleSync(); }); actions.append(s); }
    const d = el('button', { class: 'del', text: '✕' });
    d.addEventListener('click', () => { sharedUpdate(b.id, { deleted: true }); renderBills(); scheduleSync(); toast('Deleted', { actionLabel: 'Undo', onAction: () => { sharedUpdate(b.id, { deleted: false }); renderBills(); scheduleSync(); } }); });
    actions.append(d);
    row.append(actions);
    list.append(row);
  }
  if (!bills.length) list.append(el('li', { class: 'muted small', text: 'No bills yet.' }));
}
$('btn-bill-add').addEventListener('click', () => {
  const name = $('bill-name').value.trim();
  const amount = parseFloat($('bill-amount').value) || 0;
  if (!name || !amount) return alert('Add a name and amount.');
  if (!(settings().myName || '').trim() || !(settings().partnerName || '').trim()) {
    $('my-name').focus();
    return toast('Add your name and your partner\'s name first, so both phones agree who paid.');
  }
  const id = 'b' + now() + Math.random().toString(36).slice(2, 6);
  sharedSet({ id, type: 'bill', name, amount, paidBy: $('bill-paidby').value, split: $('bill-split').checked, date: $('bill-date').value || todayISO(), settled: false, updatedAt: now(), deleted: false });
  for (const i of ['bill-name', 'bill-amount', 'bill-date']) $(i).value = '';
  renderBills(); scheduleSync(); toast('Bill added ✓');
});

// Shared tasks with an assignee
function renderTasks() {
  peopleOptions($('task-assignee'), true);
  const tasks = sharedItems('task').sort((a, b) => (a.done === b.done ? b.updatedAt - a.updatedAt : a.done ? 1 : -1));
  const list = $('task-list');
  list.replaceChildren();
  for (const t of tasks) {
    const box = el('input', { type: 'checkbox' });
    box.checked = !!t.done;
    box.addEventListener('change', () => { sharedUpdate(t.id, { done: box.checked }); renderTasks(); scheduleSync(); haptic(); });
    const label = el('span', { class: 'name', text: t.text });
    if (t.done) label.style.textDecoration = 'line-through';
    const who = t.assignee && t.assignee !== 'Anyone' ? el('span', { class: 'tag minor', text: t.assignee }) : null;
    const del = el('button', { class: 'del', text: '✕', 'aria-label': 'Delete ' + t.text });
    del.addEventListener('click', () => { sharedUpdate(t.id, { deleted: true }); renderTasks(); scheduleSync(); toast('Deleted', { actionLabel: 'Undo', onAction: () => { sharedUpdate(t.id, { deleted: false }); renderTasks(); scheduleSync(); } }); });
    list.append(el('li', { class: 'task-row' }, el('label', { class: 'check', style: 'margin:0;flex:1;min-width:0' }, box, label), who, del));
  }
  if (!tasks.length) list.append(el('li', { class: 'muted small', text: 'No tasks yet.' }));
}
$('btn-task-add').addEventListener('click', () => {
  const text = $('task-input').value.trim();
  if (!text) return;
  const id = 't' + now() + Math.random().toString(36).slice(2, 6);
  sharedSet({ id, type: 'task', text, assignee: $('task-assignee').value, done: false, updatedAt: now(), deleted: false });
  $('task-input').value = '';
  renderTasks(); scheduleSync(); toast('Task added ✓');
});
$('task-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-task-add').click(); });

// Who's who
function initNames() {
  const s = settings();
  $('my-name').value = s.myName || '';
  $('partner-name').value = s.partnerName || '';
}
const persistMyName = debounce((v) => { saveSettings({ myName: v }); renderBills(); renderTasks(); }, 500);
const persistPartnerName = debounce((v) => { saveSettings({ partnerName: v }); renderBills(); renderTasks(); }, 500);
$('my-name').addEventListener('input', (e) => persistMyName(e.target.value.trim()));
$('partner-name').addEventListener('input', (e) => persistPartnerName(e.target.value.trim()));
$('partner-name').addEventListener('change', () => setTimeout(refreshPushLabel, 1500));

function renderShared() {
  const items = store.load(SHARED_KEY, {});
  const list = $('shared-list');
  list.replaceChildren();
  const visible = Object.values(items).filter((i) => !i.deleted && (i.type || 'shop') === 'shop').sort((a, b) => a.updatedAt - b.updatedAt);
  for (const it of visible) {
    const box = el('input', { type: 'checkbox' });
    box.checked = !!it.done;
    box.addEventListener('change', () => { const all = store.load(SHARED_KEY, {}); all[it.id] = { ...all[it.id], done: box.checked, updatedAt: stamp(all[it.id]) }; store.save(SHARED_KEY, all); renderShared(); scheduleSync(); });
    const label = el('span', { class: 'name', text: it.text });
    if (it.done) label.style.textDecoration = 'line-through';
    const del = el('button', { class: 'del', text: '✕', 'aria-label': 'Remove ' + it.text });
    // Deleting drops the photo too, so removed items don't keep using shared space.
    del.addEventListener('click', () => { sharedRemove(it.id); renderShared(); scheduleSync(); });
    const row = el('li', { class: 'shop-row' }, el('label', { class: 'check', style: 'margin:0;flex:1;min-width:0' }, box, label));
    if (it.photo) {
      const thumb = el('img', { class: 'shop-thumb', src: it.photo, alt: 'Photo of ' + it.text });
      thumb.addEventListener('click', () => openPhotoViewer(it.photo, it.text, () => setShopPhoto(it.id, null)));
      row.append(thumb);
    }
    const cam = el('button', { class: 'shop-cam', text: '📷', 'aria-label': (it.photo ? 'Change photo for ' : 'Add a photo to ') + it.text });
    cam.addEventListener('click', () => pickShopPhoto(it.id));
    row.append(cam, del);
    list.append(row);
  }
  if (!visible.length) list.append(el('li', { class: 'muted small', text: 'Nothing on the list.' }));
  $('btn-shared-clear').hidden = !visible.some((i) => i.done);
}
// ----- photos on shopping items -----
// Small thumbnails, stored inside the (encrypted) shared item so they sync to
// your partner. Kept under a budget so the shared space stays well within the
// sync server's limit.
const SHARED_PHOTO_BUDGET = 900_000; // characters of local JSON; ~1.2 MB once encrypted, well under the server's 2 MB
function setShopPhoto(id, dataUrl) {
  const all = store.load(SHARED_KEY, {});
  if (!all[id]) return;
  const { photo, ...rest } = all[id];
  all[id] = dataUrl ? { ...rest, photo: dataUrl, updatedAt: stamp(all[id]) } : { ...rest, updatedAt: stamp(all[id]) };
  store.save(SHARED_KEY, all);
  renderShared();
  scheduleSync();
}
function pickShopPhoto(id) {
  // The picker must be part of the page: iPhones can silently drop a photo chosen
  // through a detached file input.
  const input = el('input', { type: 'file', accept: 'image/*', style: 'position:fixed;left:-9999px;width:1px;height:1px;opacity:0' });
  document.body.append(input);
  const cleanup = () => setTimeout(() => input.remove(), 1000);
  input.addEventListener('cancel', cleanup);
  input.addEventListener('change', async () => {
    const file = input.files[0];
    cleanup();
    if (!file) return;
    try {
      const dataUrl = await compressImage(file, 480, 0.65);
      const all = store.load(SHARED_KEY, {});
      const before = JSON.stringify(all).length - (all[id]?.photo?.length || 0);
      if (before + dataUrl.length > SHARED_PHOTO_BUDGET) {
        toast('Photo space for the shared list is full — remove a few photos first.');
        return;
      }
      setShopPhoto(id, dataUrl);
      haptic();
      toast('Photo added ✓');
    } catch (e) {
      toast(e.message || 'Could not add that photo.');
    }
  });
  input.click();
}
function openPhotoViewer(src, title, onRemove) {
  const v = $('photo-viewer');
  $('photo-viewer-img').src = src;
  $('photo-viewer-title').textContent = title || '';
  v.hidden = false;
  const close = () => { v.hidden = true; $('photo-viewer-img').src = ''; };
  $('photo-viewer-close').onclick = close;
  v.onclick = (e) => { if (e.target === v) close(); };
  $('photo-viewer-remove').hidden = !onRemove;
  $('photo-viewer-remove').onclick = () => { close(); onRemove(); toast('Photo removed'); };
}

$('btn-shared-clear').addEventListener('click', () => {
  const all = store.load(SHARED_KEY, {});
  for (const it of Object.values(all)) if (it.done && !it.deleted && (it.type || 'shop') === 'shop') all[it.id] = tombstone(it);
  store.save(SHARED_KEY, all);
  renderShared();
  scheduleSync();
});
$('btn-shared-add').addEventListener('click', () => {
  const raw = $('shared-input').value.trim();
  if (!raw) return;
  const texts = raw.split(',').map((s) => s.trim()).filter(Boolean); // "milk, bread, eggs" -> 3 items
  const all = store.load(SHARED_KEY, {});
  for (const text of texts) {
    const id = 's' + now() + Math.random().toString(36).slice(2, 6) + Object.keys(all).length;
    all[id] = { id, text, done: false, updatedAt: now(), deleted: false };
  }
  store.save(SHARED_KEY, all);
  $('shared-input').value = '';
  renderShared();
  scheduleSync();
});
$('shared-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-shared-add').click(); });

function initLifeSections() {
  renderUtilities();
  renderSubs();
  renderTaxDates();
  calcTax();
  renderMoney();
  renderInventory();
  renderMeters();
  renderMaint();
  renderCheckups();
  renderLoyalty();
  initNames();
  renderBills();
  renderTasks();
  initEmergency();
  refreshPairUI();
  if (paired()) syncNow();
}

// ---------- quick import (paste many entries at once) ----------
let importParsed = null;
let idCounter = 0;
const uid = () => Date.now() * 1000 + (idCounter++);
$('btn-import-preview').addEventListener('click', () => {
  importParsed = parseImport($('import-text').value);
  const n = importCount(importParsed);
  const errs = importParsed.errors.length;
  $('btn-import-apply').hidden = n === 0;
  if (!n && !errs) return setStatus('import-status', 'Nothing to add — paste some lines first.');
  const bits = [];
  const c = importParsed;
  const label = (arr, one, many = one + 's') => arr.length && bits.push(`${arr.length} ${arr.length === 1 ? one : many}`);
  label(c.subscriptions, 'subscription'); label(c.utilities, 'utility plan'); label(c.documents, 'document');
  label(c.deliveries, 'delivery', 'deliveries'); label(c.events, 'event'); label(c.loyalty, 'loyalty card'); label(c.checkups, 'check-up');
  label(c.maintenance, 'maintenance item'); label(c.shopping, 'shopping item'); label(c.trips, 'trip'); label(c.bookings, 'travel booking');
  if (Object.keys(c.vehicle).length) bits.push('car details');
  setStatus('import-status', `Ready to add: ${bits.join(', ') || 'nothing'}.${errs ? ` ${errs} line(s) not understood will be skipped.` : ''}`);
});
// Apply a parsed import to the vault. Shared by the paste-in button and the
// one-tap morning link. Returns the count added and an undo() that fully
// restores the touched collections to how they were.
function applyParsedImport(r) {
  const snapshot = {};
  const snap = (key, def) => { if (!(key in snapshot)) snapshot[key] = JSON.parse(JSON.stringify(store.load(key, def))); };
  const add = (key, items, map) => { if (items.length) { snap(key, []); store.save(key, [...items.map(map), ...store.load(key, [])]); } };
  add(SUBS_KEY, r.subscriptions, (s) => ({ id: uid(), ...s }));
  add(DOCS_KEY, r.documents, (d) => ({ id: uid(), ...d }));
  // Deliveries and calendar events live in the shared space (so your partner
  // sees them). Skip anything already there, so tapping the same morning link
  // on both phones never creates duplicates.
  const addedShared = [];
  const addUnique = (type, rows, keyFn, extra = {}) => {
    const all = Object.values(store.load(SHARED_KEY, {})).filter((i) => (i.type || 'shop') === type);
    const seen = new Set(all.filter((i) => !i.deleted).map(keyFn));
    const gone = new Set(all.filter((i) => i.deleted && i.k).map((i) => i.k));
    for (const row of rows) {
      const k = keyFn({ ...extra, ...row });
      if (k && (seen.has(k) || gone.has(fnv(k)))) continue;
      if (k) seen.add(k);
      addedShared.push(sharedAdd(type, { ...extra, ...row }));
    }
  };
  addUnique('delivery', r.deliveries, deliveryKey, { done: false });
  addUnique('event', r.events, eventKey);
  addUnique('utility', r.utilities.map(({ type, ...u }) => ({ ...u, service: type })), (u) => `${(u.service || '').toLowerCase()}|${(u.provider || '').trim().toLowerCase()}`);
  add(LOYAL_KEY, r.loyalty, (c) => ({ id: uid(), ...c }));
  add(CHECK_KEY, r.checkups, (c) => ({ id: uid(), ...c }));
  add(MAINT_KEY, r.maintenance, (m) => ({ id: uid(), ...m }));
  addUnique('shop', r.shopping.map((text) => ({ text })), (i) => (i.done ? '' : (i.text || '').trim().toLowerCase()), { done: false });
  const addedBookings = [];
  importTravel(r, addedShared, addedBookings);
  if (addedShared.length || addedBookings.length) scheduleSync();
  let vehicleSnap = null;
  if (Object.keys(r.vehicle).length) {
    vehicleSnap = JSON.parse(JSON.stringify(loadVehicle()));
    const v = loadVehicle();
    for (const [k, val] of Object.entries(r.vehicle)) if (val) v[k] = k === 'reg' ? cleanReg(val) : val;
    saveVehicle(v);
  }
  const rerender = () => { renderSubs(); renderUtilities(); renderDocs(); renderDeliveries(); renderLoyalty(); renderCheckups(); renderMaint(); renderSharedAll(); initCarTab(); };
  rerender();
  const undo = () => {
    for (const [key, val] of Object.entries(snapshot)) store.save(key, val);
    if (vehicleSnap) saveVehicle(vehicleSnap);
    // Shared items are removed (not rolled back) so the removal syncs too.
    for (const id of addedShared) sharedRemove(id);
    for (const { tripId, bookingId } of addedBookings) { const t = trips().find((x) => x.id === tripId); if (t) sharedUpdate(tripId, { bookings: (t.bookings || []).filter((b) => b.id !== bookingId) }); }
    if (addedShared.length || addedBookings.length) scheduleSync();
    rerender();
  };
  // Count what was actually added (things already there, or deleted before, are skipped).
  const localAdded = r.subscriptions.length + r.documents.length + r.loyalty.length + r.checkups.length + r.maintenance.length + Object.keys(r.vehicle).length;
  return { count: localAdded + addedShared.length + addedBookings.length, undo };
}

$('btn-import-apply').addEventListener('click', () => {
  if (!importParsed) return;
  const { count } = applyParsedImport(importParsed);
  importParsed = null;
  $('import-text').value = '';
  $('btn-import-apply').hidden = true;
  setStatus('import-status', `Added ${count} item${count === 1 ? '' : 's'}. ✓`);
});

// Decode a base64url (UTF-8) payload used by one-tap import links.
function decodeImportPayload(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
  return decodeURIComponent(Array.from(bin, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''));
}

// ---------- text size ----------
const TEXT_KEY = 'tiguan-textsize';
function applyTextSize(size) {
  document.documentElement.dataset.textSize = size;
  document.querySelectorAll('#text-size button').forEach((b) => b.classList.toggle('active', b.dataset.size === size));
  try {
    localStorage.setItem(TEXT_KEY, size);
  } catch {
    /* ignore */
  }
}
document.querySelectorAll('#text-size button').forEach((b) => b.addEventListener('click', () => applyTextSize(b.dataset.size)));

// ---------- log buttons ----------
$('btn-copy-log').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(logLines.join('\n'));
    $('btn-copy-log').textContent = 'Copied';
  } catch {
    $('btn-copy-log').textContent = 'Copy failed';
  }
  setTimeout(() => ($('btn-copy-log').textContent = 'Copy log'), 1500);
});
$('btn-clear-log').addEventListener('click', () => {
  logLines.length = 0;
  renderLog();
});

// ---------- lock / unlock / backup ----------
// Collections migrated from the old unencrypted storage into the vault on first setup.
const MIGRATE_KEYS = ['tiguan-checks', 'tiguan-trips', 'tiguan-vehicle', 'tiguan-fuel', 'tiguan-service', 'tiguan-mileage', 'tiguan-park', 'tiguan-docs'];

function collectLegacyData() {
  const seed = {};
  for (const key of MIGRATE_KEYS) {
    try {
      const raw = localStorage.getItem(key);
      if (raw != null) seed[key] = JSON.parse(raw);
    } catch {
      /* ignore unreadable legacy value */
    }
  }
  return seed;
}
function clearLegacyData() {
  for (const key of MIGRATE_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}

let setupMode = false;
function showLockScreen() {
  setupMode = !vault.exists();
  $('lock-pass').value = '';
  $('lock-pass2').value = '';
  $('lock-error').textContent = '';
  $('lock-pass2').hidden = !setupMode;
  $('lock-reset').hidden = setupMode;
 const wiped = new URLSearchParams(location.search).get('wiped');
  $('lock-intro').textContent = wiped && wiped !== 'reset' && setupMode
    ? (wiped === 'tries'
      ? `Evergreen was erased on this phone after ${MAX_TRIES} wrong passphrase attempts. Set a new passphrase, restore your backup (Help → Security & backup), and rejoin your shared space with your partner's code.`
      : 'Evergreen was erased on this phone because it was reported lost. If it is yours and you have it back, set a passphrase, then rejoin your shared space with the new code from your partner.')
    : setupMode
    ? 'Set a passphrase to protect everything you store here. It never leaves this phone, and it can\'t be recovered if you forget it — so make it memorable.'
    : 'Enter your passphrase to unlock your data.';
  $('lock-submit').textContent = setupMode ? 'Create my vault' : 'Unlock';
  $('btn-biometric').hidden = setupMode || !biometricConfigured();
  $('lock-screen').hidden = false;
  if (!setupMode && biometricConfigured()) tryBiometricUnlock();
  else $('lock-pass').focus();
}

async function tryBiometricUnlock() {
  const btn = $('btn-biometric');
  btn.disabled = true;
  try {
    const passphrase = await unlockBiometric();
    await vault.unlock(passphrase);
    $('lock-screen').hidden = true;
    await initAll();
    ensureDeviceProtection(passphrase);
  } catch (e) {
    $('lock-error').textContent = /failed|not set up/i.test(e.message) ? '' : e.message;
    $('lock-pass').focus();
  } finally {
    btn.disabled = false;
  }
}
$('btn-biometric').addEventListener('click', tryBiometricUnlock);

async function onUnlockSubmit(e) {
  e.preventDefault();
  const pass = $('lock-pass').value;
  const err = $('lock-error');
  err.textContent = '';
  if (setupMode) {
    if (pass.length < 8) return (err.textContent = 'Use at least 8 characters — a few words is easiest to remember.');
    if (pass !== $('lock-pass2').value) return (err.textContent = 'The two passphrases do not match.');
    $('lock-submit').disabled = true;
    try {
      await vault.setup(pass, collectLegacyData());
      clearLegacyData();
    } finally {
      $('lock-submit').disabled = false;
    }
  } else {
    $('lock-submit').disabled = true;
    try {
      await vault.unlock(pass);
    } catch {
      $('lock-submit').disabled = false;
      err.textContent = 'Wrong passphrase. Try again.';
      noteWrongPassphrase();
      return;
    }
    $('lock-submit').disabled = false;
    resetWrongPassphrases();
  }
  $('lock-screen').hidden = true;
  await initAll();
  offerBiometric(pass);
  ensureDeviceProtection(pass);
}

function lockApp() {
  vault.lock();
  mediaKey = null;
  knownIds = null;
  stopLive();
  stopTrip(false);
  if (elm) {
    const cur = elm;
    handleDisconnect('Locked.');
    cur.close().catch(() => {});
  }
  showLockScreen();
}

$('lock-form').addEventListener('submit', onUnlockSubmit);
// Lock automatically when the app has been in the background for 5 minutes.
const AUTO_LOCK_MS = 5 * 60 * 1000;
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (hiddenAt && !vault.locked && Date.now() - hiddenAt >= AUTO_LOCK_MS) lockApp();
});
$('btn-lock').addEventListener('click', lockApp);
$('lock-reset').addEventListener('click', () => {
  if (!confirm('Forgotten your passphrase?\n\nThere is no way to recover the data without it. You can wipe everything and start fresh. This cannot be undone.')) return;
  if (!confirm('Really erase all stored data on this phone?')) return;
  wipeThisPhone('reset');
});

// Security card actions
$('btn-lock2').addEventListener('click', lockApp);
$('btn-backup').addEventListener('click', async () => {
  const vaultBlob = vault.backupBlob();
  if (!vaultBlob) return;
  setStatus('security-status', 'Preparing backup…');
  const bundle = { app: 'evergreen-backup', v: 1, vault: vaultBlob, photos: await exportAllPhotos().catch(() => ({})), files: await exportPrivateFiles().catch(() => ({})) };
  const url = URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `evergreen-backup-${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  setStatus('security-status', 'Backup saved (including photos). Keep it safe — it needs your passphrase to open.');
});
$('btn-restore').addEventListener('click', () => $('restore-file').click());
$('restore-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const pass = prompt('Enter the passphrase for that backup:');
  if (!pass) return;
  try {
    const parsed = JSON.parse(await file.text());
    const vaultBlob = parsed.app === 'evergreen-backup' ? parsed.vault : parsed; // new bundle or legacy raw blob
    await vault.restore(vaultBlob, pass);
    if (parsed.app === 'evergreen-backup' && parsed.photos) await importAllPhotos(parsed.photos);
    if (parsed.app === 'evergreen-backup' && parsed.files) await importPrivateFiles(parsed.files).catch(() => {});
    disableBiometric(); // it held the passphrase from before the restore
    refreshBiometricButtons();
    initAll();
    setStatus('security-status', 'Backup restored. Turn fingerprint / Face ID unlock back on if you use it.');
  } catch {
    setStatus('security-status', 'Could not restore — wrong passphrase or not a valid backup file.', true);
  } finally {
    e.target.value = '';
  }
});
// Offer fingerprint / Face ID unlock right after unlocking with the passphrase
// (so it's found without digging through Help). Asks once per unlock until
// it's on, or until "Don't ask again".
const BIO_OFFER_KEY = 'evergreen-bio-offer';
async function offerBiometric(pass) {
  try { if (localStorage.getItem(BIO_OFFER_KEY) === 'no') return; } catch { return; }
  if (biometricConfigured() || !(await biometricAvailable())) return;
  if (!$('sheet').hidden) return; // something more important is open (e.g. a link to confirm) — ask next time
  const msg = el('p', { class: 'status', role: 'status' });
  const yes = el('button', { class: 'primary', text: 'Turn it on' });
  const later = el('button', { text: 'Not now' });
  const never = el('button', { class: 'link', text: "Don't ask again" });
  yes.addEventListener('click', async () => {
    yes.disabled = true;
    msg.classList.remove('error');
    msg.textContent = "Follow your phone's prompt…";
    try {
      await enableBiometric(pass);
      closeSheet();
      refreshBiometricButtons();
      haptic();
      toast('Fingerprint / Face ID unlock is on ✓');
    } catch (e) {
      yes.disabled = false;
      msg.textContent = e.message || "That didn't work — you can try again from Help → Security & backup.";
      msg.classList.add('error');
    }
  });
  later.addEventListener('click', closeSheet);
  never.addEventListener('click', () => { try { localStorage.setItem(BIO_OFFER_KEY, 'no'); } catch { /* ignore */ } closeSheet(); });
  openSheet(el('div', { class: 'sheet-icon', text: '👆' }), el('h2', { text: 'Unlock with your fingerprint?' }),
    el('p', { class: 'muted', text: 'Next time, open Evergreen with your fingerprint or Face ID instead of typing your passphrase. Your passphrase still works too, and you can turn this off any time in Help → Security & backup.' }),
    msg, el('div', { class: 'row' }, later, yes), never);
}
async function refreshBiometricButtons() {
  const configured = biometricConfigured();
  const available = await biometricAvailable();
  $('btn-bio-enable').hidden = configured || !available;
  $('btn-bio-disable').hidden = !configured;
}
$('btn-bio-enable').addEventListener('click', async () => {
  const pass = prompt('Confirm your passphrase to turn on fingerprint unlock:');
  if (!pass) return;
  if (!(await vault.verify(pass))) return setStatus('security-status', 'Wrong passphrase.', true);
  setStatus('security-status', 'Follow your phone\'s prompt…');
  try {
    await enableBiometric(pass);
    setStatus('security-status', 'Fingerprint unlock is on. Your passphrase still works too.');
  } catch (e) {
    setStatus('security-status', e.message || 'Could not enable fingerprint unlock.', true);
  }
  refreshBiometricButtons();
});
$('btn-bio-disable').addEventListener('click', () => {
  disableBiometric();
  setStatus('security-status', 'Fingerprint unlock turned off.');
  refreshBiometricButtons();
});
$('btn-change-pass').addEventListener('click', async () => {
  const current = prompt('Your current passphrase:');
  if (current == null) return;
  if (!(await vault.verify(current))) return setStatus('security-status', 'That\'s not your current passphrase.', true);
  const pass = prompt('New passphrase (at least 8 characters):');
  if (pass == null) return;
  if (pass.length < 8) return setStatus('security-status', 'Passphrase too short — use at least 8 characters.', true);
  if (prompt('Confirm the new passphrase:') !== pass) return setStatus('security-status', 'Passphrases did not match.', true);
  // Re-key by setting up a fresh vault with the current data.
  await vault.setup(pass, vault.data);
  disableBiometric(); // the stored wrapped passphrase is now stale
  ensureDeviceProtection(pass, true); // lost-phone check uses the new passphrase
  refreshBiometricButtons();
  setStatus('security-status', 'Passphrase changed. Save a fresh backup, and re-enable fingerprint unlock if you use it.');
});

// ---------- launch actions: share-to-app + home-screen shortcuts ----------
const goTab = (name) => showTab(name);
function openDetails(id) {
  const d = $(id);
  if (d) {
    d.open = true;
    d.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}
// Links can come from anyone, so show what's in one before adding it.
function confirmImport(r) {
  const v = loadVehicle();
  const lines = [
    ...r.deliveries.map((d) => `📦 ${d.item || 'Parcel'}${d.carrier ? ' · ' + d.carrier : ''}${d.expected ? ' · ' + fmtDate(d.expected) : ''}`),
    ...r.events.map((e) => `📅 ${e.title} · ${e.date ? fmtDate(e.date) : 'no date'}${e.time ? ' ' + e.time : ''}`),
    ...(r.trips || []).map((t) => `🧳 ${t.title}${t.start ? ' · ' + fmtDate(t.start) : ''}`),
    ...(r.bookings || []).map((b) => `${BOOKING_KINDS[b.kind]?.icon || '📌'} ${bookingSummary(b).title}`),
    ...r.shopping.map((t) => `🛒 ${t}`),
    ...r.subscriptions.map((x) => `🔁 ${x.name} · £${x.cost}`),
    ...r.utilities.map((u) => `⚡ ${u.type} · ${u.provider || ''}`),
    ...r.documents.map((x) => `📄 ${x.label}${x.expiry ? ' · expires ' + fmtDate(x.expiry) : ''}`),
    ...r.loyalty.map((x) => `💳 ${x.name}`),
    ...r.checkups.map((x) => `❤️ ${x.type}`),
    ...r.maintenance.map((x) => `🏠 ${x.task}`),
    ...Object.entries(r.vehicle).map(([k, val]) => `🚗 ${k.toUpperCase()}: ${k === 'reg' ? val : fmtDate(val)}${v[k] && v[k] !== val ? ` (replaces ${k === 'reg' ? v[k] : fmtDate(v[k])})` : ''}`),
  ];
  const list = el('ul', { class: 'small' }, ...lines.slice(0, 12).map((t) => el('li', { text: t })));
  if (lines.length > 12) list.append(el('li', { class: 'muted', text: `…and ${lines.length - 12} more` }));
  const add = el('button', { class: 'primary', text: `Add ${lines.length === 1 ? 'it' : 'all ' + lines.length}` });
  const cancel = el('button', { text: 'Cancel' });
  cancel.addEventListener('click', () => { closeSheet(); toast('Nothing was added.'); });
  add.addEventListener('click', () => {
    closeSheet();
    const { count, undo } = applyParsedImport(r);
    if ((r.trips || []).length || (r.bookings || []).length) goLife('travel');
    else if (r.deliveries.length) goLife('deliveries');
    if (!count) return toast('Already in Evergreen — nothing new to add.');
    toast(`Added ${count} item${count === 1 ? '' : 's'} ✓`, { actionLabel: 'Undo', onAction: undo, ms: 8000 });
  });
  openSheet(el('h2', { text: 'Add these to Evergreen?' }),
    el('p', { class: 'muted small', text: 'From the link you just opened. Only add it if you were expecting it.' }), list,
    el('div', { class: 'row' }, cancel, add));
}

function handleLaunchParams() {
  const q = new URLSearchParams(location.search);
  if (![...q.keys()].length) return;
  const action = q.get('action');
  const importPayload = q.get('import');
  const hasShared = q.has('title') || q.has('text') || q.has('url');
  history.replaceState(null, '', location.pathname); // don't repeat on refresh
  if (importPayload) {
    (async () => {
    // Pull your partner's latest first, so things they already added aren't duplicated.
    if (paired()) await Promise.race([syncNow(), new Promise((r) => setTimeout(r, 5000))]);
    try {
      const r = parseImport(decodeImportPayload(importPayload));
      if (!importCount(r)) return toast('That link had nothing new to add.');
      confirmImport(r);
    } catch {
      toast('Sorry — that import link could not be read.');
    }
    })();
    return;
  }
  if (hasShared) {
    const shared = parseShared({ title: q.get('title') || '', text: q.get('text') || '', url: q.get('url') || '' });
    goTab('life');
    $('del-item').value = shared.item || '';
    $('del-carrier').value = CARRIER_NAMES.includes(shared.carrier) ? shared.carrier : 'Other';
    $('del-tracking').value = shared.tracking || shared.link || '';
    openDetails('del-form');
    return;
  }
  const map = { fuel: ['car', 'fuel-form'], doc: ['life', 'doc-form'], delivery: ['life', 'del-form'] };
  if (action === 'park') {
    goTab('car');
    $('btn-park').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else if (map[action]) {
    goTab(map[action][0]);
    openDetails(map[action][1]);
  }
}

// ---------- connected Google Calendar ----------
// Each phone fetches its owner's calendar feed (via the sync server, which
// browsers require), expands the next 60 days, and writes the events into the
// shared space tagged with this phone's source id, so your partner sees them.
const CAL_DAYS = 60;
const CAL_MIN_GAP = 10 * 60 * 1000;
let calPulling = null;
let calLastPull = 0;
function fnv(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); }
function mergeCalendar(occs, src, who) {
  const all = sharedItems('event');
  const own = new Map(all.filter((e) => e.src === src).map((e) => [e.id, e]));
  // Your partner's connected calendar wins for events you both have; events that
  // arrived untagged (morning link / added by hand) are taken over by the calendar,
  // so they show as yours and stay in step with Google.
  // Each phone keeps its own copy of events you both have (so each stays in step
  // with its own Google Calendar); the calendar shows them once as "Both of you".
  // Untagged copies (from an old link, or typed in) that match are replaced.
  let untagged = all.filter((e) => !e.src);
  const wanted = new Set();
  let changes = 0;
  for (const o of occs) {
    for (const old of untagged.filter((u) => sameEvent(u, o))) { sharedRemove(old.id); changes++; }
    untagged = untagged.filter((u) => !sameEvent(u, o));
    const id = 'g' + fnv(src + '|' + o.uid) + o.date.replace(/-/g, '') + (o.time || '').replace(':', '');
    wanted.add(id);
    const prev = own.get(id);
    if (prev && prev.title === o.title && prev.where === o.where && prev.who === who) continue;
    sharedSet({ id, type: 'event', src, who, title: o.title, date: o.date, time: o.time, where: o.where, updatedAt: now(), deleted: false });
    changes++;
  }
  for (const e of own.values()) if (!wanted.has(e.id)) { sharedRemove(e.id); changes++; }
  return changes;
}
function pullCalendar(manual = false) {
  const s = settings();
  if (!s.icsUrl || !paired()) return Promise.resolve(false);
  if (!manual && Date.now() - calLastPull < CAL_MIN_GAP) return Promise.resolve(false);
  if (calPulling) return calPulling;
  calPulling = (async () => {
    calLastPull = Date.now();
    try {
      const hid = await householdId(s.householdCode);
      const res = await fetch(`${s.syncUrl.replace(/\/+$/, '')}/cal?h=${hid}&url=${encodeURIComponent(s.icsUrl)}`, { cache: 'no-store', headers: { 'X-Evergreen-Token': await writeToken(s.householdCode) } });
      if (!res.ok) {
        let msg = '';
        try { msg = (await res.json()).error; } catch { /* not json */ }
        // The old sync server code has no calendar route and answers "bad id".
        if (msg === 'bad id') msg = 'your sync server needs updating — paste the latest worker code into Cloudflare (Help → Sharing with your partner)';
        throw new Error(msg || `the server returned ${res.status}`);
      }
      const text = await res.text();
      if (!/BEGIN:VCALENDAR/.test(text)) throw new Error("that link didn't return a calendar");
      const hide = (settings().calHide || '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
      const occs = expandEvents(parseICS(text), todayISO(), CAL_DAYS).filter((o) => !hide.some((w) => `${o.title} ${o.where}`.toLowerCase().includes(w)));
      const changes = mergeCalendar(occs, s.calSrc, myName() === 'Me' ? '' : myName());
      saveSettings({ calLast: Date.now(), calCount: occs.length, calError: '' });
      if (changes) { scheduleSync(); renderCalendar(); renderHome(); }
      refreshCalConnectUI();
      return true;
    } catch (e) {
      saveSettings({ calError: e.message });
      refreshCalConnectUI();
      log('info', 'Calendar update failed: ' + e.message);
      if (manual) throw e;
      return false;
    } finally {
      calPulling = null;
    }
  })();
  return calPulling;
}
function refreshCalConnectUI() {
  const s = settings();
  const on = Boolean(s.icsUrl);
  $('cal-conn-off').hidden = on;
  $('cal-conn-on').hidden = !on;
  if (on) $('cal-card').after($('cal-connect')); else $('cal-card').before($('cal-connect'));
  if (!on) return;
  if ($('cal-hide') !== document.activeElement) $('cal-hide').value = s.calHide || '';
  $('cal-conn-status').textContent = s.calError
    ? `— couldn't update: ${s.calError}`
    : s.calLast ? `· connected ✓ · updated ${new Date(s.calLast).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : '· connected ✓';
}
$('btn-cal-connect').addEventListener('click', async () => {
  const link = $('cal-ics').value.trim().replace(/^webcal:/i, 'https:');
  if (!/^https:\/\/\S+/.test(link)) return setStatus('cal-conn-msg', "Paste your calendar's secret address first.", true);
  if (/calendar\.google\.com/.test(link) && !/\/ical\//.test(link)) return setStatus('cal-conn-msg', "That's not the iCal address — copy 'Secret address in iCal format' (it ends in .ics).", true);
  if (/calendar\.google\.com\/calendar\/ical\/[^/]+\/public\//.test(link)) return setStatus('cal-conn-msg', "That's the public address — Google only allows it for public calendars. Copy the 'Secret address in iCal format' just below it instead (it has 'private-' in it).", true);
  if (!paired()) return setStatus('cal-conn-msg', 'Set up Settings → Sharing first — the calendar uses the same server.', true);
  const btn = $('btn-cal-connect');
  btn.disabled = true;
  setStatus('cal-conn-msg', 'Connecting…');
  saveSettings({ icsUrl: link, calSrc: settings().calSrc || 'c' + fnv(String(Math.random()) + Date.now()), calError: '' });
  try {
    await syncNow(); // makes sure the household exists on the server
    await pullCalendar(true);
    if (sharedItems('device').some((x) => x.id === myDeviceRecordId())) { sharedUpdate(myDeviceRecordId(), { calSrc: settings().calSrc }); scheduleSync(); }
    $('cal-ics').value = '';
    setStatus('cal-conn-msg', `Connected — ${settings().calCount} events added to the family calendar ✓`);
    haptic();
  } catch (e) {
    saveSettings({ icsUrl: '' });
    setStatus('cal-conn-msg', `Couldn't connect: ${e.message}`, true);
  } finally {
    btn.disabled = false;
    refreshCalConnectUI();
  }
});
$('btn-cal-refresh').addEventListener('click', async () => {
  setStatus('cal-conn-msg', 'Updating…');
  try { await pullCalendar(true); setStatus('cal-conn-msg', 'Up to date ✓'); } catch (e) { setStatus('cal-conn-msg', `Couldn't update: ${e.message}`, true); }
});
$('btn-cal-disconnect').addEventListener('click', () => {
  if (!confirm("Disconnect your calendar? Your events will be removed from the family calendar on both phones.")) return;
  const src = settings().calSrc;
  for (const e of sharedItems('event')) if (e.src === src) sharedRemove(e.id);
  saveSettings({ icsUrl: '', calLast: 0, calCount: 0, calError: '' });
  scheduleSync(); renderCalendar(); renderHome(); refreshCalConnectUI();
  setStatus('cal-conn-msg', 'Disconnected.');
});
const persistCalHide = debounce((v) => { saveSettings({ calHide: v }); pullCalendar(true).catch(() => {}); }, 900);
$('cal-hide').addEventListener('input', (e) => persistCalHide(e.target.value));

// ---------- files: attach documents and photos to things ----------
// Shared things (trips, family, utilities) keep their files encrypted on your own
// sync server, so both phones can open them. Private things (documents, home,
// health) keep them encrypted on this phone only. Items just hold a small list:
// files: [{ blobId | fileId, name, type, size, addedAt, by, local? }]
const fileThumbs = new Map(); // file id -> object URL (reused while the app is open)
const fileKeyOf = (f) => f.blobId || f.fileId;
const fileIcon = (f) => (/pdf/.test(f.type) ? '📕' : /^image\//.test(f.type) ? '🖼️' : /word|document|text/.test(f.type) ? '📘' : /sheet|excel|csv/.test(f.type) ? '📗' : '📄');
async function fileBlob(f) {
  if (f.local) {
    if (!mediaKey) throw new Error('Unlock Evergreen first.');
    const b = await loadPrivateFile(f.fileId, mediaKey, f.type);
    if (!b) throw new Error("That file isn't on this phone (private files stay on the phone that added them).");
    return b;
  }
  if (!paired()) throw new Error('Set up Settings → Sharing to open shared files.');
  const s = settings();
  return downloadSharedFile({ serverUrl: s.syncUrl, code: s.householdCode, blobId: f.blobId, type: f.type });
}
async function fileUrl(f) {
  const k = fileKeyOf(f);
  if (!fileThumbs.has(k)) fileThumbs.set(k, URL.createObjectURL(await fileBlob(f)));
  return fileThumbs.get(k);
}
function dropFiles(files = [], delayMs = 0) {
  if (!files.length) return;
  setTimeout(() => {
    for (const f of files) {
      if (f.local) deletePrivateFile(f.fileId).catch(() => {});
      else if (paired()) { const s = settings(); deleteSharedFile({ serverUrl: s.syncUrl, code: s.householdCode, blobId: f.blobId }).catch(() => {}); }
    }
  }, delayMs);
}
// Photos are shrunk (but kept readable for documents); PDFs and other files go as they are.
async function prepareUpload(file) {
  const isImage = /^image\//.test(file.type) || /\.(jpe?g|png|heic|heif|webp)$/i.test(file.name || '');
  if (!isImage || /gif|svg/.test(file.type)) return file;
  const dataUrl = await compressImage(file, 2000, 0.78);
  const blob = await (await fetch(dataUrl)).blob();
  const base = (file.name || 'Photo').replace(/\.[^.]+$/, '') || 'Photo';
  return new File([blob], base + '.jpg', { type: 'image/jpeg' });
}
async function addFile(file, shared) {
  const prepared = await prepareUpload(file);
  const tooBig = checkFileSize(prepared);
  if (tooBig) throw new Error(tooBig);
  if (shared) {
    if (!paired()) throw new Error('Shared files are stored on your sync server — set up Settings → Sharing first.');
    const s = settings();
    const meta = await uploadSharedFile({ serverUrl: s.syncUrl, code: s.householdCode, file: prepared });
    return { blobId: meta.blobId, name: meta.name, type: meta.type, size: meta.size, addedAt: meta.addedAt, by: myName() };
  }
  if (!mediaKey) throw new Error('Unlock Evergreen first.');
  const meta = await savePrivateFile(prepared, mediaKey);
  return { ...meta, by: myName() };
}
function pickFile(onFile) {
  // Kept in the page: iPhones can silently drop a file chosen through a detached input.
  const input = el('input', { type: 'file', accept: 'image/*,application/pdf,.pdf,.doc,.docx,.txt', style: 'position:fixed;left:-9999px;width:1px;height:1px;opacity:0' });
  document.body.append(input);
  const cleanup = () => setTimeout(() => input.remove(), 1000);
  input.addEventListener('cancel', cleanup);
  input.addEventListener('change', () => { const f = input.files[0]; cleanup(); if (f) onFile(f); });
  input.click();
}
const fileSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
/**
 * A row of file tiles with "+ Add". `get()` returns the current list, `save(list)` stores it.
 * shared: true → stored on your sync server for both phones; false → this phone only.
 */
function filesStrip({ get, save, shared, hint }) {
  const box = el('div', { class: 'files' });
  const row = el('div', { class: 'files-row' });
  const note = el('div', { class: 'files-note', text: hint || (shared ? '🔒 Shared with your partner · encrypted' : '🔒 Only on this phone · encrypted') });
  const draw = () => {
    row.replaceChildren();
    for (const f of get() || []) {
      const tile = el('button', { class: 'file-tile', type: 'button', 'aria-label': 'Open ' + f.name },
        el('span', { class: 'file-ico', text: fileIcon(f) }), el('span', { class: 'file-name', text: f.name }));
      if (/^image\//.test(f.type)) {
        fileUrl(f).then((u) => { tile.style.backgroundImage = `url("${u}")`; tile.classList.add('thumb'); }).catch(() => {});
      }
      tile.addEventListener('click', () => openFileViewer(f, () => { save((get() || []).filter((x) => fileKeyOf(x) !== fileKeyOf(f))); dropFiles([f]); draw(); }));
      row.append(tile);
    }
    const add = el('button', { class: 'file-tile file-add', type: 'button', 'aria-label': 'Add a photo or file' }, el('span', { class: 'file-ico', text: '＋' }), el('span', { class: 'file-name', text: 'Photo / file' }));
    add.addEventListener('click', () => pickFile(async (file) => {
      add.disabled = true;
      add.querySelector('.file-name').textContent = 'Adding…';
      try {
        const meta = await addFile(file, shared);
        save([...(get() || []), meta]);
        haptic();
        toast(`${meta.name} added ✓`);
      } catch (e) {
        toast(e.message || "Couldn't add that file.", { ms: 7000 });
      }
      draw();
    }));
    row.append(add);
  };
  draw();
  box.append(row, note);
  return box;
}
function openFileViewer(f, onDelete) {
  const view = el('div', { class: 'file-viewer', role: 'dialog', 'aria-label': f.name });
  const body = el('div', { class: 'file-view-body' }, el('p', { class: 'muted', text: 'Opening…' }));
  const close = () => { view.remove(); syncNav(); };
  const btnClose = el('button', { class: 'primary', text: 'Close' });
  btnClose.addEventListener('click', close);
  const btnShare = el('button', { text: navigator.share ? 'Share / save' : 'Download' });
  const btnOpen = el('button', { text: 'Open' });
  const btnDel = el('button', { class: 'link', style: 'color:var(--urgent, #c0392b)', text: 'Delete' });
  btnDel.addEventListener('click', () => {
    if (!confirm(`Delete ${f.name}${f.local ? '' : ' from both phones'}?`)) return;
    close(); onDelete(); toast(`${f.name} deleted`);
  });
  view.append(el('div', { class: 'file-view-top' }, el('div', {}, el('div', { class: 'name', text: f.name }),
    el('div', { class: 'sub', text: [fileSize(f.size || 0), f.addedAt ? 'added ' + new Date(f.addedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '', f.by && f.by !== 'Me' ? 'by ' + f.by : ''].filter(Boolean).join(' · ') })), btnClose),
  body, el('div', { class: 'row file-view-actions' }, btnOpen, btnShare, btnDel));
  document.body.append(view);
  syncNav();
  fileBlob(f).then((blob) => {
    const url = fileThumbs.get(fileKeyOf(f)) || URL.createObjectURL(blob);
    fileThumbs.set(fileKeyOf(f), url);
    body.replaceChildren(/^image\//.test(f.type) ? el('img', { src: url, alt: f.name })
      : el('div', { class: 'file-big-ico' }, el('div', { text: fileIcon(f) }), el('p', { class: 'muted small', text: 'Tap Open to view it, or Share / save to keep a copy or send it on.' })));
    btnOpen.addEventListener('click', () => { const w = window.open(url, '_blank'); if (!w) location.assign(url); });
    btnShare.addEventListener('click', async () => {
      const file = new File([blob], f.name, { type: f.type });
      try {
        if (navigator.canShare && navigator.canShare({ files: [file] })) return await navigator.share({ files: [file], title: f.name });
      } catch (e) { if (e.name === 'AbortError') return; }
      const a = el('a', { href: url, download: f.name }); document.body.append(a); a.click(); a.remove();
    });
  }).catch((e) => body.replaceChildren(el('p', { class: 'status bad', text: e.message || "Couldn't open that file." })));
}

/** A collapsed "📎 Files" row that only draws (and downloads thumbnails) when opened. */
function lazyFiles({ get, save, shared, hint }) {
  const label = (n) => `📎 Documents & photos${n ? ` (${n})` : ''}`;
  const sum = el('summary', { text: label((get() || []).length) });
  const d = el('details', { class: 'inner files-details' }, sum);
  d.addEventListener('toggle', () => {
    if (!d.open || d.dataset.drawn) return;
    d.dataset.drawn = '1';
    if (hint) d.append(el('p', { class: 'muted small', text: hint }));
    d.append(filesStrip({ shared, get, save: (list) => { save(list); sum.textContent = label(list.length); } }));
  });
  return d;
}
/** Files for an item in one of this phone's private lists. */
const privateFiles = (key, id, hint) => lazyFiles({ shared: false, hint,
  get: () => (store.load(key, []).find((x) => x.id === id) || {}).files || [],
  save: (list) => store.save(key, store.load(key, []).map((x) => (x.id === id ? { ...x, files: list } : x))) });

// ---------- Travel: trips, bookings and the pre-trip checks (shared) ----------
const trips = () => sharedItems('trip');
function upcomingTrip() {
  const today = todayISO();
  return trips().filter((t) => t.end && t.end >= today).sort((a, b) => (a.start < b.start ? -1 : 1))[0] || null;
}
const tripFlag = (t) => flag((t.destinations || [])[0]?.iso);
const dt = (s) => {
  if (!s) return '';
  if (s.length <= 10) return new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  return new Date(s).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const tm = (s) => (s && s.length > 10 ? s.slice(11, 16) : '');
const tripDates = (t) => {
  if (!t.start) return '';
  const a = new Date(t.start + 'T00:00:00'), b = new Date((t.end || t.start) + 'T00:00:00');
  const same = a.getFullYear() === b.getFullYear();
  return `${a.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(same ? {} : { year: 'numeric' }) })} – ${b.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
};
const travellerNames = (t) => {
  const people = children();
  const ids = t.travellers && t.travellers.length ? t.travellers : people.map((p) => p.id);
  return people.filter((p) => ids.includes(p.id)).map((p) => p.name);
};
function bookingSummary(b) {
  switch (b.kind) {
    case 'flight': return { title: `${b.flightNo || 'Flight'}${b.from || b.to ? ` ${b.from || '?'} → ${b.to || '?'}` : ''}`, sub: [b.airline, b.depart ? `departs ${dt(b.depart)}` : '', b.arrive ? `lands ${tm(b.arrive) || dt(b.arrive)}` : '', b.seats ? `seats ${b.seats}` : '', b.bags].filter(Boolean).join(' · ') };
    case 'stay': return { title: b.name || 'Hotel', sub: [b.checkIn ? `in ${dt(b.checkIn)}` : '', b.checkOut ? `out ${dt(b.checkOut)}` : '', b.address].filter(Boolean).join(' · ') };
    case 'car': return { title: `Car hire${b.company ? ' — ' + b.company : ''}`, sub: [b.pickUp ? `collect ${dt(b.pickUp)}${b.pickUpPlace ? ' at ' + b.pickUpPlace : ''}` : '', b.dropOff ? `return ${dt(b.dropOff)}${b.dropOffPlace ? ' at ' + b.dropOffPlace : ''}` : ''].filter(Boolean).join(' · ') };
    case 'transport': return { title: `${b.operator || b.mode || 'Transport'}${b.to ? ` → ${b.to}` : ''}`, sub: [b.mode, b.from ? `from ${b.from}` : '', b.depart ? dt(b.depart) : ''].filter(Boolean).join(' · ') };
    case 'insurance': return { title: `Travel insurance${b.provider ? ' — ' + b.provider : ''}`, sub: [b.policyNo ? `policy ${b.policyNo}` : '', b.coverFrom ? `cover ${fmtDate(b.coverFrom)}${b.coverTo ? ' – ' + fmtDate(b.coverTo) : ''}` : ''].filter(Boolean).join(' · ') };
    default: return { title: b.title || 'Booking', sub: b.depart ? dt(b.depart) : '' };
  }
}
function renderTravel() {
  const out = $('trip-list');
  if (!out) return;
  out.replaceChildren();
  const today = todayISO();
  const all = trips().sort((a, b) => ((a.start || '9') < (b.start || '9') ? -1 : 1));
  const coming = all.filter((t) => !t.end || t.end >= today);
  const past = all.filter((t) => t.end && t.end < today).reverse();
  if (!coming.length) out.append(el('p', { class: 'muted small', text: 'No trips coming up. Tap “+ Add a trip” — or paste booking emails into Quick import.' }));
  for (const t of coming) out.append(tripCard(t, today));
  if (past.length) {
    const d = el('details', { class: 'inner' }, el('summary', { text: `Past trips (${past.length})` }));
    for (const t of past) d.append(tripCard(t, today));
    out.append(d);
  }
}
function tripCard(t, today) {
  const checks = tripChecks(t, children(), today, { hasInsurance: annualTravelCover(t) });
  const next = timeline(t).find((b) => b.when && b.when.slice(0, 10) >= today && b.kind !== 'insurance');
  const card = el('button', { class: 'card trip-card', type: 'button' },
    el('div', { class: 'trip-head' }, el('span', { class: 'trip-flag', text: tripFlag(t) }),
      el('div', {}, el('div', { class: 'name', text: t.title || 'Trip' }), el('div', { class: 'sub', text: [tripDates(t), tripStatus(t, today)].filter(Boolean).join(' · ') }))),
    travellerNames(t).length ? el('div', { class: 'trip-people' }, ...travellerNames(t).map((n) => el('span', { class: 'chip', text: n }))) : null,
    next ? el('div', { class: 'trip-next' }, el('span', { class: 'muted small', text: 'Next: ' }), `${BOOKING_KINDS[next.kind]?.icon || '📌'} ${bookingSummary(next).title} · ${dt(next.when)}`) : null,
    checks.length ? el('div', { class: 'trip-warns' }, ...checks.filter((c) => c.level !== 'info').slice(0, 3).map((c) => el('span', { class: 'tag ' + (c.level === 'urgent' ? 'urgent' : 'soon'), text: { passport: 'Passport', auth: 'Authorisation', ghic: 'GHIC', insurance: 'No insurance', checkin: 'Check in', advice: 'Entry rules' }[c.kind] || 'Check' }))) : null,
    (t.files || []).length ? el('div', { class: 'muted small', style: 'margin-top:6px', text: `📎 ${t.files.length} file${t.files.length === 1 ? '' : 's'}` }) : null);
  card.addEventListener('click', () => openTrip(t.id));
  return card;
}
function copyRow(label, value) {
  const b = el('button', { class: 'child-copy', type: 'button', text: value, title: 'Tap to copy' });
  b.addEventListener('click', (e) => { e.stopPropagation(); copyValue(value, label); });
  return b;
}
function openTrip(id) {
  const t = trips().find((x) => x.id === id);
  if (!t) return toast('That trip has been removed.');
  const today = todayISO();
  const nodes = [el('div', { class: 'sheet-tag', text: 'Trip · shared with your partner' }),
    el('h2', {}, `${tripFlag(t)} ${t.title || 'Trip'}`),
    el('p', { class: 'muted', text: [tripDates(t), tripStatus(t, today)].filter(Boolean).join(' · ') })];
  const names = travellerNames(t);
  if (names.length) nodes.push(el('p', { class: 'small', text: '👥 ' + names.join(', ') }));
  const ins = (t.bookings || []).find((b) => b.kind === 'insurance');
  if (ins && (ins.emergencyPhone || ins.policyNo)) {
    nodes.push(el('div', { class: 'state-note trip-emergency' }, el('strong', { text: '🆘 Emergency assistance' }),
      ins.emergencyPhone ? el('div', {}, el('a', { href: 'tel:' + ins.emergencyPhone.replace(/[^\d+]/g, ''), text: ins.emergencyPhone })) : null,
      ins.policyNo ? el('div', { class: 'small' }, `${ins.provider || 'Policy'}: `, copyRow('Policy number', ins.policyNo)) : null));
  }
  const checks = tripChecks(t, children(), today, { hasInsurance: annualTravelCover(t) });
  if (checks.length) {
    const list = el('ul', { class: 'trip-checks' });
    for (const c of checks) list.append(el('li', { class: c.level }, el('span', { text: c.text }), c.url ? el('a', { href: c.url, target: '_blank', rel: 'noopener', text: /nhs\.uk/.test(c.url) ? ' Apply on NHS.UK ›' : ' Check on GOV.UK ›' }) : null));
    nodes.push(el('h3', { class: 'sheet-h', text: 'Before you go' }), list,
      el('p', { class: 'muted small', text: 'Guidance only — always check GOV.UK travel advice for your destination before you travel.' }));
  }
  nodes.push(tripExtras(t));
  nodes.push(el('h3', { class: 'sheet-h', text: 'Bookings' }));
  const tl = timeline(t);
  if (!tl.length) nodes.push(el('p', { class: 'muted small', text: 'No bookings yet — add flights, hotels, car hire and insurance.' }));
  for (const b of tl) {
    const s = bookingSummary(b);
    const row = el('div', { class: 'booking' },
      el('span', { class: 'booking-ico', text: BOOKING_KINDS[b.kind]?.icon || '📌' }),
      el('div', { class: 'booking-main' }, el('div', { class: 'name', text: s.title }), s.sub ? el('div', { class: 'sub', text: s.sub }) : null,
        b.ref ? el('div', { class: 'small' }, 'Ref ', copyRow('Booking reference', b.ref)) : null,
        b.phone ? el('div', { class: 'small' }, el('a', { href: 'tel:' + b.phone.replace(/[^\d+]/g, ''), text: '📞 ' + b.phone })) : null,
        b.notes ? el('div', { class: 'sub', text: b.notes }) : null));
    const edit = el('button', { class: 'link', type: 'button', text: 'Edit' });
    edit.addEventListener('click', () => openBookingEditor(t.id, b));
    row.append(edit);
    nodes.push(row);
  }
  const addB = el('button', { type: 'button', text: '+ Add a booking' });
  addB.addEventListener('click', () => openBookingEditor(t.id));
  nodes.push(addB);
  nodes.push(el('h3', { class: 'sheet-h', text: 'Tickets & documents' }),
    filesStrip({ shared: true, get: () => trips().find((x) => x.id === id)?.files || [], save: (files) => { sharedUpdate(id, { files }); scheduleSync(); renderTravel(); } }));
  if (t.notes) nodes.push(el('h3', { class: 'sheet-h', text: 'Notes' }), el('p', { class: 'child-notes', text: t.notes }));
  const edit = el('button', { type: 'button', text: 'Edit trip' });
  edit.addEventListener('click', () => openTripEditor(t));
  const close = el('button', { class: 'primary', type: 'button', text: 'Close' });
  close.addEventListener('click', closeSheet);
  nodes.push(el('div', { class: 'row', style: 'margin-top:14px' }, edit, close));
  openSheet(...nodes);
}
function openTripEditor(trip) {
  const t = trip || {};
  const title = el('input', { type: 'text', placeholder: 'e.g. Mallorca half-term' }); title.value = t.title || '';
  const where = el('input', { type: 'text', placeholder: 'e.g. Spain (or Mallorca, Paris, Florida)' });
  where.value = (t.destinations || []).map((d) => d.country || countryName(d.iso)).join(', ');
  const start = el('input', { type: 'date' }); start.value = t.start || '';
  const end = el('input', { type: 'date' }); end.value = t.end || '';
  start.addEventListener('change', () => { if (!end.value || end.value < start.value) end.value = start.value; });
  const hint = el('p', { class: 'muted small', style: 'margin:-6px 0 8px' });
  const showHint = () => {
    const parts = where.value.split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = parts.filter((p) => !countryCode(p));
    hint.textContent = parts.length ? (unknown.length ? `Evergreen doesn't know ${unknown.join(', ')} — passport checks will use the cautious 6-month rule. Try the country's name.` : parts.map((p) => `${flag(countryCode(p))} ${countryName(countryCode(p), p)}`).join(', ')) : '';
  };
  where.addEventListener('input', showHint); showHint();
  const people = children();
  const chosen = new Set(t.travellers && t.travellers.length ? t.travellers : people.map((p) => p.id));
  const who = el('div', { class: 'trip-people' }, ...people.map((p) => {
    const cb = el('input', { type: 'checkbox' }); cb.checked = chosen.has(p.id);
    cb.addEventListener('change', () => (cb.checked ? chosen.add(p.id) : chosen.delete(p.id)));
    return el('label', { class: 'chip chip-check' }, cb, ' ' + p.name);
  }));
  const notes = el('textarea', { rows: '3', placeholder: 'e.g. Kennel booked for the dog; parking at Gatwick South' }); notes.value = t.notes || '';
  const save = el('button', { class: 'primary', type: 'button', text: trip ? 'Save' : 'Add trip' });
  save.addEventListener('click', () => {
    if (!title.value.trim()) { title.focus(); return toast('Give the trip a name.'); }
    if (!start.value) { start.focus(); return toast('Add the date you leave.'); }
    const destinations = where.value.split(',').map((s) => s.trim()).filter(Boolean).map((country) => ({ country, iso: countryCode(country) }));
    const data = { title: title.value.trim(), destinations, start: start.value, end: end.value || start.value, travellers: people.length && chosen.size === people.length ? [] : [...chosen], notes: notes.value.trim() };
    let id = t.id;
    if (trip) sharedUpdate(trip.id, data); else id = sharedAdd('trip', { ...data, bookings: [], files: [] });
    scheduleSync(); renderTravel(); renderCalendar(); renderHome(); haptic();
    toast(trip ? 'Trip saved ✓' : 'Trip added ✓');
    openTrip(id);
  });
  const cancel = el('button', { type: 'button', text: 'Cancel' });
  cancel.addEventListener('click', () => (trip ? openTrip(trip.id) : closeSheet()));
  const nodes = [el('h2', { text: trip ? 'Edit trip' : 'Add a trip' }),
    el('label', { class: 'field' }, 'Trip name', title),
    el('label', { class: 'field' }, 'Where to', where), hint,
    el('div', { class: 'grid2' }, el('label', { class: 'field' }, 'Leave', start), el('label', { class: 'field' }, 'Back', end)),
    people.length ? el('div', { class: 'field' }, "Who's going", who) : el('p', { class: 'muted small', text: 'Add everyone in Family (with passport dates) and Evergreen will check their passports for this trip.' }),
    el('label', { class: 'field' }, 'Notes', notes),
    el('div', { class: 'row' }, cancel, save)];
  if (trip) {
    const del = el('button', { class: 'link', type: 'button', style: 'color:var(--urgent, #c0392b);margin-top:8px', text: 'Delete this trip' });
    del.addEventListener('click', () => {
      if (!confirm(`Delete “${t.title}”, its bookings and files from both phones?`)) return;
      sharedRemove(trip.id); dropFiles(t.files || []); scheduleSync(); renderTravel(); renderCalendar(); renderHome(); closeSheet();
      toast('Trip deleted');
    });
    nodes.push(del);
  }
  openSheet(...nodes);
}
const BOOKING_FIELDS = {
  flight: [['airline', 'Airline', 'text', 'e.g. British Airways'], ['flightNo', 'Flight number', 'text', 'e.g. BA2650'], ['from', 'From (airport)', 'text', 'e.g. LGW'], ['to', 'To (airport)', 'text', 'e.g. PMI'], ['depart', 'Departs (local time)', 'datetime-local'], ['arrive', 'Lands (local time)', 'datetime-local'], ['ref', 'Booking reference', 'text'], ['seats', 'Seats', 'text', 'e.g. 12A, 12B'], ['bags', 'Bags', 'text', 'e.g. 2 × 23 kg hold']],
  stay: [['name', 'Hotel / place', 'text'], ['address', 'Address', 'text'], ['checkIn', 'Check in', 'datetime-local'], ['checkOut', 'Check out', 'datetime-local'], ['ref', 'Booking reference', 'text'], ['phone', 'Phone', 'tel']],
  car: [['company', 'Company', 'text', 'e.g. Hertz'], ['pickUpPlace', 'Collect from', 'text'], ['pickUp', 'Collect', 'datetime-local'], ['dropOffPlace', 'Return to', 'text'], ['dropOff', 'Return', 'datetime-local'], ['ref', 'Booking reference', 'text'], ['phone', 'Phone', 'tel']],
  transport: [['mode', 'Type', 'text', 'e.g. train, ferry, transfer'], ['operator', 'Operator', 'text', 'e.g. Eurostar'], ['from', 'From', 'text'], ['to', 'To', 'text'], ['depart', 'Departs', 'datetime-local'], ['arrive', 'Arrives', 'datetime-local'], ['ref', 'Booking reference', 'text']],
  insurance: [['provider', 'Insurer', 'text'], ['policyNo', 'Policy number', 'text'], ['emergencyPhone', '24-hour emergency number', 'tel'], ['coverFrom', 'Cover from', 'date'], ['coverTo', 'Cover to', 'date']],
  other: [['title', 'What', 'text', 'e.g. Theme park tickets'], ['depart', 'When', 'datetime-local'], ['ref', 'Reference', 'text']],
};
function openBookingEditor(tripId, booking) {
  const b = booking || {};
  const kind = el('select', {}, ...Object.entries(BOOKING_KINDS).map(([k, v]) => el('option', { value: k, text: `${v.icon} ${v.label}` })));
  kind.value = b.kind || 'flight';
  const box = el('div', {});
  const inputs = {};
  const draw = () => {
    box.replaceChildren();
    for (const k of Object.keys(inputs)) delete inputs[k];
    for (const [k, label, type, ph] of BOOKING_FIELDS[kind.value]) {
      const input = el('input', { type, autocomplete: 'off', ...(ph ? { placeholder: ph } : {}) });
      input.value = b[k] || '';
      inputs[k] = input;
      box.append(el('label', { class: 'field' }, label, input));
    }
  };
  kind.addEventListener('change', draw); draw();
  const notes = el('textarea', { rows: '2', placeholder: 'optional' }); notes.value = b.notes || '';
  const save = el('button', { class: 'primary', type: 'button', text: booking ? 'Save' : 'Add' });
  save.addEventListener('click', () => {
    const t = trips().find((x) => x.id === tripId);
    if (!t) return closeSheet();
    const data = { id: b.id || 'b' + uid(), kind: kind.value, notes: notes.value.trim() };
    for (const [k, input] of Object.entries(inputs)) data[k] = input.value.trim();
    if (data.flightNo) data.flightNo = data.flightNo.toUpperCase().replace(/\s+/g, '');
    for (const k of ['from', 'to']) if (kind.value === 'flight' && data[k]) data[k] = data[k].toUpperCase();
    const bookings = (t.bookings || []).filter((x) => x.id !== data.id).concat(data);
    sharedUpdate(tripId, { bookings });
    scheduleSync(); renderTravel(); renderCalendar(); renderHome(); haptic();
    toast(booking ? 'Booking saved ✓' : 'Booking added ✓');
    openTrip(tripId);
  });
  const cancel = el('button', { type: 'button', text: 'Cancel' });
  cancel.addEventListener('click', () => openTrip(tripId));
  const nodes = [el('h2', { text: booking ? 'Edit booking' : 'Add a booking' }), el('label', { class: 'field' }, 'Type', kind), box,
    el('label', { class: 'field' }, 'Notes', notes), el('div', { class: 'row' }, cancel, save)];
  if (booking) {
    const del = el('button', { class: 'link', type: 'button', style: 'color:var(--urgent, #c0392b);margin-top:8px', text: 'Remove this booking' });
    del.addEventListener('click', () => {
      const t = trips().find((x) => x.id === tripId);
      if (t) sharedUpdate(tripId, { bookings: (t.bookings || []).filter((x) => x.id !== b.id) });
      scheduleSync(); renderTravel(); renderCalendar(); renderHome(); openTrip(tripId); toast('Booking removed');
    });
    nodes.push(del);
  }
  openSheet(...nodes);
}
// Quick import: trips first, then each booking joins the trip its dates fall in (or starts a new one).
function importTravel(r, addedShared, addedBookings) {
  for (const row of r.trips) {
    if (!row.start) continue;
    const dup = trips().find((t) => t.start === row.start && (t.title || '').toLowerCase() === (row.title || '').toLowerCase());
    if (dup) continue;
    const iso = countryCode(row.country || row.title);
    addedShared.push(sharedAdd('trip', { title: row.title || 'Trip', destinations: row.country || iso ? [{ country: row.country || countryName(iso), iso }] : [], start: row.start, end: row.end || row.start, travellers: [], notes: '', bookings: [], files: [] }));
  }
  const bookingKey = (b) => [b.kind, b.ref, b.flightNo, b.name, b.provider, b.depart || b.checkIn || b.pickUp || b.coverFrom].map((x) => (x || '').toLowerCase()).join('|');
  for (const b of r.bookings) {
    const start = (b.depart || b.checkIn || b.pickUp || b.coverFrom || '').slice(0, 10);
    const finish = (b.arrive || b.checkOut || b.dropOff || b.coverTo || start).slice(0, 10);
    if (!start) continue;
    let t = matchTrip(trips(), start);
    if (!t) {
      const place = b.kind === 'flight' ? b.to : b.kind === 'stay' ? b.address || b.name : b.to || '';
      const iso = countryCode(place || '');
      const id = sharedAdd('trip', { title: `Trip${iso ? ' to ' + countryName(iso) : place ? ' to ' + place : ''}`, destinations: iso ? [{ country: countryName(iso), iso }] : [], start, end: finish || start, travellers: [], notes: '', bookings: [], files: [] });
      addedShared.push(id);
      t = trips().find((x) => x.id === id);
    }
    if ((t.bookings || []).some((x) => bookingKey(x) === bookingKey(b))) continue;
    const booking = { ...b, id: 'b' + uid() };
    const patch = { bookings: [...(t.bookings || []), booking] };
    if (finish && finish > (t.end || '')) patch.end = finish;
    if (start < (t.start || '9')) patch.start = start;
    sharedUpdate(t.id, patch);
    addedBookings.push({ tripId: t.id, bookingId: booking.id });
  }
}
$('btn-trip-add')?.addEventListener('click', () => openTripEditor());

// ---------- public information via your sync server (nothing personal is sent) ----------
async function info(kind, params = {}) {
  if (!paired()) throw new Error('This uses your sync server — set up Settings → Sharing first.');
  const s = settings();
  const q = new URLSearchParams({ h: await householdId(s.householdCode), ...params });
  const res = await fetch(`${s.syncUrl.replace(/\/+$/, '')}/info/${kind}?${q}`, { cache: 'no-store', headers: { 'X-Evergreen-Token': await writeToken(s.householdCode) } });
  let body = {};
  try { body = await res.json(); } catch { /* not json */ }
  if (res.status === 404 && !body.error) throw new Error('Your sync server needs updating — it updates itself within a few minutes of an app update.');
  if (!res.ok) throw new Error(body.error === 'bad id' ? 'your sync server needs updating' : body.error || `the server returned ${res.status}`);
  return body;
}
/** Cached on this phone so screens draw instantly; refreshed in the background when older than maxAgeMs. */
const infoFailed = new Map(); // key -> when it last failed, so a broken service isn't asked on every redraw
const infoInflight = new Map(); // key -> the request already on its way
function infoCached(key, maxAgeMs, load) {
  const hit = (settings().infoCache || {})[key];
  const failedRecently = Date.now() - (infoFailed.get(key) || 0) < 10 * 60000;
  const fresh = (hit && Date.now() - hit.at < maxAgeMs) || failedRecently || infoInflight.has(key);
  const refresh = () => {
    if (infoInflight.has(key)) return infoInflight.get(key);
    if (failedRecently) return Promise.reject(new Error('Not available just now — try again in a few minutes.'));
    const p = load().then((value) => {
      const all = settings().infoCache || {};
      for (const [k, v] of Object.entries(all)) if (Date.now() - v.at > 30 * 86400000) delete all[k]; // keep it small
      all[key] = { at: Date.now(), value };
      saveSettings({ infoCache: all });
      return value;
    }, (e) => { infoFailed.set(key, Date.now()); throw e; }).finally(() => infoInflight.delete(key));
    infoInflight.set(key, p);
    return p;
  };
  return { value: hit ? hit.value : null, fresh, refresh };
}

// ----- energy comparison (worked out on this phone, from your own usage) -----
const pence = (v) => (v == null || v === '' ? '' : `${Number(v).toLocaleString('en-GB', { maximumFractionDigits: 2 })}p`);
function energyUsage(u) {
  const fuels = u.type === 'Electricity' ? ['elec'] : u.type === 'Gas' ? ['gas'] : ['elec', 'gas'];
  const out = {}; const how = {};
  const readings = { elec: sharedItems('meter').filter((r) => r.kind === 'Electricity'), gas: sharedItems('meter').filter((r) => r.kind === 'Gas') };
  for (const f of fuels) {
    const typed = Number((u.energy || {})[f + 'Kwh']);
    const fromReadings = yearlyFromReadings(readings[f], f);
    if (typed > 0) { out[f] = typed; how[f] = 'from your bill'; }
    else if (fromReadings) { out[f] = fromReadings.kwh; how[f] = `from your meter readings${fromReadings.rough ? ' (rough — under a year of readings)' : ''}`; }
    else { out[f] = TYPICAL[f]; how[f] = 'a typical home — add your yearly kWh from a bill for a true figure'; }
  }
  return { usage: out, how };
}
function openEnergyCompare(utilId) {
  const u = utilities().find((x) => x.id === utilId);
  if (!u) return;
  const e = u.energy || {};
  const fuels = u.type === 'Electricity' ? ['elec'] : u.type === 'Gas' ? ['gas'] : ['elec', 'gas'];
  const NAME = { elec: 'Electricity', gas: 'Gas' };
  const inputs = {};
  const numIn = (key, ph) => { const i = el('input', { type: 'number', inputmode: 'decimal', step: 'any', placeholder: ph }); i.value = e[key] ?? ''; inputs[key] = i; return i; };
  const rateRows = fuels.map((f) => el('div', {}, el('div', { class: 'child-group', text: NAME[f] }),
    el('div', { class: 'grid2' }, el('label', { class: 'field' }, 'Unit rate (p/kWh)', numIn(f + 'Unit', f === 'elec' ? 'e.g. 24.5' : 'e.g. 6.8')),
      el('label', { class: 'field' }, 'Standing charge (p/day)', numIn(f + 'Standing', f === 'elec' ? 'e.g. 53.4' : 'e.g. 31.2'))),
    el('label', { class: 'field' }, 'Yearly use (kWh) — on your bill as “annual consumption”', numIn(f + 'Kwh', 'optional'))));
  const region = el('select', {}, el('option', { value: '', text: 'Choose your region…' }), ...REGIONS.map(([v, n]) => el('option', { value: v, text: n })));
  region.value = e.region || '';
  const out = el('div', {});
  const save = () => {
    const energy = { ...e, region: region.value };
    for (const [k, i] of Object.entries(inputs)) energy[k] = i.value === '' ? '' : Number(i.value);
    sharedUpdate(u.id, { energy }); scheduleSync();
    return energy;
  };
  const run = async () => {
    const energy = save();
    const current = {};
    for (const f of fuels) if (energy[f + 'Unit'] !== '' && energy[f + 'Unit'] != null) current[f] = { unit: energy[f + 'Unit'], standing: energy[f + 'Standing'] || 0 };
    const { usage, how } = energyUsage({ ...u, energy });
    out.replaceChildren(el('p', { class: 'muted small', text: 'Working it out…' }));
    const today = todayISO();
    const cap = capFor(today), next = nextCap(today);
    const options = [{ name: `Standard variable (price cap, ${cap.label})`, supplier: 'Any supplier’s default tariff', elec: cap.elec, gas: cap.gas, source: 'cap' }];
    if (next) options.push({ name: `Price cap from ${new Date(next.from + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}`, supplier: 'If you go onto (or stay on) a standard tariff', elec: next.elec, gas: next.gas, source: 'cap' });
    for (const q of e.quotes || []) options.push({ ...q, source: 'quote' });
    let note = '';
    if (energy.region) {
      try {
        const r = await info('energy', { region: energy.region });
        for (const t of r.tariffs || []) options.push({ name: t.name, supplier: 'Octopus Energy', elec: t.elec, gas: t.gas, source: 'octopus', fixed: t.fixed, term: t.term });
      } catch (err) { note = `Couldn't load live tariffs: ${err.message}`; }
    } else note = 'Choose your region to include live tariffs too.';
    const haveCurrent = Object.keys(current).length === fuels.length;
    const mine = haveCurrent ? tariffCost(current, usage) : null;
    const rows = compareTariffs(haveCurrent ? current : { elec: cap.elec, gas: cap.gas }, options, usage);
    const nodes = [];
    nodes.push(el('div', { class: 'state-note' },
      el('div', {}, el('strong', { text: haveCurrent ? `Your deal now: ${money(mine)} a year` : 'Add your current rates above to see what you’d save' })),
      el('div', { class: 'muted small', text: fuels.map((f) => `${NAME[f]} ${Math.round(usage[f]).toLocaleString('en-GB')} kWh/yr — ${how[f]}`).join(' · ') })));
    const list = el('ul', { class: 'list energy-list' });
    for (const r of rows) {
      const tag = r.saving == null || !haveCurrent ? null : r.saving > 1 ? el('span', { class: 'tag ok', text: `save ${money(r.saving)}/yr` }) : r.saving < -1 ? el('span', { class: 'tag dim', text: `${money(-r.saving)}/yr more` }) : el('span', { class: 'tag dim', text: 'about the same' });
      const detail = [r.supplier, r.fixed === true ? (r.term ? `${r.term}-month fix` : 'fixed') : r.source === 'octopus' ? 'variable' : '', ...fuels.filter((f) => r[f]).map((f) => `${NAME[f].toLowerCase()} ${pence(r[f].unit)} + ${pence(r[f].standing)}/day`)].filter(Boolean).join(' · ');
      const li = el('li', {}, el('div', { class: 'line' }, el('div', {}, el('div', { class: 'name', text: `${r.name} — ${money(r.cost)}/yr` }), el('div', { class: 'sub', text: detail })), tag));
      if (r.source === 'quote') {
        const del = el('button', { class: 'del', text: '✕', 'aria-label': 'Remove quote ' + r.name });
        del.addEventListener('click', () => { sharedUpdate(u.id, { energy: { ...(utilities().find((x) => x.id === u.id).energy || {}), quotes: (e.quotes || []).filter((x) => x.id !== r.id) } }); scheduleSync(); openEnergyCompare(u.id); });
        li.querySelector('.line').append(del);
      }
      list.append(li);
    }
    nodes.push(list);
    if (note) nodes.push(el('p', { class: 'muted small', text: note }));
    nodes.push(el('p', { class: 'muted small', text: 'Live tariffs come from Octopus, the one big supplier that publishes its prices. For everyone else, add any quote you’re given below, or compare on a switching site and add the best one here — Evergreen prices it against your real usage. Guidance only; check exit fees before switching.' }));
    out.replaceChildren(...nodes);
  };
  // add a quote (from a comparison site, a supplier, or Claude's renewal check)
  const qName = el('input', { type: 'text', placeholder: 'e.g. EDF 12-month fix' });
  const qIn = {};
  const qRows = fuels.map((f) => el('div', { class: 'grid2' },
    el('label', { class: 'field' }, `${NAME[f]} p/kWh`, (qIn[f + 'u'] = el('input', { type: 'number', inputmode: 'decimal', step: 'any' }))),
    el('label', { class: 'field' }, `${NAME[f]} p/day`, (qIn[f + 's'] = el('input', { type: 'number', inputmode: 'decimal', step: 'any' })))));
  const qAdd = el('button', { type: 'button', text: 'Add this quote' });
  qAdd.addEventListener('click', () => {
    if (!qName.value.trim()) return toast('Name the quote first.');
    const q = { id: 'q' + uid(), name: qName.value.trim() };
    for (const f of fuels) if (qIn[f + 'u'].value) q[f] = { unit: Number(qIn[f + 'u'].value), standing: Number(qIn[f + 's'].value) || 0 };
    if (!fuels.every((f) => q[f])) return toast('Add the unit rate for each fuel.');
    const cur = utilities().find((x) => x.id === u.id).energy || {};
    sharedUpdate(u.id, { energy: { ...cur, quotes: [...(cur.quotes || []), q] } }); scheduleSync();
    toast('Quote added ✓'); openEnergyCompare(u.id);
  });
  const go = el('button', { class: 'primary', type: 'button', text: 'Compare' });
  go.addEventListener('click', run);
  const close = el('button', { type: 'button', text: 'Close' });
  close.addEventListener('click', () => { save(); closeSheet(); renderUtilities(); });
  openSheet(el('h2', { text: `Compare ${u.type.toLowerCase()} deals` }),
    el('p', { class: 'muted small', text: 'Your rates are on your bill or in your supplier’s app (include VAT). Everything is worked out on this phone — only your region is used to fetch public tariffs.' }),
    ...rateRows, el('label', { class: 'field' }, 'Region', region),
    el('div', { class: 'row' }, close, go), out,
    el('details', { class: 'inner' }, el('summary', { text: '+ Add a quote you’ve been given' }), el('label', { class: 'field' }, 'Name', qName), ...qRows, qAdd));
  if ((e.elecUnit || e.gasUnit) && region.value) run();
}

// ----- trains (National Rail live departures) -----
const STATIONS = [
  ['EUS', 'London Euston'], ['WFJ', 'Watford Junction'], ['MKC', 'Milton Keynes Central'], ['BLY', 'Bletchley'], ['LBZ', 'Leighton Buzzard'],
  ['TRI', 'Tring'], ['BKM', 'Berkhamsted'], ['HML', 'Hemel Hempstead'], ['APS', 'Apsley'], ['KGL', 'Kings Langley'], ['BSH', 'Bushey'],
  ['HRW', 'Harrow & Wealdstone'], ['WMB', 'Wembley Central'], ['NMP', 'Northampton'], ['RUG', 'Rugby'], ['COV', 'Coventry'],
  ['BHI', 'Birmingham International'], ['BHM', 'Birmingham New Street'], ['WVH', 'Wolverhampton'], ['NUN', 'Nuneaton'], ['TAM', 'Tamworth'],
  ['LTV', 'Lichfield Trent Valley'], ['STA', 'Stafford'], ['SOT', 'Stoke-on-Trent'], ['CRE', 'Crewe'], ['MAN', 'Manchester Piccadilly'],
  ['WBQ', 'Warrington Bank Quay'], ['WGN', 'Wigan North Western'], ['PRE', 'Preston'], ['LAN', 'Lancaster'], ['LIV', 'Liverpool Lime Street'],
  ['CTR', 'Chester'], ['GLC', 'Glasgow Central'],
];
const stationName = (crs) => (STATIONS.find(([c]) => c === crs) || [])[1] || crs;
let trainTimer = null;
function trainRow(s) {
  const status = s.cancelled ? el('span', { class: 'tag urgent', text: 'Cancelled' })
    : s.late ? el('span', { class: 'tag soon', text: /^\d/.test(s.expected) ? `Exp ${s.expected}` : 'Delayed' })
      : el('span', { class: 'tag ok', text: 'On time' });
  return el('li', { class: 'train' + (s.cancelled ? ' cancelled' : '') },
    el('div', { class: 'line' },
      el('div', {}, el('div', { class: 'name' }, el('span', { class: 'train-time', text: s.due }), ` ${s.to || ''}`),
        el('div', { class: 'sub', text: [s.platform ? `Platform ${s.platform}` : 'Platform not yet shown', s.operator].filter(Boolean).join(' · ') }),
        s.reason ? el('div', { class: 'sub train-reason', text: s.reason.charAt(0).toUpperCase() + s.reason.slice(1) }) : null),
      status));
}
async function renderTrains() {
  const out = $('train-boards');
  if (!out) return;
  const s = settings();
  $('train-home').value = s.trainHome || '';
  $('train-other-wrap').hidden = $('train-home').value !== 'other';
  const home = s.trainHome === 'other' ? (s.trainOther || '').toUpperCase() : s.trainHome;
  if (!home) { out.replaceChildren(el('p', { class: 'muted small', text: 'Choose your station above to see live trains to and from London Euston.' })); return; }
  if (!paired()) { out.replaceChildren(el('p', { class: 'muted small', text: 'Live trains come through your sync server — set up Settings → Sharing first.' })); return; }
  const boards = [{ title: `${stationName(home)} → London Euston`, from: home, to: 'EUS' }, { title: `London Euston → ${stationName(home)}`, from: 'EUS', to: home }];
  if (!out.children.length) out.replaceChildren(el('p', { class: 'muted small', text: 'Loading live trains…' }));
  const results = await Promise.all(boards.map((b) => info('trains', { from: b.from, to: b.to }).catch((e) => ({ error: e.message }))));
  if (results.some((r) => r.configured === false)) {
    out.replaceChildren(el('div', { class: 'state-note' }, el('strong', { text: 'One-off setup needed' }),
      el('p', { class: 'small', text: 'Live trains use the official National Rail feed, which needs a free key. See Help → Live trains for the 5-minute setup.' })));
    return;
  }
  const nodes = [];
  const msgs = [...new Set(results.flatMap((r) => r.messages || []))];
  if (msgs.length) nodes.push(el('div', { class: 'state-note train-msg' }, el('strong', { text: '⚠️ Disruption' }), ...msgs.slice(0, 3).map((m) => el('p', { class: 'small', text: m }))));
  boards.forEach((b, i) => {
    const r = results[i];
    const card = el('div', { class: 'card' }, el('h2', { text: b.title }));
    if (r.error) card.append(el('p', { class: 'status bad', text: r.error }));
    else if (!r.services?.length) card.append(el('p', { class: 'muted small', text: 'No direct trains in the next two hours.' }));
    else card.append(el('ul', { class: 'list' }, ...r.services.slice(0, 6).map(trainRow)));
    nodes.push(card);
  });
  nodes.push(el('p', { class: 'muted small', text: `Updated ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} · refreshes every minute while open · National Rail Enquiries` }));
  out.replaceChildren(...nodes);
  const bad = results.flatMap((r) => r.services || []).filter((x) => x.cancelled || x.late).length;
  saveSettings({ trainBad: { n: bad, at: Date.now() } });
}
function trainsVisible() { return !$('train-boards')?.classList.contains('sec-off') && $('tab-life')?.classList.contains('active'); }
function startTrainRefresh() {
  clearInterval(trainTimer);
  trainTimer = setInterval(() => { if (document.visibilityState === 'visible' && trainsVisible()) renderTrains(); else clearInterval(trainTimer); }, 60000);
}
$('train-home')?.addEventListener('change', (e) => { saveSettings({ trainHome: e.target.value }); $('train-boards').replaceChildren(); renderTrains(); });
$('train-other')?.addEventListener('change', (e) => { saveSettings({ trainOther: e.target.value.trim().toUpperCase() }); $('train-boards').replaceChildren(); renderTrains(); });
$('btn-train-refresh')?.addEventListener('click', () => { renderTrains(); haptic(); });

// ----- bank holidays (GOV.UK) in the family calendar -----
function bankHolidayRows(fromISO, toISO) {
  const c = infoCached('bankhols', 7 * 86400000, () => info('bankholidays'));
  if (!c.fresh && paired()) c.refresh().then(() => renderCalendar()).catch(() => {});
  return ((c.value && c.value.events) || []).filter((e) => e.date >= fromISO && e.date <= toISO)
    .map((e) => ({ id: 'bh-' + e.date, title: `🇬🇧 ${e.title}`, date: e.date, time: '', who: 'Bank holiday', virtual: true }));
}


// ----- weather at home (Open-Meteo forecast, Met Office warnings) -----
const WX_TEXT = (c) => (c === 0 ? 'Clear' : c <= 2 ? 'Partly cloudy' : c === 3 ? 'Cloudy' : c <= 48 ? 'Fog' : c <= 57 ? 'Drizzle' : c <= 67 ? 'Rain' : c <= 77 ? 'Snow' : c <= 82 ? 'Showers' : c <= 86 ? 'Snow showers' : 'Thunderstorms');
const localNowISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
function weatherCard() {
  if (!paired()) return null;
  const place = (settings().weatherPlace || 'Berkhamsted').trim();
  const c = infoCached('hw:' + place.toLowerCase(), 30 * 60000, () => info('home-weather', { place }));
  if (!c.fresh) c.refresh().then(() => renderDashboard()).catch(() => {});
  const w = c.value;
  if (!w || w.error || !w.now) return null;
  const card = el('div', { class: 'card weather-card' });
  const change = el('button', { class: 'link', type: 'button', text: 'Change' });
  change.addEventListener('click', () => {
    const v = prompt('Town for the weather (UK):', place);
    if (v && v.trim()) { saveSettings({ weatherPlace: v.trim() }); renderDashboard(); }
  });
  card.append(el('div', { class: 'line' },
    el('div', {}, el('div', { class: 'wx-now' }, el('span', { class: 'wx-big', text: WX(w.now.code) }), el('span', { class: 'wx-temp', text: `${Math.round(w.now.temp)}°` }),
      el('span', { class: 'muted small', text: ` feels ${Math.round(w.now.feels)}°` })),
    el('div', { class: 'sub', text: `${w.place} · ${WX_TEXT(w.now.code)} · wind ${Math.round(w.now.wind)} mph${w.now.gusts > 30 ? `, gusts ${Math.round(w.now.gusts)}` : ''}` })), change));
  const nowISO = localNowISO();
  const next = (w.hours || []).filter((h) => h.t >= nowISO.slice(0, 13)).slice(0, 12);
  const wet = next.find((h) => h.rain >= 50);
  const today = (w.days || [])[0];
  const bits = [];
  if (today) bits.push(`High ${Math.round(today.max)}° · low ${Math.round(today.min)}°`);
  bits.push(wet ? `☔ Rain likely ${wet.t.slice(11, 13) === nowISO.slice(11, 13) ? 'now' : 'from ' + wet.t.slice(11, 16)} (${wet.rain}%)` : next.length ? 'Dry for the next 12 hours' : '');
  if (today && today.sunset) bits.push(`sunset ${today.sunset.slice(11, 16)}`);
  if (today && today.uv >= 5) bits.push(`UV ${Math.round(today.uv)} — suncream`);
  card.append(el('p', { class: 'small', style: 'margin:8px 0', text: bits.filter(Boolean).join(' · ') }));
  card.append(el('div', { class: 'wx-row' }, ...(w.days || []).slice(1, 6).map((d) => el('div', { class: 'wx-day' },
    el('div', { class: 'muted small', text: new Date(d.date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short' }) }),
    el('div', { class: 'wx-ico', text: WX(d.code) }), el('div', { class: 'small', text: `${Math.round(d.max)}° / ${Math.round(d.min)}°` }),
    d.rain != null ? el('div', { class: 'muted small', text: `💧${d.rain}%` }) : null))));
  // Met Office warnings for your county / region
  const terms = [w.county, w.region].filter(Boolean);
  if (terms.length) {
    const wc = infoCached('warn:' + terms.join('|').toLowerCase(), 15 * 60000, () => info('warnings', { terms: terms.join('|') }));
    if (!wc.fresh) wc.refresh().then(() => renderDashboard()).catch(() => {});
    for (const x of (wc.value && wc.value.warnings) || []) {
      card.append(el('a', { class: `wx-warn ${x.level}`, href: x.link || 'https://www.metoffice.gov.uk/weather/warnings-and-advice/uk-warnings', target: '_blank', rel: 'noopener' },
        el('strong', { text: `⚠️ ${x.title}` }), x.text ? el('div', { class: 'small', text: x.text.length > 160 ? x.text.slice(0, 157) + '…' : x.text }) : null));
    }
  }
  card.append(el('div', { class: 'muted small', style: 'margin-top:6px', text: 'Forecast: Open-Meteo (Met Office data) · Warnings: Met Office' }));
  return card;
}

// ----- trips: weather, travel advice changes, currency -----
const CURRENCY = { US: 'USD', TR: 'TRY', CH: 'CHF', CZ: 'CZK', HU: 'HUF', PL: 'PLN', DK: 'DKK', NO: 'NOK', SE: 'SEK', IS: 'ISK', RO: 'RON', CA: 'CAD', AU: 'AUD', NZ: 'NZD', JP: 'JPY', ZA: 'ZAR', MX: 'MXN', IN: 'INR', TH: 'THB' };
const EURO = ['AT', 'BE', 'BG', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK'];
const currencyOf = (iso) => (EURO.includes(iso) ? 'EUR' : CURRENCY[iso] || '');
const WX = (c) => (c === 0 ? '☀️' : c <= 2 ? '🌤️' : c === 3 ? '☁️' : c <= 48 ? '🌫️' : c <= 67 ? '🌧️' : c <= 77 ? '🌨️' : c <= 82 ? '🌦️' : c <= 86 ? '🌨️' : '⛈️');
function tripPlace(t) {
  const flight = timeline(t).find((b) => b.kind === 'flight' && b.to);
  const stay = (t.bookings || []).find((b) => b.kind === 'stay' && b.address);
  const d = (t.destinations || [])[0];
  return (d && d.country && !/^[A-Z]{2}$/.test(d.country) ? d.country : '') || (stay && stay.address.split(',').pop().trim()) || (d && countryName(d.iso)) || (flight && flight.to) || '';
}
/** Extra live panels for a trip sheet. Fills in as answers arrive. */
function tripExtras(t) {
  const box = el('div', {});
  if (!paired()) return box;
  const today = todayISO();
  const until = daysBetween(today, t.start || today);
  const iso = (t.destinations || [])[0]?.iso;
  // Travel advice
  const slug = adviceSlug(iso);
  if (slug) {
    const adv = el('div', {}, el('h3', { class: 'sheet-h', text: 'GOV.UK travel advice' }));
    box.append(adv);
    const draw = (a) => {
      if (!a || a.error) return;
      const seen = (settings().adviceSeen || {})[t.id + ':' + slug];
      const isNew = seen && seen !== a.updated;
      adv.append(el('p', { class: 'small' }, isNew ? el('span', { class: 'tag soon', text: 'Updated', style: 'margin-right:6px' }) : null,
        `Last updated ${new Date(a.updated).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}: ${a.change || 'see GOV.UK'} `, el('a', { href: a.url, target: '_blank', rel: 'noopener', text: 'Read ›' })));
      if (a.alert && a.alert.length) adv.append(el('p', { class: 'status bad', text: 'The FCDO has warnings in place for parts of this country — read the advice before you go.' }));
      saveSettings({ adviceSeen: { ...(settings().adviceSeen || {}), [t.id + ':' + slug]: a.updated } });
    };
    const c = infoCached('advice:' + slug, 3 * 3600000, () => info('advice', { country: slug }));
    if (c.value) draw(c.value); else c.refresh().then(draw).catch(() => adv.remove());
  }
  // Weather: the forecast covers about 16 days ahead
  const place = tripPlace(t);
  if (place && until <= 15 && t.end >= today) {
    const wx = el('div', {}, el('h3', { class: 'sheet-h', text: 'Weather' }));
    box.append(wx);
    const wc = infoCached('wx:' + place.toLowerCase(), 3 * 3600000, () => info('weather', { place }));
    (wc.value && wc.fresh ? Promise.resolve(wc.value) : wc.refresh()).then((w) => {
      const days = (w.days || []).filter((d) => d.date >= t.start && d.date <= t.end);
      if (!days.length) return wx.remove();
      wx.append(el('div', { class: 'wx-row' }, ...days.slice(0, 10).map((d) => el('div', { class: 'wx-day' },
        el('div', { class: 'muted small', text: new Date(d.date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' }) }),
        el('div', { class: 'wx-ico', text: WX(d.code) }), el('div', { class: 'small', text: `${Math.round(d.max)}° / ${Math.round(d.min)}°` }),
        d.rain != null ? el('div', { class: 'muted small', text: `💧${d.rain}%` }) : null))),
      el('p', { class: 'muted small', text: `${w.place} · Open-Meteo forecast` }));
    }).catch(() => wx.remove());
  }
  // Money
  const cur = currencyOf(iso);
  if (cur && t.end >= today) {
    const fx = el('p', { class: 'small' });
    box.append(fx);
    const fc = infoCached('fx:' + cur, 6 * 3600000, () => info('fx', { currency: cur }));
    (fc.value && fc.fresh ? Promise.resolve(fc.value) : fc.refresh()).then((r) => { if (r.rate) fx.textContent = `💷 £1 = ${r.rate.toLocaleString('en-GB', { maximumFractionDigits: 2 })} ${cur} (European Central Bank rate, ${fmtDate(r.date)}) · £100 ≈ ${Math.round(r.rate * 100).toLocaleString('en-GB')} ${cur}`; }).catch(() => fx.remove());
  }
  return box;
}
/** Home reminder when GOV.UK changes its advice for somewhere you're going. */
function adviceReminders() {
  const items = [];
  const today = todayISO();
  for (const t of trips()) {
    if (!t.start || t.end < today || daysBetween(today, t.start) > 90) continue;
    const slug = adviceSlug((t.destinations || [])[0]?.iso);
    if (!slug) continue;
    const c = infoCached('advice:' + slug, 6 * 3600000, () => info('advice', { country: slug }));
    if (!c.fresh && paired()) c.refresh().then(() => renderDashboard()).catch(() => {});
    const a = c.value;
    if (!a || !a.updated) continue;
    const key = t.id + ':' + slug;
    const seen = (settings().adviceSeen || {})[key];
    if (!seen) { saveSettings({ adviceSeen: { ...(settings().adviceSeen || {}), [key]: a.updated } }); continue; } // first look sets the baseline
    if (seen !== a.updated) items.push({ label: `Travel advice changed — ${countryName((t.destinations || [])[0]?.iso, 'your destination')}`, sub: `Travel · ${a.change || 'GOV.UK updated its advice'}`, days: Math.max(0, daysBetween(today, t.start)), level: 'soon', text: 'read', go: () => openTrip(t.id) });
  }
  return items;
}

// ----- Companies House: your company's filing deadlines (Money & tax) -----
const addMonthsISO = (iso, n, plusDays = 0) => { const d = new Date(iso + 'T00:00:00Z'); const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate())); d.setUTCDate(d.getUTCDate() + plusDays); return d.toISOString().slice(0, 10); };
function companyDeadlines() {
  const num = (settings().companyNumber || '').trim();
  if (!num) return [];
  const c = infoCached('company:' + num, 24 * 3600000, () => info('company', { number: num }));
  if (!c.fresh && paired()) c.refresh().then(() => { renderDashboard(); renderCompany(); }).catch(() => {});
  const v = c.value;
  if (!v || !v.configured || v.error) return [];
  const out = [];
  if (v.confirmationDue) out.push({ date: v.confirmationDue, label: 'Confirmation statement', sub: 'Companies House' });
  if (v.accountsDue) out.push({ date: v.accountsDue, label: 'Company accounts to Companies House', sub: 'Companies House' });
  if (v.accountsMadeUpTo) {
    // Corporation Tax (guidance): pay 9 months + 1 day after the period ends; file the CT600 within 12 months.
    out.push({ date: addMonthsISO(v.accountsMadeUpTo, 9, 1), label: 'Corporation Tax payment', sub: 'HMRC (company)' });
    out.push({ date: addMonthsISO(v.accountsMadeUpTo, 12), label: 'Company tax return (CT600)', sub: 'HMRC (company)' });
  }
  return out;
}
function renderCompany() {
  const out = $('company-out');
  if (!out) return;
  const num = (settings().companyNumber || '').trim();
  $('company-number').value = num;
  if (!num) { out.replaceChildren(); return; }
  const c = infoCached('company:' + num, 24 * 3600000, () => info('company', { number: num }));
  const v = c.value;
  if (!v) { out.replaceChildren(el('p', { class: 'muted small', text: paired() ? 'Checking Companies House…' : 'This uses your sync server — set up Settings → Sharing first.' })); if (paired()) c.refresh().then(renderCompany).catch((e) => setStatus('company-status', e.message, true)); return; }
  if (v.configured === false) { out.replaceChildren(el('p', { class: 'muted small', text: 'Needs a free Companies House key on your sync server — see Help → Company deadlines.' })); return; }
  if (v.error) { out.replaceChildren(el('p', { class: 'status bad', text: v.error })); return; }
  const list = el('ul', { class: 'list' });
  for (const d of companyDeadlines()) {
    const cd = countdown(d.date, d.label);
    list.append(el('li', {}, el('div', { class: 'line' }, el('div', {}, el('div', { class: 'name', text: d.label }), el('div', { class: 'sub', text: `${d.sub} · ${fmtDate(d.date)}` })), cd ? el('span', { class: 'tag ' + cd.level, text: cd.text.replace(d.label + ' ', '') }) : null)));
  }
  out.replaceChildren(el('p', { class: 'small' }, el('strong', { text: v.name || num }), ` · ${v.status || ''}`), list,
    el('p', { class: 'muted small', text: 'From Companies House. Corporation Tax dates are worked out from your accounting period — guidance only, check with your accountant.' }));
}
$('company-number')?.addEventListener('change', (e) => { saveSettings({ companyNumber: e.target.value.trim().toUpperCase().replace(/\s/g, '') }); renderCompany(); renderDashboard(); });

// ----- notifications when your partner adds something (Web Push via your sync server) -----
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const installed = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
async function pushRequest(action, body) {
  const s = settings();
  const h = await householdId(s.householdCode);
  const res = await fetch(`${s.syncUrl.replace(/\/+$/, '')}/push/${action}?h=${h}`, { method: body ? 'POST' : 'GET', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Evergreen-Token': await writeToken(s.householdCode) }, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 404) throw new Error('Your sync server is still updating — try again in a few minutes.');
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `the server returned ${res.status}`);
  return j;
}
const b64uToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
async function renderPush() {
  const btn = $('btn-push');
  if (!btn) return;
  const on = settings().pushOn && pushSupported() && Notification.permission === 'granted';
  btn.textContent = on ? 'Turn off notifications' : 'Turn on notifications';
  btn.classList.toggle('primary', !on);
  if (!pushSupported()) setStatus('push-status', isIOS() && !installed() ? 'On iPhone, notifications work once Evergreen is on your Home Screen (Share → Add to Home Screen) — open it from there.' : "This phone's browser doesn't support notifications.", true);
  else if (Notification.permission === 'denied') setStatus('push-status', "Notifications are blocked for Evergreen — allow them in the phone's settings (Settings → Notifications), then try again.", true);
  else setStatus('push-status', on ? `On — you'll hear when ${partnerName()} adds something.` : '');
}
async function turnOnPush() {
  if (!paired()) return setStatus('push-status', 'Set up sharing with your partner first.', true);
  if (!pushSupported()) return renderPush();
  setStatus('push-status', 'Asking permission…');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return renderPush();
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await pushRequest('key');
  let sub = await reg.pushManager.getSubscription();
  const keyMatches = sub && sub.options && sub.options.applicationServerKey && btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') === publicKey;
  if (sub && !keyMatches) { await sub.unsubscribe().catch(() => {}); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(publicKey) });
  await pushRequest('subscribe', { device: deviceId(), label: partnerName() === 'Partner' ? 'Your partner' : partnerName(), sub: sub.toJSON() });
  saveSettings({ pushOn: true });
  haptic(); toast('Notifications on ✓');
  renderPush();
}
async function turnOffPush() {
  try { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); if (sub) await sub.unsubscribe(); } catch { /* ignore */ }
  try { await pushRequest('unsubscribe', { device: deviceId() }); } catch { /* server tidies up dead ones anyway */ }
  saveSettings({ pushOn: false });
  renderPush();
}
$('btn-push')?.addEventListener('click', () => {
  const on = settings().pushOn && pushSupported() && Notification.permission === 'granted';
  (on ? turnOffPush() : turnOnPush()).catch((e) => setStatus('push-status', e.message || "Couldn't turn notifications on.", true));
});
// Keep the server's label for your partner up to date if you change the name.
function refreshPushLabel() {
  if (!settings().pushOn || !pushSupported() || Notification.permission !== 'granted') return;
  navigator.serviceWorker.ready.then((reg) => reg.pushManager.getSubscription()).then((sub) => sub && pushRequest('subscribe', { device: deviceId(), label: partnerName() === 'Partner' ? 'Your partner' : partnerName(), sub: sub.toJSON() })).catch(() => {});
}
// A notification was tapped, or arrived while open → fetch the new things now.
navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data === 'evergreen-sync' && !vault.locked) { syncNow(); checkInbox(true); } });

// ----- parcels from your email, collected from your sync server's sealed inbox -----
const INBOX_ITEM = 'xinbox';
const inboxItem = () => sharedItems('inboxkey')[0] || null;
async function inboxCall(action, body) {
  const s = settings();
  const h = await householdId(s.householdCode);
  const res = await fetch(`${s.syncUrl.replace(/\/+$/, '')}/inbox/${action}?h=${h}`, { method: body ? 'POST' : 'GET', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Evergreen-Token': await writeToken(s.householdCode) }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (res.status === 404 || j.error === 'bad id') throw new Error('Your sync server is still updating — try again in a few minutes.');
  if (!res.ok) throw new Error(j.error || `the server returned ${res.status}`);
  return j;
}
async function ensureInboxRegistered(it) {
  if (settings().inboxRegistered === it.inboxId) return;
  await inboxCall('register', { inboxId: it.inboxId });
  saveSettings({ inboxRegistered: it.inboxId });
}
function renderInbox() {
  const out = $('inbox-out');
  if (!out) return;
  const it = inboxItem();
  $('btn-inbox-setup').hidden = !!it;
  if (!it) { out.replaceChildren(paired() ? '' : el('p', { class: 'muted small', text: 'Set up Settings → Sharing first — the inbox lives on your sync server.' })); return; }
  const addr = inboxAddress(settings().syncUrl, it.inboxId, it.publicKey);
  const copy = el('button', { class: 'primary', type: 'button', text: 'Copy the inbox address' });
  copy.addEventListener('click', () => copyValue(addr, 'Inbox address'));
  out.replaceChildren(el('p', { class: 'small', text: 'Done on this phone and your partner’s. Last step: copy the address below and paste it to Claude, so the morning check can post to it. It only lets something drop sealed parcels in — it can’t read anything.' }),
    el('code', { class: 'inbox-addr', text: addr }), copy, el('p', { class: 'muted small', text: settings().inboxLast ? `Last parcel collected ${new Date(settings().inboxLast).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.` : 'Nothing collected yet.' }));
}
$('btn-inbox-setup')?.addEventListener('click', async () => {
  if (!paired()) return toast('Set up Settings → Sharing first.');
  try {
    await syncNow(); // make sure we don't already have one from your partner's phone
    let it = inboxItem();
    if (!it) {
      const keys = await makeInboxKeys();
      sharedSet({ id: INBOX_ITEM, type: 'inboxkey', inboxId: newInboxId(), publicKey: keys.publicKey, privateJwk: keys.privateJwk, updatedAt: now(), deleted: false });
      it = inboxItem();
      await syncNow();
    }
    await ensureInboxRegistered(it);
    renderInbox(); haptic(); toast('Inbox ready ✓');
  } catch (e) { toast(e.message || "Couldn't set up the inbox.", { ms: 7000 }); }
});
let inboxChecking = false, inboxCheckedAt = 0;
async function checkInbox(force = false) {
  const it = inboxItem();
  if (!it || !paired() || vault.locked || inboxChecking) return;
  if (!force && Date.now() - inboxCheckedAt < 2 * 60000) return;
  inboxChecking = true; inboxCheckedAt = Date.now();
  try {
    await ensureInboxRegistered(it);
    const { messages = [] } = await inboxCall('list');
    if (!messages.length) return;
    const lines = [];
    const done = [];
    for (const m of messages) {
      try { lines.push(await unseal(it.privateJwk, m.sealed)); done.push(m.id); } catch { done.push(m.id); /* not for us any more */ }
    }
    const r = parseImport(lines.join('\n'));
    const onlyParcels = importCount(r) === r.deliveries.length;
    if (importCount(r)) {
      if (onlyParcels) {
        const { count, undo } = applyParsedImport(r);
        if (count) toast(`📦 ${count === 1 ? 'A parcel' : count + ' parcels'} added from your email`, { actionLabel: 'Undo', onAction: undo, ms: 8000 });
      } else confirmImport(r);
    }
    await inboxCall('ack', { ids: done });
    saveSettings({ inboxLast: Date.now() });
    renderInbox();
  } catch (e) {
    log('info', 'Inbox check failed: ' + e.message);
  } finally { inboxChecking = false; }
}

// ---------- Bills & suppliers: add / edit (energy, water, broadband, mobile, TV, council tax) ----------
const BILL_FIELDS = {
  common: [['provider', 'Provider', 'text', 'e.g. Octopus, BT, EE, Sky'], ['tariff', 'Plan / tariff', 'text', 'optional'], ['cost', 'Monthly cost (£)', 'number', 'optional'], ['renewal', 'Contract ends', 'date']],
  Energy: [['usage', 'Your usage (optional)', 'text', 'e.g. 3,100 kWh electricity, 9,000 kWh gas a year']],
  Electricity: [['usage', 'Your usage (optional)', 'text', 'e.g. 3,100 kWh a year']],
  Gas: [['usage', 'Your usage (optional)', 'text', 'e.g. 9,000 kWh a year']],
  Broadband: [['speed', 'Average speed (Mbps)', 'number', 'e.g. 150'], ['priceRise', 'Price rise each April (£ a month)', 'number', 'e.g. 3'], ['usage', 'Extras', 'text', 'e.g. landline, Wi-Fi boosters']],
  Mobile: [['who', 'Whose phone', 'text', 'e.g. Jess'], ['usage', 'Allowance', 'text', 'e.g. 30GB, unlimited calls'], ['handset', 'Phone included in the contract?', 'select', ['', 'Yes — phone and airtime', 'No — SIM-only', 'Phone on a separate plan']], ['priceRise', 'Price rise each April (£ a month)', 'number', 'optional']],
  TV: [['usage', 'Package / channels', 'text', 'e.g. Sky Signature + Netflix'], ['priceRise', 'Price rise each April (£ a month)', 'number', 'optional']],
  'Council tax': [['band', 'Band', 'select', ['', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']], ['annual', 'Bill for the year (£)', 'number', 'e.g. 2,400'], ['instalments', 'Instalments', 'select', ['10', '12']]],
  Water: [], Other: [],
};
const HANDSET = { 'Yes — phone and airtime': 'included', 'No — SIM-only': 'sim', 'Phone on a separate plan': 'separate' };
const HANDSET_LABEL = Object.fromEntries(Object.entries(HANDSET).map(([k, v]) => [v, k]));
function openSupplierEditor(existing) {
  const u = existing ? { ...existing } : {};
  const typeSel = el('select', {}, ...BILL_TYPES.map((t) => el('option', { value: t, text: `${BILL_ICON[t]} ${t === 'TV' ? 'TV & streaming' : t === 'Energy' ? 'Energy (gas & electricity)' : t}` })));
  typeSel.value = u.type && BILL_TYPES.includes(u.type) ? u.type : u.type === 'TV / streaming' ? 'TV' : 'Energy';
  const box = el('div', {});
  const inputs = {};
  const draw = () => {
    box.replaceChildren();
    for (const k of Object.keys(inputs)) delete inputs[k];
    const t = typeSel.value;
    const fields = [...(t === 'Council tax' ? BILL_FIELDS.common.filter(([k]) => k === 'provider').map(([k]) => [k, 'Council', 'text', 'e.g. Dacorum Borough Council']) : BILL_FIELDS.common), ...(BILL_FIELDS[t] || [])];
    for (const [k, label, type, ph] of fields) {
      let input;
      if (type === 'select') {
        input = el('select', {}, ...ph.map((o) => el('option', { value: o, text: o || 'Choose…' })));
        input.value = k === 'handset' ? (HANDSET_LABEL[u[k]] || '') : String(u[k] ?? (k === 'instalments' ? '10' : ''));
      } else {
        input = el('input', { type, autocomplete: 'off', ...(type === 'number' ? { inputmode: 'decimal', step: 'any' } : {}), ...(ph ? { placeholder: ph } : {}) });
        input.value = u[k] ?? '';
      }
      inputs[k] = input;
      box.append(el('label', { class: 'field' }, label, input));
    }
  };
  typeSel.addEventListener('change', draw); draw();
  const save = el('button', { class: 'primary', type: 'button', text: existing ? 'Save' : 'Add' });
  save.addEventListener('click', () => {
    const t = typeSel.value;
    const data = { service: t };
    for (const [k, input] of Object.entries(inputs)) {
      const v = input.value.trim();
      data[k] = k === 'handset' ? (HANDSET[v] || '') : ['cost', 'speed', 'priceRise', 'annual'].includes(k) ? (v === '' ? 0 : Number(v)) : v;
    }
    if (t === 'Council tax') { const ct = councilTax(data.annual, data.instalments); data.cost = ct ? ct.monthlyAverage : 0; }
    if (!data.provider && t !== 'Council tax') { inputs.provider.focus(); return toast('Add the provider.'); }
    if (existing) sharedUpdate(existing.id, data); else sharedAdd('utility', data);
    scheduleSync(); closeSheet(); renderUtilities(); renderDashboard(); haptic();
    toast(existing ? 'Saved ✓' : 'Added ✓');
  });
  const cancel = el('button', { type: 'button', text: 'Cancel' });
  cancel.addEventListener('click', closeSheet);
  openSheet(el('h2', { text: existing ? `Edit ${u.type}` : 'Add a bill or contract' }),
    el('p', { class: 'muted small', text: 'Shared with your partner. Add the contract end date and Evergreen tells you when it’s time to haggle or switch.' }),
    el('label', { class: 'field' }, 'What is it?', typeSel), box, el('div', { class: 'row' }, cancel, save));
}
$('btn-supplier-add')?.addEventListener('click', () => openSupplierEditor());

// ---------- Insurance: every policy in one place ----------
const POLICY_KEY = 'tiguan-policies'; // policies kept only on this phone
function policies() {
  return [...sharedItems('policy').map((p) => ({ ...p, shared: true })), ...store.load(POLICY_KEY, []).map((p) => ({ ...p, shared: false }))]
    .sort((a, b) => ((a.renewal || '9') < (b.renewal || '9') ? -1 : 1));
}
function savePolicy(p, data, makeShared) {
  if (p && p.shared && makeShared) return sharedUpdate(p.id, data);
  if (p && !p.shared && !makeShared) return store.save(POLICY_KEY, store.load(POLICY_KEY, []).map((x) => (x.id === p.id ? { ...x, ...data } : x)));
  // new, or moving between "shared" and "this phone only"
  const full = { ...(p || {}), ...data };
  delete full.shared; delete full.type; delete full.updatedAt; delete full.deleted;
  if (p) { if (p.shared) sharedRemove(p.id); else store.save(POLICY_KEY, store.load(POLICY_KEY, []).filter((x) => x.id !== p.id)); }
  if (makeShared) { const { id, ...rest } = full; sharedAdd('policy', rest); } else store.save(POLICY_KEY, [{ ...full, id: full.id || 'p' + uid() }, ...store.load(POLICY_KEY, [])]);
}
function policyBrief(p) {
  return [`Please help me find a better ${policyLabel(p.kind).toLowerCase()} insurance deal (UK) before my renewal.`,
    p.insurer ? `Current insurer: ${p.insurer}` : null, p.premium ? `Renewal price: £${p.premium} a year${p.lastPremium ? ` (last year £${p.lastPremium})` : ''}` : null,
    p.excess ? `Excess: £${p.excess}` : null, p.covers ? `Cover: ${p.covers}` : null, p.renewal ? `Renews: ${fmtDate(p.renewal)}` : null,
    'Suggest what to compare, typical prices and any catches. (Insurers can’t charge renewing customers more than new ones for home and car cover.)'].filter(Boolean).join('\n');
}
function renderPolicies() {
  const out = $('policy-list');
  if (!out) return;
  out.replaceChildren();
  const all = policies();
  if (!all.length) { out.append(el('p', { class: 'muted small', text: 'No policies yet — add your home, car, pet, life and travel cover so renewals never sneak up on you.' })); return; }
  const today = todayISO();
  const yearly = all.reduce((s, p) => s + (Number(p.premium) || 0), 0);
  if (yearly) out.append(el('p', { class: 'small', text: `All your cover: ${money(yearly)} a year (about ${money(yearly / 12)} a month).` }));
  for (const p of all) {
    const cd = p.renewal ? countdown(p.renewal, '') : null;
    const pc = priceChange(p.premium, p.lastPremium);
    const card = el('div', { class: 'card doc policy' },
      el('div', { class: 'line' }, el('div', {},
        el('div', { class: 'name', text: `${policyIcon(p.kind)} ${policyLabel(p.kind)}${p.insurer ? ' — ' + p.insurer : ''}` }),
        el('div', { class: 'sub', text: [p.premium ? `${money(p.premium)} a year` : '', p.excess ? `excess ${money(p.excess)}` : '', p.covers, p.shared ? '' : 'only on this phone'].filter(Boolean).join(' · ') })),
      cd ? el('span', { class: 'tag ' + cd.level, text: cd.days < 0 ? 'renewal passed' : `renews ${cd.days <= 60 ? 'in ' + cd.days + ' days' : fmtDate(p.renewal)}` }) : el('span', { class: 'tag dim', text: 'no date' })));
    if (pc && pc.pct !== 0) card.append(el('div', { class: 'small', style: 'margin-top:6px' }, el('span', { class: 'tag ' + pc.level, text: pc.text }), ` (${pc.diff > 0 ? '+' : ''}${money(pc.diff)})`));
    const n = policyNudge(p, today);
    if (n) card.append(el('div', { class: 'state-note small ' + n.level, style: 'margin-top:8px', text: n.text }));
    const dl = el('dl', { class: 'child-dl', style: 'margin-top:8px' });
    if (p.policyNo) { const b = el('button', { class: 'child-copy', type: 'button', text: mask(p.policyNo) }); let shown = false; b.addEventListener('click', () => { if (!shown) { b.textContent = p.policyNo; shown = true; } else copyValue(p.policyNo, 'Policy number'); }); dl.append(el('dt', { text: 'Policy no.' }), el('dd', {}, b)); }
    if (p.claimsPhone) dl.append(el('dt', { text: 'Claims line' }), el('dd', {}, el('a', { href: 'tel:' + p.claimsPhone.replace(/[^\d+]/g, ''), text: p.claimsPhone })));
    if (dl.children.length) card.append(dl);
    if (p.notes) card.append(el('p', { class: 'small child-notes', text: p.notes }));
    const acts = el('div', { class: 'row', style: 'margin-top:10px' });
    const edit = el('button', { type: 'button', text: 'Edit' }); edit.addEventListener('click', () => openPolicyEditor(p)); acts.append(edit);
    if (INSURANCE_COMPARE[p.kind]) acts.append(el('a', { class: 'btn-a', href: INSURANCE_COMPARE[p.kind], target: '_blank', rel: 'noopener', text: 'Compare' }));
    const ask = el('button', { type: 'button', text: 'Ask Claude' });
    ask.addEventListener('click', async () => { const text = policyBrief(p); try { if (navigator.share) await navigator.share({ title: 'Insurance renewal', text }); else { await navigator.clipboard.writeText(text); toast('Copied — paste it to Claude'); } } catch { /* closed */ } });
    acts.append(ask);
    if (p.renewal) acts.append(el('a', { class: 'btn-a', href: calendarEvent(`${policyLabel(p.kind)} insurance renewal${p.insurer ? ' – ' + p.insurer : ''}`, p.renewal, { guests: partnerEmail() }), target: '_blank', rel: 'noopener', text: 'Remind me' }));
    card.append(acts, p.shared
      ? lazyFiles({ shared: true, hint: 'Policy schedule, certificate, terms.', get: () => sharedItems('policy').find((x) => x.id === p.id)?.files || [], save: (list) => { sharedUpdate(p.id, { files: list }); scheduleSync(); } })
      : privateFiles(POLICY_KEY, p.id, 'Policy schedule, certificate, terms.'));
    if (!p.shared && p.photoId) attachPhoto(card, p, policyLabel(p.kind));
    out.append(card);
  }
}
function openPolicyEditor(existing) {
  const p = existing || { kind: 'home', shared: true };
  const kind = el('select', {}, ...POLICY_KINDS.map(([v, l, i]) => el('option', { value: v, text: `${i} ${l}` })));
  kind.value = p.kind || 'home';
  const f = {};
  const inp = (k, type = 'text', ph = '') => { const i = el('input', { type, autocomplete: 'off', ...(type === 'number' ? { inputmode: 'decimal', step: 'any' } : {}), placeholder: ph }); i.value = p[k] ?? ''; f[k] = i; return i; };
  const auto = el('input', { type: 'checkbox' }); auto.checked = !!p.autoRenew;
  const shared = el('input', { type: 'checkbox' }); shared.checked = p.shared !== false;
  const notes = el('textarea', { rows: '2', placeholder: 'e.g. covers accidental damage; legal cover added' }); notes.value = p.notes || '';
  const save = el('button', { class: 'primary', type: 'button', text: existing ? 'Save' : 'Add' });
  save.addEventListener('click', () => {
    const data = { kind: kind.value, notes: notes.value.trim(), autoRenew: auto.checked };
    for (const [k, i] of Object.entries(f)) data[k] = ['premium', 'lastPremium', 'excess'].includes(k) ? (i.value === '' ? '' : Number(i.value)) : i.value.trim();
    savePolicy(existing, data, shared.checked);
    scheduleSync(); closeSheet(); renderPolicies(); renderDashboard(); syncCarInsurance(); haptic();
    toast(existing ? 'Saved ✓' : 'Policy added ✓');
  });
  const cancel = el('button', { type: 'button', text: 'Cancel' }); cancel.addEventListener('click', closeSheet);
  const nodes = [el('h2', { text: existing ? 'Edit policy' : 'Add a policy' }),
    el('label', { class: 'field' }, 'Type of cover', kind),
    el('label', { class: 'field' }, 'Insurer', inp('insurer', 'text', 'e.g. Aviva, Admiral, Petplan')),
    el('label', { class: 'field' }, 'Policy number', inp('policyNo')),
    el('label', { class: 'field' }, 'Claims / emergency phone', inp('claimsPhone', 'tel', 'e.g. 0800 …')),
    el('div', { class: 'grid2' }, el('label', { class: 'field' }, 'Renews on', inp('renewal', 'date')), el('label', { class: 'field' }, 'Excess (£)', inp('excess', 'number'))),
    el('div', { class: 'grid2' }, el('label', { class: 'field' }, 'Price this year (£/yr)', inp('premium', 'number')), el('label', { class: 'field' }, 'Last year (£/yr)', inp('lastPremium', 'number', 'to spot price creep'))),
    el('label', { class: 'field' }, 'What / who it covers', inp('covers', 'text', 'e.g. VW Tiguan, both drivers')),
    el('label', { class: 'check' }, auto, ' Renews automatically'),
    el('label', { class: 'check' }, shared, ' Share with my partner (untick to keep it on this phone only)'),
    el('label', { class: 'field' }, 'Notes', notes),
    el('div', { class: 'row' }, cancel, save)];
  if (existing) {
    const del = el('button', { class: 'link', type: 'button', style: 'color:var(--urgent, #c0392b);margin-top:8px', text: 'Delete this policy' });
    del.addEventListener('click', () => {
      if (!confirm('Delete this policy?')) return;
      if (existing.shared) { sharedRemove(existing.id); scheduleSync(); dropFiles(existing.files || []); } else deleteItem(POLICY_KEY, existing.id, renderPolicies, { photoId: existing.photoId, label: policyLabel(existing.kind) });
      closeSheet(); renderPolicies(); renderDashboard();
    });
    nodes.push(del);
  }
  openSheet(...nodes);
}
$('btn-policy-add')?.addEventListener('click', () => openPolicyEditor());
/** The car's insurance date (Car tab) comes from the Car policy here, so it's entered once. */
function syncCarInsurance() {
  const car = policies().filter((p) => p.kind === 'car' && p.renewal).sort((a, b) => (a.renewal < b.renewal ? -1 : 1))[0];
  if (!car) return;
  const v = loadVehicle();
  if (v.insurance !== car.renewal) { saveVehicle({ ...v, insurance: car.renewal }); if ($('insurance-input')) $('insurance-input').value = car.renewal; }
}
/** Annual travel cover that runs past a trip counts as insurance for it. */
const annualTravelCover = (trip) => policies().some((p) => p.kind === 'travel' && p.renewal && p.renewal >= (trip.end || trip.start));
/** One-off: move insurance kept under Utilities or Documents into Insurance. */
function migrateInsurance() {
  let moved = 0;
  for (const u of sharedItems('utility').filter((x) => x.service === 'Insurance')) {
    sharedAdd('policy', { kind: guessPolicyKind([u.provider, u.tariff, u.usage].join(' ')), insurer: u.provider || '', premium: u.cost ? Math.round(u.cost * 12) : '', renewal: u.renewal || '', notes: [u.tariff, u.usage].filter(Boolean).join(' · '), files: u.files || [] });
    sharedRemove(u.id); moved++;
  }
  const docs = store.load(DOCS_KEY, []);
  const ins = docs.filter((d) => d.category === 'Insurance');
  if (ins.length) {
    store.save(POLICY_KEY, [...ins.map((d) => ({ id: 'p' + uid(), kind: guessPolicyKind(d.label + ' ' + (d.note || '')), insurer: '', renewal: d.expiry || '', notes: [d.label, d.note].filter(Boolean).join(' · '), files: d.files || [], photoId: d.photoId })), ...store.load(POLICY_KEY, [])]);
    store.save(DOCS_KEY, docs.filter((d) => d.category !== 'Insurance'));
    moved += ins.length;
  }
  if (moved) { scheduleSync(); renderDocs(); renderUtilities(); toast(`Moved ${moved} insurance ${moved === 1 ? 'entry' : 'entries'} into Home → Insurance`); }
}

// ---------- Household emergency info (shared) ----------
const HOUSE_FIELDS = [
  ['stopcock', 'Water stopcock', 'e.g. under the kitchen sink, left'], ['fusebox', 'Fuse box / consumer unit', 'e.g. cupboard under the stairs'],
  ['gasmeter', 'Gas meter & shut-off', 'e.g. outside box by the front door'], ['elecmeter', 'Electricity meter', ''],
  ['boiler', 'Boiler (make, model) & engineer', 'e.g. Worcester 30i — engineer Dave 07…'], ['water', 'Water company emergency line', 'e.g. Affinity Water 0345 …'],
  ['keys', 'Spare keys are with', 'e.g. Sue at no. 12'], ['alarm', 'Alarm — where the code is kept', 'never the code itself'],
  ['neighbours', 'Neighbours to call', 'names and numbers'], ['wifi', 'Wi-Fi name', 'the password stays in your password manager'],
  ['bins', 'Bin days', 'e.g. Tues — black & blue alternate weeks'],
];
const HOUSE_ID = 'xhouse';
const house = () => sharedItems('house')[0] || null;
function renderHouse() {
  const out = $('house-out');
  if (!out) return;
  const h = house() || {};
  out.replaceChildren();
  const dl = el('dl', { class: 'child-dl' });
  for (const [k, label] of HOUSE_FIELDS) if (h[k]) dl.append(el('dt', { text: label }), el('dd', { text: h[k] }));
  const homePolicy = policies().find((p) => ['home', 'buildings', 'contents'].includes(p.kind) && p.claimsPhone);
  if (homePolicy) dl.append(el('dt', { text: 'Home insurance claims' }), el('dd', {}, el('a', { href: 'tel:' + homePolicy.claimsPhone.replace(/[^\d+]/g, ''), text: `${homePolicy.claimsPhone}${homePolicy.insurer ? ' (' + homePolicy.insurer + ')' : ''}` })));
  const boilerPolicy = policies().find((p) => p.kind === 'boiler' && p.claimsPhone);
  if (boilerPolicy) dl.append(el('dt', { text: 'Boiler cover' }), el('dd', {}, el('a', { href: 'tel:' + boilerPolicy.claimsPhone.replace(/[^\d+]/g, ''), text: `${boilerPolicy.claimsPhone}${boilerPolicy.insurer ? ' (' + boilerPolicy.insurer + ')' : ''}` })));
  out.append(dl.children.length ? dl : el('p', { class: 'muted small', text: 'Nothing saved yet — add where the stopcock and fuse box are, who has spare keys, and so on. Handy for you, a babysitter or a house-sitter.' }));
  if (h.notes) out.append(el('p', { class: 'small child-notes', style: 'margin-top:8px', text: h.notes }));
  renderEmergencyPeople();
  if (h.id) out.append(lazyFiles({ shared: true, hint: 'Photos of the stopcock, fuse box, meters — so anyone can find them.', get: () => house()?.files || [], save: (list) => { sharedUpdate(h.id, { files: list }); scheduleSync(); } }));
}
// Everyone's essentials, for the "In an emergency" screen (no NHS or passport numbers).
function renderEmergencyPeople() {
  const out = $('emg-people');
  if (!out) return;
  const ppl = children();
  if (!ppl.length) { out.replaceChildren(el('p', { class: 'muted small', text: 'Add everyone in Family (allergies, medication, GP) and their essentials appear here.' })); return; }
  out.replaceChildren(...ppl.map((c) => {
    const rows = [['Allergies', c.allergies], ['Medication', c.medication], ['Conditions', c.conditions], ['Blood group', c.blood]].filter(([, v]) => v);
    const gp = c.gp ? `${c.gp}${c.gpPhone ? '' : ''}` : '';
    return el('div', { class: 'emg-person' }, el('div', { class: 'name', text: `${c.name}${c.dob ? ' · ' + ageText(c.dob, todayISO()) : ''}` }),
      rows.length ? el('dl', { class: 'child-dl' }, ...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })])) : el('div', { class: 'muted small', text: 'No allergies or medication recorded.' }),
      gp || c.gpPhone ? el('div', { class: 'small' }, `GP: ${gp} `, c.gpPhone ? el('a', { href: 'tel:' + c.gpPhone.replace(/[^\d+]/g, ''), text: c.gpPhone }) : null) : null);
  }));
}
/** Warranties used to be Documents; they belong with the item in Contents. */
function migrateWarranties() {
  const docs = store.load(DOCS_KEY, []);
  const w = docs.filter((d) => d.category === 'Warranty');
  if (!w.length) return;
  store.save(INV_KEY, [...w.map((d) => ({ id: Date.now() + Math.random(), name: d.label, room: '', value: 0, serial: '', warrantyUntil: d.expiry || '', notes: d.note || '', photoId: d.photoId, files: d.files || [] })), ...store.load(INV_KEY, [])]);
  store.save(DOCS_KEY, docs.filter((d) => d.category !== 'Warranty'));
  renderDocs(); renderInventory();
  toast(`Moved ${w.length} warrant${w.length === 1 ? 'y' : 'ies'} into Home → Contents`);
}
function openHouseEditor() {
  const h = house() || {};
  const f = {};
  const notes = el('textarea', { rows: '3', placeholder: 'Anything else — e.g. the loft hatch pole is in the garage' }); notes.value = h.notes || '';
  const save = el('button', { class: 'primary', type: 'button', text: 'Save' });
  save.addEventListener('click', () => {
    const data = { notes: notes.value.trim() };
    for (const [k, i] of Object.entries(f)) data[k] = i.value.trim();
    if (h.id) sharedUpdate(h.id, data); else sharedSet({ id: HOUSE_ID, type: 'house', ...data, updatedAt: now(), deleted: false });
    scheduleSync(); closeSheet(); renderHouse(); haptic(); toast('Saved ✓');
  });
  const cancel = el('button', { type: 'button', text: 'Cancel' }); cancel.addEventListener('click', closeSheet);
  openSheet(el('h2', { text: 'Emergency info for the house' }), el('p', { class: 'muted small', text: 'Shared with your partner. Don’t put alarm codes or passwords here.' }),
    ...HOUSE_FIELDS.map(([k, label, ph]) => { const i = el('input', { type: 'text', autocomplete: 'off', placeholder: ph }); i.value = h[k] || ''; f[k] = i; return el('label', { class: 'field' }, label, i); }),
    el('label', { class: 'field' }, 'Notes', notes), el('div', { class: 'row' }, cancel, save));
}
$('btn-house-edit')?.addEventListener('click', openHouseEditor);

// ---------- Family: key details for the children (shared, encrypted) ----------
const CHILD_GROUPS = [
  { group: 'Identity', fields: [
    { k: 'nhs', label: 'NHS number', secret: true, inputmode: 'numeric' },
    { k: 'passport', label: 'Passport number', secret: true },
    { k: 'passportIssued', label: 'Passport issued', type: 'date', quiet: true },
    { k: 'passportExpiry', label: 'Passport expires', type: 'date' },
    { k: 'ghicExpiry', label: 'GHIC expires', type: 'date' },
    { k: 'birthCert', label: 'Birth certificate no.', secret: true, child: true },
    { k: 'licenceExpiry', label: 'Driving licence photocard expires', type: 'date', adult: true },
  ] },
  { group: 'Health', fields: [
    { k: 'blood', label: 'Blood group' },
    { k: 'allergies', label: 'Allergies' },
    { k: 'medication', label: 'Medication' },
    { k: 'conditions', label: 'Conditions / needs' },
    { k: 'gp', label: 'GP surgery' },
    { k: 'gpPhone', label: 'GP phone', type: 'tel' },
    { k: 'dentist', label: 'Dentist' },
    { k: 'dentistPhone', label: 'Dentist phone', type: 'tel' },
  ] },
  { group: 'School', child: true, fields: [
    { k: 'school', label: 'School / nursery' },
    { k: 'class', label: 'Class / year' },
    { k: 'teacher', label: 'Teacher' },
    { k: 'schoolPhone', label: 'School phone', type: 'tel' },
  ] },
  { group: 'Sizes', child: true, fields: [
    { k: 'clothes', label: 'Clothes size' },
    { k: 'shoes', label: 'Shoe size' },
  ] },
];
// Everyone in Family (children, and grown-ups added for passport checks), oldest first.
const children = () => sharedItems('child').sort((a, b) => (!!b.adult - !!a.adult) || ((a.dob || '9') < (b.dob || '9') ? -1 : 1));
const groupsFor = (c) => CHILD_GROUPS.filter((g) => !(g.child && c.adult)).map((g) => ({ ...g, fields: g.fields.filter((f) => !(f.child && c.adult) && !(f.adult && !c.adult)) }));
const looksSecret = (v) => /\d{4,}/.test(String(v).replace(/\s/g, ''));
function copyValue(v, label) {
  navigator.clipboard?.writeText(String(v)).then(() => toast(`${label} copied`), () => toast('Could not copy'));
}
function renderFamily() {
  const out = $('family-list');
  if (!out) return;
  out.replaceChildren();
  const kids = children();
  if (!kids.length) { out.append(el('p', { class: 'muted small', text: 'No one added yet — tap “+ Add a child”.' })); return; }
  const today = todayISO();
  for (const c of kids) {
    const nb = c.dob ? nextBirthday(c.dob, today) : null;
    const sub = [c.dob ? ageText(c.dob, today) : '', nb ? (nb.date === today ? `🎂 ${nb.turning} today!` : dayLabel(nb.date) === 'Tomorrow' ? '🎂 birthday tomorrow' : `birthday ${new Date(nb.date + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}`) : ''].filter(Boolean).join(' · ');
    const card = el('div', { class: 'card child-card' });
    const show = el('button', { class: 'child-show', text: 'Show numbers' });
    card.append(el('div', { class: 'line' }, el('div', {}, el('div', { class: 'child-name', text: c.name || 'Child' }), sub ? el('div', { class: 'sub', text: sub }) : null), show));
    const body = el('div', {});
    let revealed = false;
    let hideTimer = null;
    const draw = () => {
      body.replaceChildren();
      const groups = groupsFor(c).map((g) => ({ group: g.group, rows: g.fields.filter((f) => c[f.k]).map((f) => ({ ...f, value: c[f.k] })) }));
      const extras = (c.extras || []).filter((x) => x && x.label && x.value).map((x) => ({ k: x.label, label: x.label, value: x.value, secret: looksSecret(x.value) }));
      if (extras.length) groups.push({ group: 'Other details', rows: extras });
      let any = false;
      for (const g of groups) {
        if (!g.rows.length) continue;
        any = true;
        const dl = el('dl', { class: 'child-dl' });
        for (const f of g.rows) {
          let node;
          if (f.type === 'date') {
            const cd = countdown(f.value, '');
            node = el('span', {}, fmtDate(f.value), cd && !f.quiet && cd.days <= 180 ? el('span', { class: 'tag ' + (cd.days < 0 ? 'urgent' : 'soon'), style: 'margin-left:6px', text: cd.days < 0 ? 'expired' : `${cd.days} days` }) : null);
          } else if (f.type === 'tel') {
            node = el('a', { href: 'tel:' + String(f.value).replace(/[^\d+]/g, ''), text: f.value });
          } else if (f.secret && !revealed) {
            node = el('span', { class: 'child-masked', text: mask(f.value) });
          } else if (f.secret) {
            node = el('button', { class: 'child-copy', text: f.value, title: 'Tap to copy' });
            node.addEventListener('click', () => copyValue(f.value, f.label));
          } else node = el('span', { text: f.value });
          dl.append(el('dt', { text: f.label }), el('dd', {}, node));
        }
        body.append(el('div', { class: 'child-group', text: g.group }), dl);
      }
      if (c.notes) { any = true; body.append(el('div', { class: 'child-group', text: 'Notes' }), el('p', { class: 'child-notes', text: c.notes })); }
      if (!any) body.append(el('p', { class: 'muted small', text: 'No details yet — tap Edit to add some.' }));
    };
    show.addEventListener('click', () => {
      revealed = !revealed;
      show.textContent = revealed ? 'Hide numbers' : 'Show numbers';
      clearTimeout(hideTimer);
      if (revealed) hideTimer = setTimeout(() => { revealed = false; show.textContent = 'Show numbers'; draw(); }, 60000); // hide again after a minute
      draw();
    });
    draw();
    const dueChecks = store.load(CHECK_KEY, []).filter((x) => x.who && x.who === c.name).map((x) => ({ x, due: nextDue(x.last, x.interval) })).filter((y) => y.due);
    if (dueChecks.length) card.append(el('div', { class: 'child-group', text: 'Check-ups' }), el('ul', { class: 'list' }, ...dueChecks.map(({ x, due }) => { const cd = countdown(due, ''); return el('li', {}, el('div', { class: 'line' }, el('div', { class: 'name', text: x.type }), el('span', { class: 'tag ' + (cd ? cd.level : 'dim'), text: cd && cd.days < 0 ? 'overdue' : 'due ' + fmtDate(due) }))); })));
    if (!groupsFor(c).some((g) => g.fields.some((f) => f.secret && c[f.k])) && !(c.extras || []).some((x) => looksSecret(x.value))) show.hidden = true;
    const edit = el('button', { text: 'Edit' });
    edit.addEventListener('click', () => openChildEditor(c));
    const files = lazyFiles({ shared: true, hint: 'e.g. birth certificate, passport photo page, Red Book pages, vaccination record.',
      get: () => sharedItems('child').find((x) => x.id === c.id)?.files || [], save: (list) => { sharedUpdate(c.id, { files: list }); scheduleSync(); } });
    card.append(body, files, el('div', { class: 'row', style: 'margin-top:12px' }, edit));
    out.append(card);
  }
}
function openChildEditor(child, { adult = false } = {}) {
  const c = child || { adult };
  const inputs = {};
  const field = (f) => {
    const input = el('input', { type: f.type || 'text', autocomplete: 'off', ...(f.inputmode ? { inputmode: f.inputmode } : {}) });
    input.value = c[f.k] || '';
    inputs[f.k] = input;
    return el('label', { class: 'field' }, f.label, input);
  };
  const name = el('input', { type: 'text', autocomplete: 'off', placeholder: c.adult ? 'e.g. Jess' : 'e.g. Maddy' }); name.value = c.name || '';
  const dob = el('input', { type: 'date' }); dob.value = c.dob || '';
  const nhsHint = el('p', { class: 'muted small', style: 'margin:-6px 0 8px' });
  const notes = el('textarea', { rows: '3', placeholder: 'Anything else worth knowing — e.g. Red Book is in the kitchen drawer' }); notes.value = c.notes || '';
  const extrasBox = el('div', {});
  const addExtra = (x = {}) => {
    const label = el('input', { type: 'text', placeholder: 'What (e.g. Swim club no.)' }); label.value = x.label || '';
    const value = el('input', { type: 'text', placeholder: 'Detail' }); value.value = x.value || '';
    const del = el('button', { class: 'del', text: '✕', 'aria-label': 'Remove' });
    const row = el('div', { class: 'row child-extra' }, label, value, del);
    del.addEventListener('click', () => row.remove());
    row._get = () => ({ label: label.value.trim(), value: value.value.trim() });
    extrasBox.append(row);
  };
  (c.extras || []).forEach(addExtra);
  const moreBtn = el('button', { class: 'link', text: '+ Add another detail' });
  moreBtn.addEventListener('click', () => addExtra());
  const sections = groupsFor(c).map((g) => el('details', { class: 'inner', ...(g.group === 'Identity' ? { open: '' } : {}) }, el('summary', { text: g.group }), ...g.fields.map(field)));
  const checkNhs = () => {
    const v = inputs.nhs.value.trim();
    nhsHint.textContent = v && !nhsNumberValid(v) ? "That doesn't look like a valid NHS number — check the digits (it's 10 digits, e.g. 943 476 5919)." : '';
  };
  inputs.nhs.addEventListener('input', checkNhs);
  inputs.nhs.closest('label').after(nhsHint);
  checkNhs();
  const save = el('button', { class: 'primary', text: child ? 'Save' : 'Add' });
  const cancel = el('button', { text: 'Cancel' });
  cancel.addEventListener('click', closeSheet);
  save.addEventListener('click', () => {
    if (!name.value.trim()) { name.focus(); return toast('Add their name.'); }
    const data = { adult: !!c.adult, name: name.value.trim(), dob: dob.value, notes: notes.value.trim(), extras: [...extrasBox.children].map((r) => r._get()).filter((x) => x.label && x.value) };
    for (const [k, input] of Object.entries(inputs)) data[k] = input.value.trim();
    if (child) sharedUpdate(child.id, data); else sharedAdd('child', data);
    scheduleSync(); renderFamily(); renderCalendar(); renderHome(); closeSheet(); haptic();
    toast(child ? 'Saved ✓' : `${data.name} added ✓`);
  });
  const nodes = [el('h2', { text: child ? `Edit ${c.name}` : c.adult ? 'Add a grown-up' : 'Add a child' }),
    c.adult && !child ? el('p', { class: 'muted small', text: 'Add yourselves so Evergreen can check your passports and GHICs for trips. Shared with your partner and encrypted.' }) : null,
    el('label', { class: 'field' }, 'Name', name), el('label', { class: 'field' }, 'Date of birth', dob),
    ...sections,
    el('details', { class: 'inner' }, el('summary', { text: 'Other details' }), extrasBox, moreBtn),
    el('label', { class: 'field' }, 'Notes', notes),
    el('div', { class: 'row' }, cancel, save)];
  if (child) {
    const del = el('button', { class: 'link', style: 'color:var(--urgent, #c0392b);margin-top:8px', text: `Remove ${c.name}` });
    del.addEventListener('click', () => {
      if (!confirm(`Remove ${c.name} and all their details from both phones?`)) return;
      sharedRemove(child.id); dropFiles(c.files || []); scheduleSync(); renderFamily(); renderCalendar(); renderHome(); closeSheet();
      toast(`${c.name} removed`);
    });
    nodes.push(del);
  }
  openSheet(...nodes);
}
$('btn-child-add').addEventListener('click', () => openChildEditor(null));
$('btn-adult-add').addEventListener('click', () => openChildEditor(null, { adult: true }));

// ---------- Official car details (DVLA) + MOT history (DVSA) via your sync server ----------
const CAR_REFRESH_MS = 7 * 86400000;
let carLookupBusy = false;
async function lookupCar(manual = false) {
  if (carLookupBusy) return;
  const v = loadVehicle();
  const reg = cleanReg($('reg-input').value || v.reg || '');
  const say = (msg, bad) => { if (manual || !bad) setStatus('car-lookup-status', msg, bad); };
  if (!reg) return say('Type your registration first.', true);
  if (!paired()) return say('This uses your sync server — set up Settings → Sharing first.', true);
  carLookupBusy = true;
  if (manual) setStatus('car-lookup-status', 'Looking up your car…');
  try {
    const s = settings();
    const hid = await householdId(s.householdCode);
    const res = await fetch(`${s.syncUrl.replace(/\/+$/, '')}/vehicle?h=${hid}&reg=${encodeURIComponent(reg)}`, { cache: 'no-store', headers: { 'X-Evergreen-Token': await writeToken(s.householdCode) } });
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.json()).error; } catch { /* not json */ }
      if (msg === 'bad id') msg = 'your sync server needs updating';
      throw new Error(msg || `the server returned ${res.status}`);
    }
    const j = await res.json();
    const sum = summariseCar(j.dvla, j.mot);
    if (sum.sources.dvla === 'not set up' && sum.sources.mot === 'not set up') {
      return say('Not switched on yet — add your free DVLA and MOT keys (Help → Car details & MOT history).', true);
    }
    const v2 = loadVehicle();
    v2.reg = reg;
    $('reg-input').value = reg;
    v2.official = sum;
    v2.officialAt = Date.now();
    if (sum.motExpiry) v2.mot = sum.motExpiry;
    if (sum.taxDue && /taxed/i.test(sum.taxStatus)) v2.tax = sum.taxDue;
    saveVehicle(v2);
    for (const key of ['mot', 'tax']) if (v2[key]) $(key + '-input').value = v2[key];
    refreshRenewals();
    renderOfficial();
    renderHome();
    const problems = Object.entries(sum.sources).filter(([, st]) => st !== 'ok').map(([k, st]) => `${k === 'dvla' ? 'DVLA' : 'MOT history'}: ${st}`);
    setStatus('car-lookup-status', problems.length ? `Updated, but — ${problems.join(' · ')}` : 'Up to date ✓', problems.length > 0);
  } catch (e) {
    say(`Couldn't get the details: ${e.message}`, true);
  } finally {
    carLookupBusy = false;
  }
}
function renderOfficial() {
  const out = $('official-out');
  if (!out) return;
  out.replaceChildren();
  const o = loadVehicle().official;
  if (!o) return;
  const card = el('div', { class: 'card' });
  const name = [o.make, o.model].filter(Boolean).join(' ') || o.reg;
  const spec = [o.colour, o.year, o.fuel, o.engineCc ? `${(o.engineCc / 1000).toFixed(1)} litre` : ''].filter(Boolean).join(' · ');
  card.append(el('h2', { text: name }), spec ? el('p', { class: 'muted', style: 'margin-top:-4px', text: spec }) : null);
  if (o.outstandingRecall) card.append(el('div', { class: 'state-note', style: 'margin:8px 0' }, el('span', { class: 'tag urgent', text: 'Outstanding recall' }), el('span', { text: '  The manufacturer has an open safety recall for this car — book it in at a dealer (it\'s free).' })));
  const dl = el('dl', { class: 'child-dl' });
  const row = (label, value, tag) => { if (!value) return; dl.append(el('dt', { text: label }), el('dd', {}, el('span', { text: value }), tag || null)); };
  const dueTag = (iso) => { const cd = iso && countdown(iso, ''); return cd ? el('span', { class: 'tag ' + cd.level, style: 'margin-left:6px', text: cd.days < 0 ? 'overdue' : `${cd.days} days` }) : null; };
  row('Tax', [o.taxStatus, o.taxDue ? 'until ' + fmtDate(o.taxDue) : ''].filter(Boolean).join(' '), dueTag(o.taxDue));
  row('MOT', [o.motStatus, o.motExpiry ? 'until ' + fmtDate(o.motExpiry) : ''].filter(Boolean).join(' '), dueTag(o.motExpiry));
  row('First registered', o.firstRegistered ? new Date(o.firstRegistered + (o.firstRegistered.length === 7 ? '-01' : '') + 'T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) : '');
  row('CO₂', o.co2 != null ? `${o.co2} g/km` : '');
  row('Average mileage', o.milesPerYear ? `about ${fmtNum(o.milesPerYear)} miles a year` : '');
  card.append(dl, el('p', { class: 'muted small', style: 'margin:10px 0 0', text: `From the DVLA and DVSA · updated ${new Date(loadVehicle().officialAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` }));
  out.append(el('h3', { text: 'Official record' }), card);
  if (!o.tests.length) return;
  const hist = el('div', { class: 'card' });
  o.tests.forEach((t, i) => {
    const sum = el('summary', { class: 'mot-sum' },
      el('span', { class: 'mot-date', text: fmtDate(t.date) }),
      el('span', { class: 'tag ' + (t.passed ? 'ok' : 'urgent'), text: t.result }),
      t.mileage != null ? el('span', { class: 'muted small', text: `${fmtNum(t.mileage)} mi` }) : null);
    const body = el('div', { class: 'mot-body' });
    if (!t.defects.length) body.append(el('p', { class: 'muted small', text: t.passed ? 'Clean pass — no advisories.' : 'No details recorded.' }));
    for (const x of t.defects) {
      const cls = x.type === 'DANGEROUS' || x.type === 'MAJOR' || x.type === 'FAIL' ? 'urgent' : x.type === 'MINOR' || x.type === 'PRS' ? 'soon' : 'minor';
      body.append(el('div', { class: 'mot-defect' }, el('span', { class: 'tag ' + cls, text: x.label }), el('span', { text: x.text })));
    }
    if (t.passed && t.expiry) body.append(el('p', { class: 'muted small', style: 'margin:6px 0 0', text: `Valid until ${fmtDate(t.expiry)}` }));
    hist.append(el('details', { class: 'mot-test', ...(i === 0 ? { open: '' } : {}) }, sum, body));
  });
  out.append(el('h3', { text: `MOT history (${o.tests.length})` }), hist);
}
$('btn-car-lookup').addEventListener('click', () => lookupCar(true));

// ---------- lost-phone protection ----------
// Each phone registers itself in the shared space with a one-way verifier of
// its owner's passphrase. The other phone can then report it lost — only with
// that owner's passphrase — which retires the old shared space on the server
// (deleting its data), moves your shared data to a new code, and flags the
// lost phone so Evergreen erases itself the next time it's opened online.
const DEVICE_KEY = 'evergreen-device';
const LOSTCHECK_KEY = 'evergreen-lostcheck';
function deviceId() {
  let d = null;
  try { d = localStorage.getItem(DEVICE_KEY); } catch { /* ignore */ }
  if (!d) {
    d = 'd' + fnv(String(Math.random()) + Date.now()) + fnv(String(Math.random()) + performance.now());
    try { localStorage.setItem(DEVICE_KEY, d); } catch { /* ignore */ }
  }
  return d;
}
const myDeviceRecordId = () => 'dev-' + deviceId();
const ownerLabel = () => (settings().myName || '').trim() || 'Unnamed';
async function ensureDeviceProtection(pass, force = false) {
  if (!paired() || !pass) return;
  const id = myDeviceRecordId();
  const rec = sharedItems('device').find((d) => d.id === id);
  if (rec && settings().devVerSet && !force) {
    if (rec.owner !== ownerLabel()) { sharedUpdate(id, { owner: ownerLabel() }); scheduleSync(); renderLost(); }
    return;
  }
  const verifier = await makeVerifier(pass);
  sharedSet({ id, type: 'device', dev: deviceId(), owner: ownerLabel(), calSrc: settings().calSrc || '', verifier, updatedAt: now(), deleted: false });
  saveSettings({ devVerSet: true });
  scheduleSync();
  renderLost();
}
// Remember (outside the encrypted vault) where to ask "has this phone been reported lost?",
// so the check can run on the lock screen, before anyone unlocks.
async function updateLostCheck() {
  try {
    const s = settings();
    if (!paired()) { localStorage.removeItem(LOSTCHECK_KEY); return; }
    localStorage.setItem(LOSTCHECK_KEY, JSON.stringify({ u: s.syncUrl.replace(/\/+$/, ''), h: await householdId(s.householdCode), d: deviceId() }));
  } catch { /* ignore */ }
}
let lostChecked = 0;
async function checkLostStatus(force = false) {
  if (!force && Date.now() - lostChecked < 60 * 1000) return;
  lostChecked = Date.now();
  let c = null;
  try { c = JSON.parse(localStorage.getItem(LOSTCHECK_KEY) || 'null'); } catch { /* ignore */ }
  if (!c || !c.u || !c.h) return;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(`${c.u}/status?h=${c.h}&d=${encodeURIComponent(c.d || '')}`, { cache: 'no-store', signal: ctl.signal });
    clearTimeout(timer);
    if (!r.ok) return;
    const st = await r.json();
    if (st.retired && st.wipe) wipeThisPhone();
    else if (st.retired && !vault.locked) setStatus('sync-status', 'Your shared space was reset by your partner — ask them for the new code and join again.', true);
  } catch { /* offline — try again next time */ }
}
// Optional: erase after too many wrong passphrases. Kept outside the vault
// (it has to work on the lock screen). Fingerprint failures don't count — the
// phone itself limits those.
const WIPE_TRIES_KEY = 'evergreen-wipe-after';
const FAILS_KEY = 'evergreen-fails';
const MAX_TRIES = 10;
const wipeAfterOn = () => { try { return localStorage.getItem(WIPE_TRIES_KEY) === '1'; } catch { return false; } };
function noteWrongPassphrase() {
  if (!wipeAfterOn()) return;
  let n = 0;
  try { n = (parseInt(localStorage.getItem(FAILS_KEY), 10) || 0) + 1; localStorage.setItem(FAILS_KEY, String(n)); } catch { return; }
  if (n >= MAX_TRIES) { wipeThisPhone('tries'); return; }
  const left = MAX_TRIES - n;
  if (left <= 5) $('lock-error').textContent = `Wrong passphrase. ${left} ${left === 1 ? 'try' : 'tries'} left before Evergreen erases itself on this phone.`;
}
function resetWrongPassphrases() { try { localStorage.removeItem(FAILS_KEY); } catch { /* ignore */ } }
function refreshWipeAfterUI() {
  $('wipe-after').checked = wipeAfterOn();
}
$('wipe-after').addEventListener('change', (e) => {
  if (e.target.checked) {
    if (!confirm(`Erase Evergreen on this phone after ${MAX_TRIES} wrong passphrase attempts in a row?\n\nShared things come back when you rejoin your shared space, but private things (documents, health, money…) only come back from a backup — save one first.`)) { e.target.checked = false; return; }
    try { localStorage.setItem(WIPE_TRIES_KEY, '1'); } catch { /* ignore */ }
    resetWrongPassphrases();
    setStatus('security-status', `On — Evergreen erases itself after ${MAX_TRIES} wrong passphrase attempts in a row.`);
  } else {
    try { localStorage.removeItem(WIPE_TRIES_KEY); localStorage.removeItem(FAILS_KEY); } catch { /* ignore */ }
    setStatus('security-status', 'Off.');
  }
});
function wipeThisPhone(reason = 'lost') {
  try { vault.destroy(); } catch { /* ignore */ }
  try { indexedDB.deleteDatabase('evergreen-media'); } catch { /* ignore */ }
  try { indexedDB.deleteDatabase('evergreen-files'); } catch { /* ignore */ }
  try { localStorage.clear(); } catch { /* ignore */ }
  try { caches.keys().then((ks) => ks.forEach((k) => caches.delete(k))); } catch { /* ignore */ }
  location.replace(location.pathname + '?wiped=' + reason);
}
async function reportLost(d) {
  const s = settings();
  const oldHid = await householdId(s.householdCode);
  const r = await fetch(`${s.syncUrl.replace(/\/+$/, '')}/retire?h=${oldHid}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Evergreen-Token': await writeToken(s.householdCode) }, body: JSON.stringify({ wipe: [d.dev] }),
  });
  if (!r.ok) { let m = ''; try { m = (await r.json()).error; } catch { /* not json */ } throw new Error(m || `the server returned ${r.status}`); }
  // The lost phone's record and its calendar events go; your data moves to a fresh space with a new code.
  sharedRemove(d.id);
  for (const e of sharedItems('event')) if (e.src && ((d.calSrc && e.src === d.calSrc) || (e.who && e.who === d.owner))) sharedRemove(e.id);
  const code = generateHouseholdCode();
  saveSettings({ householdCode: code });
  refreshPairUI();
  await syncNow();
  await updateLostCheck();
  return code;
}
const lostTries = { count: 0, until: 0 };
function openReportLost(d) {
  const pass = el('input', { type: 'password', autocomplete: 'off', placeholder: `${d.owner}'s Evergreen passphrase` });
  const msg = el('p', { class: 'status', role: 'status' });
  const go = el('button', { class: 'danger', text: 'Lock out & erase' });
  const cancel = el('button', { text: 'Cancel' });
  cancel.addEventListener('click', closeSheet);
  go.addEventListener('click', async () => {
    msg.classList.remove('error');
    if (Date.now() < lostTries.until) { msg.textContent = `Too many wrong tries — wait ${Math.ceil((lostTries.until - Date.now()) / 60000)} min.`; msg.classList.add('error'); return; }
    if (!pass.value) { pass.focus(); return; }
    go.disabled = true; cancel.disabled = true;
    msg.textContent = 'Checking the passphrase…';
    try {
      if (!(await checkVerifier(pass.value, d.verifier))) {
        lostTries.count++;
        if (lostTries.count >= 5) { lostTries.until = Date.now() + 15 * 60000; lostTries.count = 0; }
        msg.textContent = `That's not ${d.owner}'s passphrase.`; msg.classList.add('error');
        return;
      }
      lostTries.count = 0;
      msg.textContent = 'Locking it out…';
      const code = await reportLost(d);
      haptic();
      openSheet(el('div', { class: 'sheet-icon', text: '🔒' }), el('h2', { text: `${d.owner}'s phone is locked out` }),
        el('p', { text: `It can no longer see your shared lists, calendar or bills, and the old copy has been deleted from your server. The next time Evergreen is opened on that phone with signal, it erases itself.` }),
        el('p', { class: 'muted', text: `Your shared space now has a new code. When ${d.owner} has a phone again, install Evergreen, then Settings → Sharing → Join with a code:` }),
        el('div', { class: 'loyal-number', text: code }),
        el('div', { class: 'row' }, (() => { const b = el('button', { class: 'primary', text: 'Done' }); b.addEventListener('click', closeSheet); return b; })()));
      renderLost();
    } catch (e) {
      msg.textContent = `Couldn't do that: ${e.message}. Check you're online and try again.`; msg.classList.add('error');
    } finally {
      go.disabled = false; cancel.disabled = false;
    }
  });
  openSheet(el('div', { class: 'sheet-icon', text: '📵' }), el('h2', { text: `Is ${d.owner}'s phone lost or stolen?` }),
    el('ul', { class: 'small' },
      el('li', { text: 'It is cut off from your shared lists, calendar, bills and meters straight away.' }),
      el('li', { text: 'The next time Evergreen is opened on it with signal — even on the lock screen — it erases itself.' }),
      el('li', { text: "You get a new sharing code to set them up again. This can't be undone." })),
    el('label', { class: 'field' }, `To confirm, enter ${d.owner}'s Evergreen passphrase`, pass), msg,
    el('div', { class: 'row' }, cancel, go));
  setTimeout(() => pass.focus(), 60);
}
function openProtectThisPhone() {
  const pass = el('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Your Evergreen passphrase' });
  const msg = el('p', { class: 'status', role: 'status' });
  const ok = el('button', { class: 'primary', text: 'Protect this phone' });
  ok.addEventListener('click', async () => {
    if (!(await vault.verify(pass.value))) { msg.textContent = 'Wrong passphrase.'; msg.classList.add('error'); return; }
    msg.classList.remove('error'); msg.textContent = 'Setting up…'; ok.disabled = true;
    await ensureDeviceProtection(pass.value, true);
    closeSheet(); toast('This phone is protected ✓');
  });
  openSheet(el('h2', { text: 'Protect this phone' }),
    el('p', { class: 'muted', text: 'Confirm your passphrase so your partner can lock this phone out if it is ever lost — but only by entering your passphrase.' }),
    el('label', { class: 'field' }, 'Your passphrase', pass), msg, el('div', { class: 'row' }, ok));
  setTimeout(() => pass.focus(), 60);
}
function renderLost() {
  const box = $('lost-list');
  if (!box) return;
  box.replaceChildren();
  const mineId = myDeviceRecordId();
  const devices = sharedItems('device');
  const mine = devices.find((d) => d.id === mineId);
  const rows = el('ul', { class: 'list' });
  const meRow = el('div', { class: 'line' }, el('div', {}, el('div', { class: 'name', text: 'This phone' }),
    el('div', { class: 'sub', text: mine ? 'Protected ✓' : 'Not protected yet' })));
  if (!mine) { const b = el('button', { text: 'Protect it' }); b.addEventListener('click', openProtectThisPhone); meRow.append(b); }
  rows.append(el('li', {}, meRow));
  const others = devices.filter((d) => d.id !== mineId);
  for (const d of others) {
    const b = el('button', { class: 'danger', text: 'Report lost' });
    b.addEventListener('click', () => openReportLost(d));
    rows.append(el('li', {}, el('div', { class: 'line' }, el('div', {}, el('div', { class: 'name', text: `${d.owner}'s phone` }), el('div', { class: 'sub', text: 'Protected ✓' })), b)));
  }
  box.append(rows);
  if (!others.length) box.append(el('p', { class: 'muted small', text: "Your partner's phone appears here after they unlock Evergreen on it once." }));
}

// ---------- app updates ----------
// Must match CACHE in sw.js (a test checks this).
const APP_VERSION = 'evergreen-v66';
let updateReady = false;
async function checkForUpdate(manual = false) {
  try {
    const txt = await (await fetch('sw.js', { cache: 'no-store' })).text();
    const live = (txt.match(/evergreen-v\d+/) || [])[0];
    if (live && live !== APP_VERSION) {
      updateReady = true;
      $('update-banner').hidden = false;
      return true;
    }
    if (manual) toast("You're on the latest version ✓");
  } catch {
    if (manual) toast('Could not check — are you online?');
  }
  return false;
}
$('btn-update-now').addEventListener('click', async () => {
  $('btn-update-now').disabled = true;
  try { const reg = await navigator.serviceWorker?.getRegistration(); await reg?.update(); } catch { /* reload anyway */ }
  location.reload();
});
$('btn-check-update').addEventListener('click', () => checkForUpdate(true));
$('app-version').textContent = 'You have version ' + APP_VERSION.split('-v')[1] + '.';
document.addEventListener('visibilitychange', () => { if (!document.hidden && !updateReady) checkForUpdate(); });
setInterval(() => { if (!document.hidden && !updateReady) checkForUpdate(); }, 30 * 60 * 1000);

// ---------- startup ----------
async function migratePhotos() {
  if (!mediaKey) return;
  for (const key of [DOCS_KEY, INV_KEY]) {
    const items = store.load(key, []);
    let changed = false;
    for (const it of items) {
      if (it.photo && !it.photoId) {
        try {
          const id = 'p' + Date.now() + Math.random().toString(36).slice(2, 6);
          await savePhoto(id, it.photo, mediaKey);
          it.photoId = id;
          delete it.photo;
          changed = true;
        } catch {
          /* leave the photo inline if migration fails */
        }
      }
    }
    if (changed) store.save(key, items);
  }
}

async function initAll() {
  try {
    mediaKey = await vault.mediaKey();
    knownIds = new Set(Object.keys(store.load(SHARED_KEY, {}))); // what's here now counts as seen
    // Checks run on the demo car used to be saved like real ones — clear them out.
    const realChecks = loadHistory().filter((r) => !r.demo && r.vin !== DEMO_VIN);
    if (realChecks.length !== loadHistory().length) store.save(HISTORY_KEY, realChecks);
    setTimeout(() => checkInbox(true), 2500); // parcels the morning check dropped off
    await migratePhotos();
  } catch (e) {
    log('info', 'Media key/migrate: ' + e.message);
  }
  migrateToShared();
  setConnected(false);
  renderHistory();
  renderTrips();
  initCarTab();
  renderDocs();
  renderDeliveries();
  renderFamily();
  renderTravel();
  migrateInsurance();
  migrateWarranties();
  renderPolicies();
  renderHouse();
  syncCarInsurance();
  renderCalendar();
  initLifeSections();
  renderHome();
  $('conn').style.display = 'none'; // Home is the default screen
  refreshBiometricButtons();
  refreshWipeAfterUI();
  if (!bluetoothSupported()) {
    $('unsupported').hidden = false;
    $('btn-connect').disabled = true;
  } else {
    refreshReconnect();
  }
  handleLaunchParams();
  checkForUpdate();
  refreshCalConnectUI();
  syncNow().then(() => pullCalendar());
}

try {
  applyTextSize(localStorage.getItem(TEXT_KEY) || 'normal');
} catch {
  applyTextSize('normal');
}
// iOS: request durable storage and show an install hint (Safari can't prompt).
(function iosSetup() {
  try {
    navigator.storage?.persist?.();
  } catch {
    /* ignore */
  }
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  let dismissed = false;
  try {
    dismissed = localStorage.getItem('evergreen-ios-hint') === '1';
  } catch {
    /* ignore */
  }
  if (isIOS && !standalone && !dismissed) {
    $('ios-install').hidden = false;
    $('ios-install-close').addEventListener('click', () => {
      $('ios-install').hidden = true;
      try {
        localStorage.setItem('evergreen-ios-hint', '1');
      } catch {
        /* ignore */
      }
    });
  }
})();

initLifeNav();
initCarNav();
showLockScreen();
checkLostStatus(true); // runs on the lock screen too, before anyone unlocks
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkLostStatus(); });
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
