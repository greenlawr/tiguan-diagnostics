import { Elm } from './elm.js';
import { BleTransport, bluetoothSupported, rememberedAdapters } from './ble.js';
import { SimulatorTransport } from './simulator.js';
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
import { generateHouseholdCode, normalizeCode } from './household.js';
import { syncShared } from './sync.js';
import { savePhoto, loadPhoto, deletePhoto, exportAllPhotos, importAllPhotos } from './photos.js';
import { parseImport, importCount } from './import.js';
import { icon, TILE_ICON, SEC_ICON_NAME } from './icons.js';

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
    vault.set(key, value).catch((e) => log('info', 'Save failed: ' + e.message));
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
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.nav-pill').forEach((b) => b.classList.toggle('current', b.dataset.go === name));
  if (name !== 'live') stopLive();
  if (name === 'help') renderLog();
  if (name === 'home') renderHome();
  if (name === 'life') { showLifeSection(pendingLifeSection); pendingLifeSection = null; }
  // The connection pill only matters on the car screens.
  $('conn').style.display = ['check', 'live', 'trips'].includes(name) || elm ? '' : 'none';
  window.scrollTo(0, 0);
}
document.querySelectorAll('.tabs button').forEach((btn) => btn.addEventListener('click', () => showTab(btn.dataset.tab)));
document.querySelectorAll('.nav-pill').forEach((btn) => btn.addEventListener('click', () => showTab(btn.dataset.go)));
// ----- Life tab as a focused hub-and-spoke -----
const SEC_ICON = { deliveries: '📦', documents: '📄', utilities: '⚡', subscriptions: '🔁', tax: '💷', home: '🏠', health: '❤️', loyalty: '💳', sharing: '📅', shopping: '🛒' };
let pendingLifeSection = null;
function initLifeNav() {
  const tab = $('tab-life');
  const back = el('div', { id: 'life-back', class: 'life-back', hidden: '' });
  const backBtn = el('button', { class: 'nav-pill', text: '‹ All' });
  backBtn.addEventListener('click', () => showLifeSection(null));
  back.append(backBtn, el('span', { id: 'life-back-title', class: 'name' }));

  const menu = el('div', { id: 'life-menu', class: 'tiles' });
  for (const h of tab.querySelectorAll(':scope > h3[id^="sec-"]')) {
    const name = h.id.slice(4);
    const btn = el('button', { class: 'tile-btn' }, icon(SEC_ICON_NAME[name] || 'doc'), el('span', { class: 'tile-label', text: h.textContent }));
    btn.addEventListener('click', () => { haptic(); showLifeSection(name); });
    menu.append(btn);
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
  menu.hidden = !showMenu;
  back.hidden = showMenu;
  if (!showMenu) $('life-back-title').textContent = $('sec-' + name)?.textContent || '';
  for (const child of tab.children) {
    if (child === menu || child === back || child.dataset.lifeAlways) continue;
    child.hidden = showMenu ? true : child.dataset.lifeSec !== name;
  }
  window.scrollTo(0, 0);
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
    saveReport(report);
    renderReport(report, { previous });
    renderHistory();
    setStatus('check-status', '');
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
  const since = `since your last check on ${new Date(diff.prevDate).toLocaleDateString()}`;
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
      el('div', { class: 'when', text: (past ? 'Saved check from ' : 'Checked ') + new Date(r.date).toLocaleString() })
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
    list.append(
      el(
        'li',
        {},
        el(
          'div',
          { class: 'line' },
          el('div', {}, el('div', { class: 'name', text: new Date(r.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) }), el('span', { class: 'tag ' + r.level, text: r.headline })),
          btn
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
  if (save && trip && trip.distanceKm > 0.05) {
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
    const when = new Date(t.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    const detail = `${t.miles.toFixed(1)} miles · ${formatDuration(t.seconds)}${t.avgMpg > 0 ? ` · ${t.avgMpg.toFixed(1)} mpg` : ''}`;
    list.append(el('li', {}, el('div', { class: 'line' }, el('div', {}, el('div', { class: 'name', text: when }), el('div', { class: 'sub', text: detail })))));
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

const fmtDate = (iso) => new Date(iso + (iso.length === 10 ? 'T00:00:00' : '')).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

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
});
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
    const detail = `${f.litres.toFixed(1)} L${f.cost ? ` · £${f.cost.toFixed(2)}` : ''} · ${f.odo.toLocaleString()} mi${seg ? ` · ${seg.mpg.toFixed(1)} mpg` : ''}`;
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
  const entry = { id: Date.now(), date: $('fuel-date').value || new Date().toISOString().slice(0, 10), odo, litres, cost: num('fuel-cost'), full: $('fuel-full').checked };
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
    const detail = `${r.odo ? r.odo.toLocaleString() + ' mi' : ''}${r.odo && r.cost ? ' · ' : ''}${r.cost ? '£' + r.cost.toFixed(2) : ''}`;
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
  const entry = { id: Date.now(), date: $('svc-date').value || new Date().toISOString().slice(0, 10), odo: num('svc-odo'), what, cost: num('svc-cost') };
  store.save(SERVICE_KEY, [entry, ...store.load(SERVICE_KEY, [])]);
  for (const id of ['svc-odo', 'svc-what', 'svc-cost']) $(id).value = '';
  renderService();
});

// Mileage log
function renderMileage() {
  const trips = store.load(MILEAGE_KEY, []);
  const m = mileageSummary(trips);
  $('mileage-summary').replaceChildren(
    el('div', { class: 'tile' }, el('div', { class: 'label', text: 'Business miles' }), el('div', { class: 'value' }, el('span', { text: Math.round(m.businessMiles).toLocaleString() }))),
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
  const entry = { id: Date.now(), date: $('mile-date').value || new Date().toISOString().slice(0, 10), miles, purpose: $('mile-purpose').value.trim(), business: $('mile-business').checked };
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
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js';
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
function compressImage(file, maxSize = 900, quality = 0.6) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the photo.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not an image.'));
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ---------- deliveries ----------
const DELIVERIES_KEY = 'tiguan-deliveries';
const EVENTS_KEY = 'tiguan-events';

function renderDeliveries() {
  const sel = $('del-carrier');
  if (sel && !sel.options.length) for (const name of CARRIER_NAMES) sel.add(new Option(name, name));
  const items = store.load(DELIVERIES_KEY, []).filter((d) => !d.done);
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
      const all = store.load(DELIVERIES_KEY, []).map((x) => (x.id === d.id ? { ...x, done: true } : x));
      store.save(DELIVERIES_KEY, all);
      renderDeliveries();
      renderDashboard();
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
  const entry = { id: Date.now(), item, carrier: $('del-carrier').value, tracking, expected: $('del-expected').value, done: false };
  store.save(DELIVERIES_KEY, [entry, ...store.load(DELIVERIES_KEY, [])]);
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
  const anyList = [DOCS_KEY, UTIL_KEY, SUBS_KEY, DELIVERIES_KEY, LOYAL_KEY, MAINT_KEY, CHECK_KEY, INV_KEY].some((k) => store.load(k, []).length);
  const anyShopping = Object.values(store.load(SHARED_KEY, {})).some((i) => !i.deleted);
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
  { icon: '🩺', label: 'Car check', go: () => showTab('check') },
  { icon: '🚗', label: 'My car', go: () => showTab('car') },
  { icon: '🛒', label: 'Shopping list', go: () => goLife('shopping'), badge: () => { const n = Object.values(store.load(SHARED_KEY, {})).filter((i) => !i.deleted && !i.done).length; return n ? { text: String(n), cls: 'minor' } : null; } },
  { icon: '📄', label: 'Documents', go: () => goLife('documents'), badge: () => { const soon = store.load(DOCS_KEY, []).filter((d) => d.expiry && countdown(d.expiry, '').days <= 30).length; return soon ? { text: String(soon), cls: 'soon' } : null; } },
  { icon: '⚡', label: 'Utilities', go: () => goLife('utilities'), badge: () => { const soon = store.load(UTIL_KEY, []).filter((u) => u.renewal && countdown(u.renewal, '').days <= 30).length; return soon ? { text: String(soon), cls: 'soon' } : null; } },
  { icon: '💷', label: 'Money & tax', go: () => goLife('tax') },
  { icon: '🏠', label: 'Home', go: () => goLife('home') },
  { icon: '❤️', label: 'Health', go: () => goLife('health') },
  { icon: '📦', label: 'Deliveries', go: () => goLife('deliveries'), badge: () => { const n = store.load(DELIVERIES_KEY, []).filter((d) => !d.done).length; return n ? { text: String(n), cls: 'minor' } : null; } },
  { icon: '💳', label: 'Loyalty', go: () => goLife('loyalty') },
  { icon: '⛽', label: 'Trips', go: () => showTab('trips') },
  { icon: '⚙️', label: 'Settings', go: () => showTab('help') },
];
function renderTiles() {
  const grid = $('home-tiles');
  if (!grid) return;
  grid.replaceChildren();
  for (const t of HOME_TILES) {
    const tile = el('button', { class: 'tile-btn' }, icon(TILE_ICON[t.label] || 'doc'), el('span', { class: 'tile-label', text: t.label }));
    const badge = t.badge && t.badge();
    if (badge) tile.append(el('span', { class: 'tag ' + badge.cls, text: badge.text }));
    tile.addEventListener('click', () => { haptic(); t.go(); });
    grid.append(tile);
  }
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
  const rows = store.load(EVENTS_KEY, []).filter((e) => {
    if (!e.date) return false;
    const d = new Date(e.date + 'T00:00:00');
    return !isNaN(d) && d >= today && d < horizon;
  });
  rows.sort((a, b) => ((eventStart(a)?.getTime() || 0) - (eventStart(b)?.getTime() || 0)));
  return rows;
}
/** Drop events whose day has passed, so the store doesn't grow forever. */
function pruneEvents() {
  const all = store.load(EVENTS_KEY, []);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const kept = all.filter((e) => { if (!e.date) return true; const d = new Date(e.date + 'T00:00:00'); return !isNaN(d) && d >= today; });
  if (kept.length !== all.length) store.save(EVENTS_KEY, kept);
}
function dayLabel(isoDate) {
  const d = new Date(isoDate + 'T00:00:00');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((d - today) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
}
function renderAgenda(out) {
  pruneEvents();
  const rows = upcomingEvents(7);
  if (!rows.length) return;
  const card = el('div', { class: 'card' }, el('h2', { text: 'This week' }));
  let lastDay = null;
  for (const e of rows) {
    if (e.date !== lastDay) { card.append(el('div', { class: 'agenda-day', text: dayLabel(e.date) })); lastDay = e.date; }
    const when = /^\d/.test((e.time || '').trim()) ? e.time.trim() : 'All day';
    card.append(el('div', { class: 'line' },
      el('div', {}, el('div', { class: 'name', text: e.title || 'Event' }), e.where ? el('div', { class: 'sub', text: e.where }) : el('div', { class: 'sub', text: '' })),
      el('span', { class: 'tag dim', text: when })
    ));
  }
  out.append(card);
}

function renderDashboard() {
  const out = $('dashboard');
  if (!out) return;
  const v = loadVehicle();
  const items = upcomingReminders({
    renewalDates: { mot: v.mot, tax: v.tax, insurance: v.insurance, service: v.service },
    documents: store.load(DOCS_KEY, []),
  });
  for (const d of store.load(DELIVERIES_KEY, [])) {
    if (d.done || !d.expected) continue;
    const s = parcelStatus(d.expected);
    if (s.days == null) continue;
    items.push({ label: d.item || 'Parcel', sub: 'Delivery', days: s.days, level: s.level === 'dim' ? 'ok' : s.level, text: s.text });
  }
  items.push(...collectExtraReminders());
  items.sort((a, b) => a.days - b.days);
  const pressing = items.filter((i) => i.level === 'urgent' || i.level === 'soon').length;
  const summary = !items.length
    ? 'Nothing with a date yet — add renewals or documents below and they\'ll show here.'
    : pressing
      ? `${pressing} thing${pressing === 1 ? ' needs' : 's need'} attention soon.`
      : 'Nothing pressing — you\'re on top of things.';
  const card = el('div', { class: 'verdict ' + (items[0]?.level === 'urgent' ? 'urgent' : pressing ? 'soon' : 'ok') },
    el('div', { class: 'headline', text: greeting() }),
    el('p', { text: summary })
  );
  out.replaceChildren(card);

  if (isAppEmpty()) out.append(welcomeCard());

  renderAgenda(out);

  if (items.length) {
    const list = el('ul', { class: 'list' });
    for (const i of items.slice(0, 8)) {
      list.append(el('li', {}, el('div', { class: 'line' },
        el('div', {}, el('div', { class: 'name', text: i.label }), el('div', { class: 'sub', text: i.sub })),
        el('span', { class: 'tag ' + i.level, text: i.text.replace(i.label + ' ', '') })
      )));
    }
    out.append(el('div', { class: 'card' }, el('h2', { text: 'Coming up' }), list));
  }

  // "Time to compare" nudge for utilities renewing within ~30 days.
  const dueUtils = store.load(UTIL_KEY, []).filter((u) => {
    if (!u.renewal) return false;
    const cd = countdown(u.renewal, u.type);
    return cd && cd.days <= 30;
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
const SUBS_KEY = 'tiguan-subscriptions';
const INV_KEY = 'tiguan-inventory';
const METER_KEY = 'tiguan-meters';
const MAINT_KEY = 'tiguan-maintenance';
const CHECK_KEY = 'tiguan-checkups';
const MONEY_KEY = 'tiguan-money';
const EMG_KEY = 'tiguan-emergency';
const SETTINGS_KEY = 'tiguan-settings';

const partnerEmail = () => (store.load(SETTINGS_KEY, {}).partnerEmail || '').trim();
const money = (n) => '£' + Math.round(n).toLocaleString();
const COMPARE = { Energy: 'https://www.moneysavingexpert.com/utilities/', Broadband: 'https://www.moneysavingexpert.com/broadband/', Mobile: 'https://www.moneysavingexpert.com/mobiles/', Insurance: 'https://www.moneysavingexpert.com/insurance/' };

// Utilities
function renderUtilities() {
  const items = store.load(UTIL_KEY, []);
  const list = $('util-list');
  list.replaceChildren();
  for (const u of [...items].sort((a, b) => (a.renewal || '9') < (b.renewal || '9') ? -1 : 1)) {
    const cd = u.renewal ? countdown(u.renewal, u.type) : null;
    const sub = [u.provider, u.cost ? money(u.cost) + '/mo' : null].filter(Boolean).join(' · ');
    const row = el('div', { class: 'card doc' }, el('div', { class: 'line' },
      el('div', {}, el('div', { class: 'name', text: u.type }), el('div', { class: 'sub', text: sub })),
      cd ? el('span', { class: 'tag ' + cd.level, text: cd.text.replace(u.type + ' ', '') }) : null));
    if (u.tariff || u.usage) {
      row.append(el('div', { class: 'sub', style: 'margin-top:6px', text: [u.tariff, u.usage].filter(Boolean).join(' · ') }));
    }
    const actions = el('div', { class: 'row', style: 'margin-top:10px' });
    const rec = el('button', { text: 'Get a recommendation' });
    rec.addEventListener('click', async () => {
      const text = utilityBrief(u);
      try {
        if (navigator.share) await navigator.share({ title: `Compare my ${u.type} deal`, text });
        else { await navigator.clipboard.writeText(text); rec.textContent = 'Copied — paste it to Claude'; setTimeout(() => (rec.textContent = 'Get a recommendation'), 2500); }
      } catch { /* share closed */ }
    });
    actions.append(rec);
    const saveRec = el('button', { text: u.recommendation ? 'Update options' : 'Save options' });
    saveRec.addEventListener('click', () => openRecModal(u.id));
    actions.append(saveRec);
    if (COMPARE[u.type]) actions.append(el('a', { class: 'btn-a', href: COMPARE[u.type], target: '_blank', rel: 'noopener', text: 'Compare site' }));
    if (u.renewal) actions.append(el('a', { class: 'btn-a', href: calendarEvent(`${u.type} renewal${u.provider ? ' – ' + u.provider : ''}`, u.renewal, { guests: partnerEmail() }), target: '_blank', rel: 'noopener', text: 'Remind me' }));
    const del = el('button', { class: 'del', text: '✕' });
    del.addEventListener('click', () => deleteItem(UTIL_KEY, u.id, () => { renderUtilities(); renderDashboard(); }, { label: u.type }));
    actions.append(del);
    row.append(actions);
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
  const u = store.load(UTIL_KEY, []).find((x) => x.id === id);
  $('rec-text').value = u && u.recommendation ? u.recommendation.text : '';
  $('rec-modal').hidden = false;
  $('rec-text').focus();
}
$('rec-cancel').addEventListener('click', () => { $('rec-modal').hidden = true; recUtilId = null; });
$('rec-save').addEventListener('click', () => {
  const text = $('rec-text').value.trim();
  const all = store.load(UTIL_KEY, []);
  const u = all.find((x) => x.id === recUtilId);
  if (u) {
    u.recommendation = text ? { text, savedAt: new Date().toISOString(), bestMonthly: parseBestMonthly(text) } : null;
    store.save(UTIL_KEY, all);
  }
  $('rec-modal').hidden = true;
  recUtilId = null;
  renderUtilities();
  renderDashboard();
});

function utilityBrief(u) {
  return [
    `I'd like to compare my ${u.type.toLowerCase()} deal and find something cheaper (UK).`,
    `Current provider: ${u.provider || '(not set)'}`,
    u.tariff ? `Tariff: ${u.tariff}` : null,
    u.cost ? `Paying: £${u.cost}/month (about £${Math.round(u.cost * 12)}/year)` : null,
    u.usage ? `My usage: ${u.usage}` : null,
    u.renewal ? `Contract ends / renews: ${fmtDate(u.renewal)}` : null,
    'Please find current deals that beat this and recommend the best value, flagging any exit fees or switching catches.',
  ].filter(Boolean).join('\n');
}
$('btn-util-add').addEventListener('click', () => {
  const entry = { id: Date.now(), type: $('util-type').value, provider: $('util-provider').value.trim(), tariff: $('util-tariff').value.trim(), cost: parseFloat($('util-cost').value) || 0, renewal: $('util-renewal').value, usage: $('util-usage').value.trim() };
  store.save(UTIL_KEY, [entry, ...store.load(UTIL_KEY, [])]);
  for (const id of ['util-provider', 'util-tariff', 'util-cost', 'util-renewal', 'util-usage']) $(id).value = '';
  renderUtilities(); renderDashboard(); toast('Plan added ✓');
});

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
  const m = moneyOverview(store.load(SUBS_KEY, []), store.load(UTIL_KEY, []));
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
    const sub = [it.room, it.value ? money(it.value) : null, it.serial ? 'S/N ' + it.serial : null].filter(Boolean).join(' · ');
    const card = el('div', { class: 'card doc' }, el('div', { class: 'line' }, el('div', {}, el('div', { class: 'name', text: it.name }), el('div', { class: 'sub', text: sub })), null));
    attachPhoto(card, it, it.name);
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
    const entry = { id: Date.now(), name, room: $('inv-room').value.trim(), value: parseFloat($('inv-value').value) || 0, serial: $('inv-serial').value.trim() };
    const file = $('inv-photo').files[0];
    if (file && mediaKey) {
      entry.photoId = 'p' + Date.now() + Math.random().toString(36).slice(2, 6);
      await savePhoto(entry.photoId, await compressImage(file), mediaKey);
    }
    store.save(INV_KEY, [entry, ...store.load(INV_KEY, [])]);
    for (const id of ['inv-name', 'inv-room', 'inv-value', 'inv-serial', 'inv-photo']) $(id).value = '';
    renderInventory();
  } finally { btn.disabled = false; }
});

// Home: meter readings
function renderMeters() {
  const all = store.load(METER_KEY, []);
  const byType = {};
  for (const r of all) (byType[r.type] ||= []).push(r);
  const u = $('meter-usage');
  const parts = [];
  for (const [type, rows] of Object.entries(byType)) { const m = meterUsage(rows); if (m) parts.push(`${type}: ${m.perDay.toFixed(1)}/day`); }
  u.textContent = parts.join(' · ');
  const list = $('meter-list');
  list.replaceChildren();
  for (const r of [...all].sort((a, b) => (a.date < b.date ? 1 : -1))) {
    list.append(deletableRow(`${r.type} — ${r.reading}`, fmtDate(r.date), () => { store.save(METER_KEY, all.filter((x) => x.id !== r.id)); renderMeters(); }));
  }
}
$('btn-meter-add').addEventListener('click', () => {
  const reading = parseFloat($('meter-reading').value);
  if (isNaN(reading)) return alert('Please enter the reading.');
  const entry = { id: Date.now(), type: $('meter-type').value, date: $('meter-date').value || new Date().toISOString().slice(0, 10), reading };
  store.save(METER_KEY, [entry, ...store.load(METER_KEY, [])]);
  $('meter-reading').value = '';
  renderMeters();
});

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
function renderCheckups() {
  const items = store.load(CHECK_KEY, []);
  const list = $('check-list');
  list.replaceChildren();
  for (const c of items) {
    const due = nextDue(c.last, c.interval);
    const cd = due ? countdown(due, c.type) : null;
    const row = el('li', {}, el('div', { class: 'line' },
      el('div', {}, el('div', { class: 'name', text: c.type }), el('div', { class: 'sub', text: c.last ? 'Last ' + fmtDate(c.last) : '' })),
      cd ? el('span', { class: 'tag ' + cd.level, text: cd.text.replace(c.type + ' ', '') }) : null));
    const del = el('button', { class: 'del', text: '✕' });
    del.addEventListener('click', () => deleteItem(CHECK_KEY, c.id, () => { renderCheckups(); renderDashboard(); }, { label: c.type }));
    row.querySelector('.line').append(del);
    list.append(row);
  }
}
$('btn-check-add').addEventListener('click', () => {
  const type = $('check-type').value.trim();
  if (!type) return alert('Please name the check-up.');
  store.save(CHECK_KEY, [{ id: Date.now(), type, last: $('check-last').value, interval: parseInt($('check-interval').value) || 0 }, ...store.load(CHECK_KEY, [])]);
  for (const id of ['check-type', 'check-last', 'check-interval']) $(id).value = '';
  renderCheckups(); renderDashboard();
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
function collectExtraReminders() {
  const items = [];
  const add = (date, label, sub) => { const cd = date ? countdown(date, label) : null; if (cd) items.push({ label, sub, days: cd.days, level: cd.level, text: cd.text }); };
  for (const u of store.load(UTIL_KEY, [])) add(u.renewal, u.type + (u.provider ? ' (' + u.provider + ')' : ''), 'Utilities');
  for (const s of store.load(SUBS_KEY, [])) add(s.renewal, s.name, 'Subscription');
  for (const m of store.load(MAINT_KEY, [])) add(m.date, m.task, 'Home');
  for (const c of store.load(CHECK_KEY, [])) add(nextDue(c.last, c.interval), c.type, 'Health');
  for (const d of taxDeadlines()) add(d.date, d.label, 'Tax');
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
    $('scan-modal').hidden = false;
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
  syncNow();
});
$('btn-pair-leave').addEventListener('click', () => {
  if (!confirm('Leave the shared space on this phone? Your partner keeps theirs, and you can rejoin with the code.')) return;
  saveSettings({ householdCode: '' });
  store.save(SHARED_KEY, {});
  refreshPairUI();
});
$('btn-sync').addEventListener('click', () => syncNow());

// Automatic sync: when the app comes back to the screen, when the phone gets
// signal back, and every minute while it's open. Only ever while unlocked.
const AUTO_SYNC_MS = 60 * 1000;
function autoSync() {
  if (!vault.locked && !document.hidden && paired()) syncNow();
}
document.addEventListener('visibilitychange', autoSync);
window.addEventListener('online', autoSync);
setInterval(autoSync, AUTO_SYNC_MS);

let syncTimer = null;
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 1200);
}
let syncing = false;
async function syncNow() {
  if (!paired() || syncing) return;
  syncing = true;
  setStatus('sync-status', 'Syncing…');
  try {
    const s = settings();
    const merged = await syncShared(s.syncUrl, s.householdCode, store.load(SHARED_KEY, {}));
    store.save(SHARED_KEY, merged);
    renderSharedAll();
    setStatus('sync-status', 'Synced ' + new Date().toLocaleTimeString());
  } catch (e) {
    setStatus('sync-status', 'Could not sync (offline, or check the server address).', true);
    log('info', 'Sync failed: ' + e.message);
  } finally {
    syncing = false;
  }
}

// Shared space helpers (all shared types live in SHARED_KEY, tagged by `type`).
function sharedSet(item) { const all = store.load(SHARED_KEY, {}); all[item.id] = item; store.save(SHARED_KEY, all); }
function sharedUpdate(id, patch) { const all = store.load(SHARED_KEY, {}); if (all[id]) { all[id] = { ...all[id], ...patch, updatedAt: now() }; store.save(SHARED_KEY, all); } }
const sharedItems = (type) => Object.values(store.load(SHARED_KEY, {})).filter((i) => !i.deleted && (i.type || 'shop') === type);
const myName = () => (settings().myName || '').trim() || 'Me';
const partnerName = () => (settings().partnerName || '').trim() || 'Partner';
function peopleOptions(sel, includeAnyone) {
  const keep = sel.value;
  sel.replaceChildren();
  if (includeAnyone) sel.add(new Option('Anyone', 'Anyone'));
  for (const n of [myName(), partnerName()]) sel.add(new Option(n, n));
  if (keep) sel.value = keep;
}
function renderSharedAll() { renderShared(); renderBills(); renderTasks(); }

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
  const id = 'b' + now() + Math.random().toString(36).slice(2, 6);
  sharedSet({ id, type: 'bill', name, amount, paidBy: $('bill-paidby').value, split: $('bill-split').checked, date: $('bill-date').value || new Date().toISOString().slice(0, 10), settled: false, updatedAt: now(), deleted: false });
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
    const del = el('button', { class: 'del', text: '✕' });
    del.addEventListener('click', () => { sharedUpdate(t.id, { deleted: true }); renderTasks(); scheduleSync(); toast('Deleted', { actionLabel: 'Undo', onAction: () => { sharedUpdate(t.id, { deleted: false }); renderTasks(); scheduleSync(); } }); });
    list.append(el('li', {}, el('label', { class: 'check', style: 'margin:0;flex:1' }, box, label), who, del));
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

function renderShared() {
  const items = store.load(SHARED_KEY, {});
  const list = $('shared-list');
  list.replaceChildren();
  const visible = Object.values(items).filter((i) => !i.deleted && (i.type || 'shop') === 'shop').sort((a, b) => a.updatedAt - b.updatedAt);
  for (const it of visible) {
    const box = el('input', { type: 'checkbox' });
    box.checked = !!it.done;
    box.addEventListener('change', () => { const all = store.load(SHARED_KEY, {}); all[it.id] = { ...all[it.id], done: box.checked, updatedAt: now() }; store.save(SHARED_KEY, all); renderShared(); scheduleSync(); });
    const label = el('span', { class: 'name', text: it.text });
    if (it.done) label.style.textDecoration = 'line-through';
    const del = el('button', { class: 'del', text: '✕', 'aria-label': 'Remove ' + it.text });
    // Deleting drops the photo too, so removed items don't keep using shared space.
    del.addEventListener('click', () => { const all = store.load(SHARED_KEY, {}); const { photo, ...rest } = all[it.id]; all[it.id] = { ...rest, deleted: true, updatedAt: now() }; store.save(SHARED_KEY, all); renderShared(); scheduleSync(); });
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
const SHARED_PHOTO_BUDGET = 1_300_000; // characters of local JSON (~1.3 MB)
function setShopPhoto(id, dataUrl) {
  const all = store.load(SHARED_KEY, {});
  if (!all[id]) return;
  const { photo, ...rest } = all[id];
  all[id] = dataUrl ? { ...rest, photo: dataUrl, updatedAt: now() } : { ...rest, updatedAt: now() };
  store.save(SHARED_KEY, all);
  renderShared();
  scheduleSync();
}
function pickShopPhoto(id) {
  const input = el('input', { type: 'file', accept: 'image/*' });
  input.addEventListener('change', async () => {
    const file = input.files[0];
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
  for (const it of Object.values(all)) if (it.done && !it.deleted) { const { photo, ...rest } = it; all[it.id] = { ...rest, deleted: true, updatedAt: now() }; }
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
  const label = (arr, name) => arr.length && bits.push(`${arr.length} ${name}`);
  label(c.subscriptions, 'subscription(s)'); label(c.utilities, 'utility plan(s)'); label(c.documents, 'document(s)');
  label(c.deliveries, 'delivery/deliveries'); label(c.loyalty, 'loyalty card(s)'); label(c.checkups, 'check-up(s)');
  label(c.maintenance, 'maintenance item(s)'); label(c.shopping, 'shopping item(s)');
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
  add(UTIL_KEY, r.utilities, (u) => ({ id: uid(), ...u }));
  add(DOCS_KEY, r.documents, (d) => ({ id: uid(), ...d }));
  add(DELIVERIES_KEY, r.deliveries, (d) => ({ id: uid(), done: false, ...d }));
  // Calendar events: dedupe against what's already stored (same date + title),
  // so repeated morning imports never pile up duplicates.
  if (r.events.length) {
    snap(EVENTS_KEY, []);
    const existing = store.load(EVENTS_KEY, []);
    const seen = new Set(existing.map((e) => (e.date || '') + '|' + (e.title || '').trim().toLowerCase()));
    const fresh = r.events.filter((e) => { const k = (e.date || '') + '|' + (e.title || '').trim().toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    if (fresh.length) store.save(EVENTS_KEY, [...fresh.map((e) => ({ id: uid(), ...e })), ...existing]);
  }
  add(LOYAL_KEY, r.loyalty, (c) => ({ id: uid(), ...c }));
  add(CHECK_KEY, r.checkups, (c) => ({ id: uid(), ...c }));
  add(MAINT_KEY, r.maintenance, (m) => ({ id: uid(), ...m }));
  let shoppingAdded = false;
  if (r.shopping.length) {
    snap(SHARED_KEY, {});
    const all = store.load(SHARED_KEY, {});
    for (const text of r.shopping) { const id = 's' + uid(); all[id] = { id, text, done: false, updatedAt: now(), deleted: false }; }
    store.save(SHARED_KEY, all);
    shoppingAdded = true;
    scheduleSync();
  }
  let vehicleSnap = null;
  if (Object.keys(r.vehicle).length) {
    vehicleSnap = JSON.parse(JSON.stringify(loadVehicle()));
    const v = loadVehicle();
    for (const [k, val] of Object.entries(r.vehicle)) if (val) v[k] = k === 'reg' ? cleanReg(val) : val;
    saveVehicle(v);
  }
  const rerender = () => { renderSubs(); renderUtilities(); renderDocs(); renderDeliveries(); renderLoyalty(); renderCheckups(); renderMaint(); renderShared(); initCarTab(); renderHome(); };
  rerender();
  const undo = () => {
    for (const [key, val] of Object.entries(snapshot)) store.save(key, val);
    if (vehicleSnap) saveVehicle(vehicleSnap);
    if (shoppingAdded) scheduleSync();
    rerender();
  };
  return { count: importCount(r), undo };
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
  $('lock-intro').textContent = setupMode
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
    initAll();
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
    if (pass.length < 6) return (err.textContent = 'Use at least 6 characters.');
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
      return;
    }
    $('lock-submit').disabled = false;
  }
  $('lock-screen').hidden = true;
  initAll();
}

function lockApp() {
  vault.lock();
  mediaKey = null;
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
$('btn-lock').addEventListener('click', lockApp);
$('lock-reset').addEventListener('click', () => {
  if (!confirm('Forgotten your passphrase?\n\nThere is no way to recover the data without it. You can wipe everything and start fresh. This cannot be undone.')) return;
  if (!confirm('Really erase all stored data on this phone?')) return;
  vault.destroy();
  disableBiometric();
  showLockScreen();
});

// Security card actions
$('btn-lock2').addEventListener('click', lockApp);
$('btn-backup').addEventListener('click', async () => {
  const vaultBlob = vault.backupBlob();
  if (!vaultBlob) return;
  setStatus('security-status', 'Preparing backup…');
  const bundle = { app: 'evergreen-backup', v: 1, vault: vaultBlob, photos: await exportAllPhotos().catch(() => ({})) };
  const url = URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `evergreen-backup-${new Date().toISOString().slice(0, 10)}.json`;
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
    initAll();
    setStatus('security-status', 'Backup restored.');
  } catch {
    setStatus('security-status', 'Could not restore — wrong passphrase or not a valid backup file.', true);
  } finally {
    e.target.value = '';
  }
});
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
  const pass = prompt('New passphrase (at least 6 characters):');
  if (pass == null) return;
  if (pass.length < 6) return setStatus('security-status', 'Passphrase too short.', true);
  if (prompt('Confirm the new passphrase:') !== pass) return setStatus('security-status', 'Passphrases did not match.', true);
  // Re-key by setting up a fresh vault with the current data.
  await vault.setup(pass, vault.data);
  disableBiometric(); // the stored wrapped passphrase is now stale
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
function handleLaunchParams() {
  const q = new URLSearchParams(location.search);
  if (![...q.keys()].length) return;
  const action = q.get('action');
  const importPayload = q.get('import');
  const hasShared = q.has('title') || q.has('text') || q.has('url');
  history.replaceState(null, '', location.pathname); // don't repeat on refresh
  if (importPayload) {
    try {
      const r = parseImport(decodeImportPayload(importPayload));
      if (importCount(r)) {
        const { count, undo } = applyParsedImport(r);
        if (r.deliveries.length) goLife('deliveries');
        toast(`Added ${count} item${count === 1 ? '' : 's'} from your link ✓`, { actionLabel: 'Undo', onAction: undo, ms: 8000 });
      } else {
        toast('That link had nothing new to add.');
      }
    } catch {
      toast('Sorry — that import link could not be read.');
    }
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
    await migratePhotos();
  } catch (e) {
    log('info', 'Media key/migrate: ' + e.message);
  }
  setConnected(false);
  renderHistory();
  renderTrips();
  initCarTab();
  renderDocs();
  renderDeliveries();
  initLifeSections();
  renderHome();
  $('conn').style.display = 'none'; // Home is the default screen
  refreshBiometricButtons();
  if (!bluetoothSupported()) {
    $('unsupported').hidden = false;
    $('btn-connect').disabled = true;
  } else {
    refreshReconnect();
  }
  handleLaunchParams();
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
showLockScreen();
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
