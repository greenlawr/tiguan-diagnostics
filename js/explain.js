// Turns fault codes into advice a non-mechanic can act on.
// Levels: 'urgent' (act now), 'soon' (get it checked), 'minor' (keep an eye on it).

import { describeDtc, hasDescription } from './dtc.js';

export const LEVEL_ORDER = { ok: 0, minor: 1, soon: 2, urgent: 3 };
export const LEVEL_LABEL = { ok: 'All good', minor: 'Keep an eye on it', soon: 'Get it checked', urgent: 'Act now' };

// Rough UK part-price guidance, keyed by the fault family's title. These are
// ballparks to give a sense of scale only: real prices vary by supplier, brand
// (genuine VW vs aftermarket) and whether labour is included. The "check current
// prices" link in the app shows live listings for the actual number.
const COSTS = {
  'Engine misfire': 'Ignition coil or spark plug, roughly £10–£40 each (parts)',
  'Engine timing problem': 'Timing chain repair is a big job, often £400–£1,000+ at a specialist',
  'Turbo boost problem': 'A split hose is £10–£40; a replacement turbo is £350+',
  'Fuel and air mixture is off': 'Usually a sensor or hose, roughly £20–£120 (parts)',
  'Fuel pressure problem': 'Fuel pressure sensor £20–£80; high-pressure pump £150–£400',
  'Fuel injector problem': 'Roughly £60–£200 per injector (parts)',
  'Engine is slow to warm up': 'Thermostat, roughly £15–£60 (part)',
  'Engine temperature sensor fault': 'Coolant temperature sensor, roughly £10–£30 (part)',
  'Engine air sensor fault': 'Air-flow sensor, roughly £30–£120 (part)',
  'Exhaust oxygen sensor fault': 'Oxygen (lambda) sensor, roughly £30–£120 (part)',
  'Catalytic converter not cleaning the exhaust well': 'Aftermarket cat £150–£600; often just a £30–£120 sensor',
  'Fuel vapour leak': 'Often £0 (the filler cap); vapour hoses/valve £20–£80',
  'Exhaust recirculation (EGR) problem': 'EGR valve, roughly £100–£350 (part)',
  'Diesel particulate filter is clogging up': 'Often £0 (a longer drive clears it); replacement £500–£1,200',
  'AdBlue / exhaust treatment problem': 'AdBlue top-up £15–£30; sensor/pump faults more',
  'Battery / charging voltage problem': 'Battery £90–£180; alternator £150–£400 (parts)',
  'Gearbox problem': 'Varies widely — fluid service £150–£300, bigger repairs much more',
  'Car computers lost contact with each other': 'Often just the battery, £90–£180',
  'Brake / stability system fault': 'Wheel speed sensor, roughly £20–£60 (part)',
  'Airbag system fault': 'Diagnosis first; a clock spring is roughly £30–£90 (part)',
  'Power steering fault': 'Varies — have it diagnosed before buying parts',
};

const GENTLE = 'Yes, but drive gently and avoid hard acceleration until it is fixed.';
const NORMAL = 'Yes. This will not leave you stranded.';

