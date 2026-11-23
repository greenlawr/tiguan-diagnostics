// Read-only "why isn't Android Auto working?" check.
//
// Enabling App-Connect is NOT something this app can do: it needs a signed
// activation code (FEC/SWaP) for your specific unit plus security access, which
// a web page cannot legitimately perform. What this CAN do is read the
// infotainment module and work out which situation you are in, so you know
// whether it is fixable at home, needs a specialist, or needs different hardware.

import { VW_MODULES, scanModule } from './vw.js';
import { readVin } from './obd.js';

const INFOTAINMENT = VW_MODULES.find((m) => m.code === '5F');

// Loose, hedged hints from the part number. VW part numbers are not a reliable
// feature list, so these are presented as "likely", never as fact.
function variantHint(partNumber) {
  if (!partNumber) return null;
  const p = partNumber.toUpperCase().replace(/\s/g, '');
  // The middle group tells you the family on MQB cars (035xxx = radio/nav head unit).
  if (/035020|035021|035022/.test(p)) return { likely: 'Composition Colour or a basic radio', appConnect: 'no', note: 'This type usually does not have App-Connect hardware at all, so Android Auto cannot be enabled on it.' };
  if (/035867|035820|035866/.test(p)) return { likely: 'Composition Media', appConnect: 'maybe', note: 'Some Composition Media units support App-Connect and some do not, depending on the exact build.' };
  if (/035874|035875|035020G|035021G|035043|035044|035045|035046/.test(p)) return { likely: 'Discover Media or Discover Pro (navigation)', appConnect: 'likely', note: 'This family normally has the App-Connect hardware, so it is usually an activation or coding issue rather than missing hardware.' };
  return null;
}

/**
 * @returns {Promise<object>} what we could read plus a plain-English interpretation
 */
export async function diagnoseAppConnect(elm) {
  const vin = await readVin(elm).catch(() => null);
  const info = await scanModule(elm, INFOTAINMENT);
  if (!info) {
    return {
      reachable: false,
      vin,
      summary: 'Your adapter could not reach the infotainment unit, so this check could not run. A better adapter (see the start of the Help tab) usually fixes that. Everything below is a general guide instead.',
    };
  }

  const part = info.partNumber || null;
  const software = info.softwareVersion || null;
  // The last letter of the software/part number (the "D vs T" suffix) decides
  // which activation code a coder needs. We surface it but do not act on it.
  const suffix = (part || '').slice(-1).toUpperCase();
  const hint = variantHint(part);
  const faults = info.faults || [];

  return {
    reachable: true,
    vin,
    systemName: info.systemName || null,
    partNumber: part,
    softwareVersion: software,
    hardwareNumber: info.hardwareNumber || null,
    suffix: /[A-Z]/.test(suffix) ? suffix : null,
    hint,
    faults,
    faultsUnreadable: info.faults === null,
  };
}

/** A tidy note the owner can hand or email to a dealer / specialist. */
export function dealerSummary(d) {
  const lines = [
    'VW TIGUAN — INFOTAINMENT UNIT DETAILS',
    'For an App-Connect (Android Auto / CarPlay) activation enquiry.',
    '',
    d.vin ? `VIN: ${d.vin}` : 'VIN: (not read)',
  ];
  if (d.reachable) {
    lines.push(
      d.systemName ? `Unit name: ${d.systemName}` : null,
      d.partNumber ? `Part number: ${d.partNumber}` : null,
      d.softwareVersion ? `Software version: ${d.softwareVersion}` : null,
      d.suffix ? `Software suffix: ${d.suffix}` : null,
      '',
      'Question: does this unit have App-Connect hardware, and if so can it be',
      'activated? If an activation code (FEC/SWaP) is required, please quote for it.'
    );
  } else {
    lines.push('', 'The infotainment unit could not be read by the owner\'s adapter.');
  }
  return lines.filter((l) => l !== null).join('\n');
}

// The decision tree, as plain questions. Answers are things only the owner can
// see on the car's screen; we combine them with what we read.
export const CHECKLIST = [
  {
    id: 'tile',
    question: 'On the car\'s screen, is there an "App-Connect" button or tile at all?',
    answers: {
      no: {
        verdict: 'The feature is not switched on in your unit.',
        detail: 'If the hardware supports it (see the unit details above), this is the case a VW specialist or a coder with the right activation code can fix. It cannot be done from this app or with a basic coding tool, because it needs a signed activation code for your exact unit.',
        level: 'soon',
      },
      yes: { next: 'opens' },
    },
  },
  {
    id: 'opens',
    question: 'When you tap App-Connect with your phone plugged in, what happens?',
    answers: {
      'dealer': {
        verdict: 'The hardware is there but the feature is locked.',
        detail: 'A "please contact your dealer" or activation message means the unit has App-Connect built in but it has never been activated. A coder with the correct activation code, or a VW dealer, can switch it on. Still usually cheaper than paying for map updates, and you only pay once.',
        level: 'soon',
      },
      'nothing': { next: 'cable' },
      'works-sometimes': { next: 'cable' },
    },
  },
  {
    id: 'cable',
    question: 'Have you tried a different, good-quality USB cable in the main USB socket (the one in the tray in front of the gear lever, not a charging-only port)?',
    answers: {
      no: {
        verdict: 'Try the cable first — it is the most common cause.',
        detail: 'Use the cable that came with your phone, or a known data cable (charge-only cables will not work), in the main USB socket. Many "it should work but doesn\'t" cases are just the cable or socket. If that fixes it, you are done.',
        level: 'minor',
      },
      yes: {
        verdict: 'Likely a coding or software issue on the unit.',
        detail: 'The hardware and cable are fine but it still will not connect. This is the case where a coder can sometimes correct the smartphone-integration setting, or where the unit\'s software needs updating by a dealer. Share the unit details above with them.',
        level: 'soon',
      },
    },
  },
];
