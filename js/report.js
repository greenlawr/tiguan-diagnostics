// The one-tap health check: gathers everything and turns it into a plain-English report.

import * as obd from './obd.js';
import { VW_MODULES, scanModule } from './vw.js';
import { explainFault, explainBattery, LEVEL_ORDER, LEVEL_LABEL } from './explain.js';

const worst = (levels) => levels.reduce((a, b) => (LEVEL_ORDER[b] > LEVEL_ORDER[a] ? b : a), 'ok');

/**
 * @param elm connected Elm
 * @param onProgress fn(fraction 0..1, message)
 */
export async function runHealthCheck(elm, onProgress = () => {}) {
  const total = 4 + VW_MODULES.length;
  let step = 0;
  const progress = (message) => onProgress(step++ / total, message);

  progress('Checking the engine warning light…');
  const status = await obd.readStatus(elm);

  progress('Looking for engine faults…');
  const stored = await obd.readDtcs(elm, 0x03);
  const pending = await obd.readDtcs(elm, 0x07);
  const permanent = await obd.readDtcs(elm, 0x0a);

  progress('Reading your car\'s details…');
  const vin = await obd.readVin(elm);

  progress('Checking the battery…');
  const volts = await elm.batteryVoltage();
  const rpmData = await obd.readPid(elm, 0x0c);
  const engineRunning = rpmData ? (rpmData[0] * 256 + rpmData[1]) / 4 > 300 : false;

  // Engine and gearbox faults from the standard (legally required) fault list.
  const issues = [];
  const seen = new Set();
  const addObd = (codes, state) => {
    for (const code of codes) {
      if (seen.has(code)) continue;
      seen.add(code);
      issues.push({ code, state, system: 'Engine', moduleCode: '01', ...explainFault({ code, moduleCode: '01', state }) });
    }
  };
  addObd(stored, 'current');
  addObd(pending, 'pending');
  addObd(permanent, 'permanent');

  // Every other computer in the car.
  const systems = [];
  for (const module of VW_MODULES) {
    progress(`Checking ${module.name.toLowerCase()}…`);
    let result = null;
    try {
      result = await scanModule(elm, module);
    } catch {
      result = null;
    }
    if (!result) continue;
    const faults = result.faults || [];
    for (const f of faults) {
      const powertrain = module.code === '01' || module.code === '02';
      if (powertrain && seen.has(f.code)) continue; // already listed above
      const state = f.active ? 'current' : f.pending && !f.confirmed ? 'pending' : 'historic';
      issues.push({
        code: f.code,
        vwCode: f.raw,
        state,
        system: module.name,
        moduleCode: module.code,
        ...explainFault({ code: f.code, moduleCode: module.code, state }),
      });
    }
    systems.push({
      code: module.code,
      name: module.name,
      plain: module.plain,
      status: result.faults === null ? 'unknown' : faults.length ? 'fault' : 'ok',
      faultCount: faults.length,
      systemName: result.systemName,
      partNumber: result.partNumber,
      softwareVersion: result.softwareVersion,
      hardwareNumber: result.hardwareNumber,
    });
  }
  onProgress(1, 'Done');

  issues.sort((a, b) => LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level]);
  const battery = volts == null ? null : { volts, engineRunning, ...explainBattery(volts, engineRunning) };
  const mil = status ? status.mil : null;

  const levels = issues.map((i) => i.level);
  if (battery) levels.push(battery.level);
  if (mil && !issues.some((i) => i.state === 'current')) levels.push('soon');
  const level = worst(levels);

  const monitors = status ? status.monitors : [];
  return {
    date: new Date().toISOString(),
    vin,
    adapter: elm.info.adapter,
    mil,
    battery,
    issues,
    systems,
    monitors,
    level,
    ...headline(level, issues, mil),
  };
}

function headline(level, issues, mil) {
  const n = issues.length;
  const things = n === 1 ? '1 thing' : `${n} things`;
  if (level === 'ok') {
    return { headline: 'No problems found', summary: 'Every system that answered reported no faults.' };
  }
  if (level === 'minor') {
    return {
      headline: 'Nothing urgent',
      summary: n ? `We found ${things} worth knowing about, but nothing that needs action right now.` : 'Just one small note below.',
    };
  }
  if (level === 'soon') {
    return {
      headline: 'Something needs attention',
      summary: n
        ? `We found ${things}. The car is generally OK to drive, but book a garage visit soon.`
        : mil
          ? 'The engine warning light is on but no fault code could be read. Have a garage take a look.'
          : 'See the note below.',
    };
  }
  return {
    headline: 'Get this looked at now',
    summary: `We found ${things}, including at least one that could cause damage or leave you stranded if ignored.`,
  };
}

const STATE_TEXT = { current: 'Happening now', pending: 'Seen once, not confirmed', permanent: 'Awaiting self-check', historic: 'Happened in the past' };
export const stateText = (state) => STATE_TEXT[state];

/**
 * Compare a fresh report with the previous one.
 * @returns null if there is nothing to compare against, else what changed.
 */
export function diffReports(current, previous) {
  if (!previous) return null;
  const key = (i) => `${i.code}@${i.moduleCode || ''}`;
  const now = new Map(current.issues.map((i) => [key(i), i]));
  const then = new Map(previous.issues.map((i) => [key(i), i]));
  const added = current.issues.filter((i) => !then.has(key(i)));
  const cleared = previous.issues.filter((i) => !now.has(key(i)));
  const batteryDelta =
    current.battery && previous.battery ? current.battery.volts - previous.battery.volts : null;
  const milChanged = current.mil != null && previous.mil != null && current.mil !== previous.mil;
  const changed = added.length || cleared.length || milChanged || (batteryDelta != null && Math.abs(batteryDelta) >= 0.3);
  return { prevDate: previous.date, added, cleared, batteryDelta, milChanged, milNow: current.mil, changed };
}

/** Plain-text version for sharing with a garage. */
export function reportText(r) {
  const when = new Date(r.date).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const lines = [
    'VW TIGUAN HEALTH CHECK',
    when,
    r.vin ? `VIN: ${r.vin}` : null,
    '',
    `RESULT: ${r.headline}`,
    r.summary,
    r.mil == null ? null : `Engine warning light: ${r.mil ? 'ON' : 'off'}`,
    r.battery ? `Battery: ${r.battery.volts.toFixed(1)} V (engine ${r.battery.engineRunning ? 'running' : 'off'}) - ${r.battery.text}` : null,
  ];
  if (r.issues.length) {
    lines.push('', 'FAULTS FOUND');
    for (const i of r.issues) {
      lines.push(
        `- [${LEVEL_LABEL[i.level]}] ${i.title}`,
        `  Where: ${i.system} | Code: ${i.code}${i.vwCode ? ` (VW ${i.vwCode})` : ''} | ${STATE_TEXT[i.state]}`
      );
    }
  }
  if (r.systems.length) {
    lines.push('', 'SYSTEMS CHECKED');
    for (const s of r.systems) {
      const state = s.status === 'ok' ? 'OK' : s.status === 'fault' ? `${s.faultCount} fault(s)` : 'could not read faults';
      const ids = [s.partNumber && `part ${s.partNumber}`, s.softwareVersion && `software ${s.softwareVersion}`].filter(Boolean).join(', ');
      lines.push(`- ${s.name}: ${state}${ids ? ` (${ids})` : ''}`);
    }
  }
  if (r.monitors.length) {
    const ready = r.monitors.filter((m) => m.ready).length;
    lines.push('', `Emissions self-tests complete: ${ready} of ${r.monitors.length}`);
  }
  return lines.filter((l) => l !== null).join('\n');
}