// First matching rule wins.
const RULES = [
  {
    match: /^P030\d|^P035\d/,
    title: 'Engine misfire',
    level: 'urgent',
    meaning: 'One or more of the engine\'s cylinders is not firing properly. The engine may shake, feel weak or sound rough, and unburnt fuel can damage the expensive catalytic converter.',
    drive: 'Only as far as you need to, and gently. If the engine warning light is flashing, stop when it is safe and do not carry on.',
    action: 'Book a garage visit now. It is most often a worn spark plug or a failed ignition coil, which is a quick and fairly cheap repair.',
  },
  {
    match: /^P0016|^P0011|^P0010|^P034\d/,
    title: 'Engine timing problem',
    level: 'urgent',
    meaning: 'The engine\'s moving parts are not staying in step with each other the way they should. On VW petrol engines this can be an early sign of a stretched timing chain.',
    drive: 'Avoid driving if you can. If the timing chain fails the engine can be badly damaged.',
    action: 'Have a garage or VW specialist look at this before using the car much more.',
  },
  {
    match: /^P0299|^P0234|^P023\d|^P0243|^P2261/,
    title: 'Turbo boost problem',
    level: 'soon',
    meaning: 'The turbocharger gives the engine extra power. It is not delivering the pressure the engine expects, so the car may feel sluggish or go into a reduced-power "limp" mode.',
    drive: GENTLE,
    action: 'Ask a garage to check for a split or loose air hose first (cheap) before anyone suggests replacing the turbo (expensive).',
  },
  {
    match: /^P017[12]|^P21[78]\d|^P2279/,
    title: 'Fuel and air mixture is off',
    level: 'soon',
    meaning: 'The engine is getting too much or too little fuel for the amount of air coming in. You might notice rough idling, hesitation or worse fuel economy.',
    drive: GENTLE,
    action: 'Common causes are an air leak in a hose, a dirty air-flow sensor or a tired fuel pump. A garage can find which quite quickly.',
  },
  {
    match: /^P0087|^P0088|^P019\d|^P2293/,
    title: 'Fuel pressure problem',
    level: 'soon',
    meaning: 'Fuel is not reaching the engine at the right pressure. The engine may hesitate, lose power or, in bad cases, cut out.',
    drive: 'Short, gentle trips only. Avoid motorways until it is checked in case the engine loses power.',
    action: 'Book it in with a garage. Mention this exact code so they check the fuel pump and pressure sensor.',
  },
  {
    match: /^P020\d/,
    title: 'Fuel injector problem',
    level: 'soon',
    meaning: 'An injector sprays fuel into one cylinder. One of them has an electrical or performance problem, which can cause rough running.',
    drive: GENTLE,
    action: 'Have a garage test the injector and its wiring.',
  },
  {
    match: /^P0128|^P0597/,
    title: 'Engine is slow to warm up',
    level: 'minor',
    meaning: 'The engine is not reaching its normal temperature as quickly as it should, usually because the thermostat is stuck open. The heater may be slow and fuel economy a little worse.',
    drive: NORMAL,
    action: 'Not urgent. Have the thermostat replaced at your next service or before winter.',
  },
  {
    match: /^P011[5-9]/,
    title: 'Engine temperature sensor fault',
    level: 'soon',
    meaning: 'The car cannot reliably tell how hot the engine is. That can affect starting and fuel use, and means an overheating warning might not be accurate.',
    drive: 'Yes, but keep an eye on the temperature gauge and stop if it climbs into the red.',
    action: 'The sensor is a cheap part. Ask a garage to replace or test it.',
  },
  {
    match: /^P01[0-2]\d/,
    title: 'Engine air sensor fault',
    level: 'soon',
    meaning: 'A sensor that measures the air going into the engine is giving readings that do not make sense. The engine may hesitate or use more fuel.',
    drive: GENTLE,
    action: 'Often fixed by cleaning or replacing the sensor, or fixing a loose connector.',
  },
  {
    match: /^P013\d|^P014\d|^P003\d|^P209\d|^P2196/,
    title: 'Exhaust oxygen sensor fault',
    level: 'minor',
    meaning: 'A sensor in the exhaust that helps the engine burn fuel cleanly is not working properly. Fuel economy and emissions may be slightly worse.',
    drive: NORMAL,
    action: 'Get it replaced when convenient. It may cause an MOT emissions failure if left.',
  },
  {
    match: /^P042\d/,
    title: 'Catalytic converter not cleaning the exhaust well',
    level: 'soon',
    meaning: 'The catalytic converter cleans the exhaust gases. It is working below the standard the car expects.',
    drive: NORMAL,
    action: 'It will likely fail an MOT emissions test. Ask a garage to check the sensors first, because a faulty sensor can trigger this without the converter itself being worn out.',
  },
  {
    match: /^P04[45]\d/,
    title: 'Fuel vapour leak',
    level: 'minor',
    meaning: 'The system that stops petrol fumes escaping from the fuel tank has a small leak.',
    drive: NORMAL,
    action: 'First check the fuel filler cap is done up until it clicks. If the code returns, have a garage check the vapour hoses.',
  },
  {
    match: /^P040\d|^P2BAC/,
    title: 'Exhaust recirculation (EGR) problem',
    level: 'soon',
    meaning: 'The EGR system feeds a little exhaust back into the engine to cut pollution. It is blocked or not moving properly.',
    drive: GENTLE,
    action: 'Usually a cleaning or replacement job for the EGR valve.',
  },
  {
    match: /^P2002|^P2463|^P0471/,
    title: 'Diesel particulate filter is clogging up',
    level: 'soon',
    meaning: 'The filter that traps soot from the diesel exhaust is getting full. This is common with lots of short journeys.',
    drive: 'Yes. In fact a 20 to 30 minute drive at a steady motorway speed often lets the filter clean itself.',
    action: 'Try the longer drive first. If the warning stays, a garage can run a forced clean.',
  },
  {
    match: /^P20EE|^P203F/,
    title: 'AdBlue / exhaust treatment problem',
    level: 'soon',
    meaning: 'Diesel cars use AdBlue fluid to clean the exhaust. The level is low or the system is not working well.',
    drive: 'Yes for now, but if AdBlue runs out the car will eventually refuse to restart.',
    action: 'Top up the AdBlue (blue cap next to the fuel filler). If it is already full, have a garage check the system.',
  },
  {
    match: /^P056[23]/,
    title: 'Battery / charging voltage problem',
    level: 'soon',
    meaning: 'The car\'s electrical voltage has been too low or too high. A weak battery or a charging fault can cause all sorts of odd warnings.',
    drive: 'Yes, but there is a risk the car will not start next time.',
    action: 'Have the battery and alternator tested. Many garages and parts shops do this free.',
  },
  {
    match: /^P06\d\d/,
    title: 'Engine computer fault',
    level: 'soon',
    meaning: 'The engine\'s control computer has logged an internal problem.',
    drive: GENTLE,
    action: 'Have a VW specialist check it. Sometimes a software update at the dealer fixes this.',
  },
  {
    match: /^P07\d\d|^P17\d\d|^P18\d\d/,
    title: 'Gearbox problem',
    level: 'soon',
    meaning: 'The automatic gearbox has logged a fault. You may notice jerky or delayed gear changes.',
    drive: 'Gently, and avoid towing or heavy loads until it is checked.',
    action: 'Have a VW gearbox specialist read the full details. A fluid service or software update sometimes resolves it.',
  },
  {
    match: /^U/,
    title: 'Car computers lost contact with each other',
    level: 'minor',
    meaning: 'The car\'s computers talk to each other constantly. One of them missed messages from another at some point.',
    drive: NORMAL,
    action: 'Very often caused by a weak battery or a jump-start. If it is not marked as happening now, it can usually be ignored. If it keeps returning, have the battery tested.',
  },
];

