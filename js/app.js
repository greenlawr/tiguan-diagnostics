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
import { motCountdown, calendarUrl, cleanReg, GOV_MOT_HISTORY, GOV_TAX_CHECK } from './vehicle.js';

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

// ---------- tabs ----------
document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + btn.dataset.tab));
    if (btn.dataset.tab !== 'live') stopLive();
    if (btn.dataset.tab === 'help') renderLog();
    window.scrollTo(0, 0);
  });
});

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
function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch {
    return [];
  }
}
function saveReport(report) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify([report, ...loadHistory()].slice(0, 12)));
  } catch {
    /* storage unavailable; the report is still shown */
  }
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
const loadTrips = () => {
  try {
    return JSON.parse(localStorage.getItem(TRIPS_KEY)) || [];
  } catch {
    return [];
  }
};
function saveTrip(summary) {
  try {
    localStorage.setItem(TRIPS_KEY, JSON.stringify([summary, ...loadTrips()].slice(0, 30)));
  } catch {
    /* storage unavailable */
  }
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

// ---------- my car & MOT ----------
const VEHICLE_KEY = 'tiguan-vehicle';
function loadVehicle() {
  try {
    return JSON.parse(localStorage.getItem(VEHICLE_KEY)) || {};
  } catch {
    return {};
  }
}
function saveVehicle(v) {
  try {
    localStorage.setItem(VEHICLE_KEY, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}
function refreshVehicle() {
  const v = loadVehicle();
  const reg = v.reg || '';
  const mot = v.mot || '';
  const cd = motCountdown(mot);
  const box = $('mot-countdown');
  if (cd) {
    box.textContent = cd.text;
    box.className = 'status tag ' + cd.level;
  } else {
    box.textContent = '';
    box.className = 'status';
  }
  $('lnk-mot').href = GOV_MOT_HISTORY;
  $('lnk-tax').href = GOV_TAX_CHECK;
  const cal = mot ? calendarUrl(reg, mot) : null;
  $('lnk-cal').hidden = !cal;
  if (cal) $('lnk-cal').href = cal;
}
$('reg-input').addEventListener('input', (e) => {
  const v = loadVehicle();
  v.reg = cleanReg(e.target.value);
  saveVehicle(v);
  refreshVehicle();
});
$('mot-input').addEventListener('change', (e) => {
  const v = loadVehicle();
  v.mot = e.target.value;
  saveVehicle(v);
  refreshVehicle();
});

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

// ---------- startup ----------
setConnected(false);
renderHistory();
renderTrips();
(() => {
  const v = loadVehicle();
  if (v.reg) $('reg-input').value = v.reg;
  if (v.mot) $('mot-input').value = v.mot;
  refreshVehicle();
})();
try {
  applyTextSize(localStorage.getItem(TEXT_KEY) || 'normal');
} catch {
  applyTextSize('normal');
}
if (!bluetoothSupported()) {
  $('unsupported').hidden = false;
  $('btn-connect').disabled = true;
} else {
  refreshReconnect();
}
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