// Fallback advice by which part of the car reported the fault.
const BY_MODULE = {
  '03': {
    title: 'Brake / stability system fault',
    level: 'soon',
    meaning: 'The system that controls anti-lock brakes (ABS) and stability control has logged a fault. Your normal brakes still work, but these safety aids may be switched off.',
    drive: 'Yes, carefully. Leave extra space, especially in the wet.',
    action: 'Book it in soon. It is often a wheel speed sensor, which is not an expensive fix.',
  },
  '15': {
    title: 'Airbag system fault',
    level: 'soon',
    meaning: 'The airbag system has logged a fault. Airbags or seatbelt tensioners might not work properly in a crash.',
    drive: 'The car drives normally, but you have less protection in an accident.',
    action: 'Get this checked soon. Airbag faults should only be repaired by a garage.',
  },
  '44': {
    title: 'Power steering fault',
    level: 'soon',
    meaning: 'The power steering system has logged a fault. The steering could become heavy.',
    drive: 'Carefully. If the steering feels heavy or odd, stop and get help.',
    action: 'Have a garage check it soon.',
  },
  '02': RULES.find((r) => r.title === 'Gearbox problem'),
};

const GENERIC = {
  P: {
    title: 'Engine or gearbox fault',
    level: 'soon',
    meaning: 'The engine or gearbox computer has logged a fault that this app does not have a plain-English description for.',
    drive: GENTLE,
    action: 'Use "Look up this code" below, or show this report to a garage.',
  },
  other: {
    title: 'Fault recorded',
    level: 'minor',
    meaning: 'This part of the car has logged a fault that this app does not have a plain-English description for.',
    drive: 'Usually yes, unless something obviously is not working.',
    action: 'Use "Look up this code" below, or show this report to a garage.',
  },
};

/**
 * @param fault {code, moduleCode?, state: 'current'|'pending'|'permanent'|'historic'}
 */
export function explainFault({ code, moduleCode, state }) {
  const rule =
    RULES.find((r) => r.match.test(code)) || BY_MODULE[moduleCode] || (code[0] === 'P' ? GENERIC.P : GENERIC.other);
  const result = {
    title: hasDescription(code) ? describeDtc(code) : rule.title,
    level: rule.level,
    meaning: rule.meaning,
    drive: rule.drive,
    action: rule.action,
    cost: COSTS[rule.title] || null,
  };

  if (state === 'historic') {
    result.level = 'minor';
    result.stateNote = 'This was recorded in the past and is not happening right now. It may have been a one-off.';
  } else if (state === 'pending') {
    if (result.level === 'soon') result.level = 'minor';
    result.stateNote = 'The car has noticed this once but has not confirmed it yet. It may clear itself; if it turns into a confirmed fault, act on it.';
  } else if (state === 'permanent') {
    result.level = 'minor';
    result.stateNote = 'This is a record the car keeps after a fault until it has proved to itself the repair worked. It clears on its own with normal driving.';
  }
  return result;
}

/** Plain-English verdict on battery voltage. */
export function explainBattery(volts, engineRunning) {
  if (volts == null) return null;
  if (engineRunning) {
    if (volts > 15.1) return { level: 'soon', text: 'Higher than it should be. Have the charging system checked.' };
    if (volts >= 13.2) return { level: 'ok', text: 'Charging normally.' };
    if (volts >= 12.2) return { level: 'ok', text: 'A little low for a running engine, but modern VWs deliberately vary this to save fuel.' };
    return { level: 'soon', text: 'The battery does not seem to be charging. Have the battery and alternator tested.' };
  }
  if (volts >= 12.4) return { level: 'ok', text: 'Healthy.' };
  if (volts >= 12.0) return { level: 'minor', text: 'A little low. Normal if the ignition has been on for a while with the engine off.' };
  return { level: 'soon', text: 'Low. The car may struggle to start. Take a longer drive or have the battery tested.' };
}

/** A web search for live prices of a part on this car. */
export function priceSearchUrl(term) {
  return 'https://www.google.com/search?tbm=shop&q=' + encodeURIComponent(`${term} VW Tiguan 2017`);
}
