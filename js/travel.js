// Travel: trips, bookings and the checks that stop a holiday going wrong at the
// airport (passport validity, travel authorisations, GHIC, insurance).
// Pure functions, no DOM, so they can be tested.
//
// Passport rules are GUIDANCE ONLY, simplified from GOV.UK foreign travel advice
// (UK passports). They err on the cautious side; always check GOV.UK before booking.

const SCHENGEN = new Set(['AT', 'BE', 'BG', 'CH', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK']);
const EU = new Set(['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK']);

// Country names (as people type them) → ISO code + GOV.UK travel-advice slug.
export const COUNTRIES = {
  austria: 'AT', belgium: 'BE', bulgaria: 'BG', switzerland: 'CH', 'czech republic': 'CZ', czechia: 'CZ', germany: 'DE', denmark: 'DK',
  estonia: 'EE', spain: 'ES', finland: 'FI', france: 'FR', greece: 'GR', croatia: 'HR', hungary: 'HU', iceland: 'IS', italy: 'IT',
  liechtenstein: 'LI', lithuania: 'LT', luxembourg: 'LU', latvia: 'LV', malta: 'MT', netherlands: 'NL', holland: 'NL', norway: 'NO',
  poland: 'PL', portugal: 'PT', romania: 'RO', sweden: 'SE', slovenia: 'SI', slovakia: 'SK', cyprus: 'CY', ireland: 'IE',
  'republic of ireland': 'IE', turkey: 'TR', 'türkiye': 'TR', turkiye: 'TR', usa: 'US', 'united states': 'US', america: 'US',
  canada: 'CA', 'united arab emirates': 'AE', uae: 'AE', dubai: 'AE', 'abu dhabi': 'AE', thailand: 'TH', egypt: 'EG', morocco: 'MA',
  tunisia: 'TN', mexico: 'MX', australia: 'AU', 'new zealand': 'NZ', japan: 'JP', 'south africa': 'ZA', 'sri lanka': 'LK',
  maldives: 'MV', india: 'IN', jamaica: 'JM', barbados: 'BB', 'dominican republic': 'DO', cuba: 'CU', mauritius: 'MU',
  // popular islands / places → their country
  mallorca: 'ES', majorca: 'ES', menorca: 'ES', ibiza: 'ES', tenerife: 'ES', lanzarote: 'ES', 'gran canaria': 'ES', fuerteventura: 'ES',
  madeira: 'PT', algarve: 'PT', crete: 'GR', corfu: 'GR', rhodes: 'GR', kos: 'GR', zante: 'GR', santorini: 'GR', sardinia: 'IT', sicily: 'IT',
  florida: 'US', orlando: 'US', 'new york': 'US', paris: 'FR', disneyland: 'FR', rome: 'IT', barcelona: 'ES', amsterdam: 'NL', lapland: 'FI',
};
const SLUG = {
  AT: 'austria', BE: 'belgium', BG: 'bulgaria', CH: 'switzerland', CZ: 'czech-republic', DE: 'germany', DK: 'denmark', EE: 'estonia',
  ES: 'spain', FI: 'finland', FR: 'france', GR: 'greece', HR: 'croatia', HU: 'hungary', IS: 'iceland', IT: 'italy', LI: 'liechtenstein',
  LT: 'lithuania', LU: 'luxembourg', LV: 'latvia', MT: 'malta', NL: 'netherlands', NO: 'norway', PL: 'poland', PT: 'portugal',
  RO: 'romania', SE: 'sweden', SI: 'slovenia', SK: 'slovakia', CY: 'cyprus', IE: 'ireland', TR: 'turkey', US: 'usa', CA: 'canada',
  AE: 'united-arab-emirates', TH: 'thailand', EG: 'egypt', MA: 'morocco', TN: 'tunisia', MX: 'mexico', AU: 'australia',
  NZ: 'new-zealand', JP: 'japan', ZA: 'south-africa', LK: 'sri-lanka', MV: 'maldives', IN: 'india', JM: 'jamaica', BB: 'barbados',
  DO: 'dominican-republic', CU: 'cuba', MU: 'mauritius',
};
const NAMES = { ES: 'Spain', FR: 'France', IT: 'Italy', PT: 'Portugal', GR: 'Greece', US: 'the USA', NL: 'the Netherlands', IE: 'Ireland', AE: 'the UAE', CZ: 'Czechia' };
const FLAGS_OFF = 0x1f1e6 - 65;
export const flag = (iso) => (iso && /^[A-Z]{2}$/.test(iso) ? String.fromCodePoint(...[...iso].map((c) => c.charCodeAt(0) + FLAGS_OFF)) : '✈️');

// Popular airports from the UK (IATA code → country), so a flight's "to" finds the country.
const AIRPORTS = {
  ES: 'PMI ALC AGP BCN MAD IBZ TFS TFN ACE LPA FUE MAH VLC SVQ GRO REU BIO',
  PT: 'FAO LIS OPO FNC PDL', FR: 'CDG ORY NCE LYS MRS BOD TLS GNB BVA CMF BIQ', NL: 'AMS EIN RTM', BE: 'BRU CRL',
  GR: 'ATH HER CHQ CFU RHO KGS ZTH JMK JTR SKG EFL PVK KLX', IT: 'FCO CIA MXP LIN BGY VCE NAP CTA PMO OLB CAG PSA BLQ BRI TRN VRN',
  TR: 'DLM AYT BJV IST SAW ADB', HR: 'DBV SPU ZAG PUY ZAD', CY: 'PFO LCA', MT: 'MLA', DE: 'BER MUC FRA DUS HAM CGN STR',
  CH: 'GVA ZRH BSL', AT: 'VIE SZG INN', CZ: 'PRG', HU: 'BUD', PL: 'KRK WAW GDN', DK: 'CPH', IS: 'KEF', NO: 'OSL BGO TOS',
  SE: 'ARN GOT', FI: 'HEL RVN KTT', IE: 'DUB ORK SNN KIR NOC', BG: 'BOJ VAR SOF', SI: 'LJU', EE: 'TLL', LV: 'RIX', LT: 'VNO',
  US: 'JFK EWR LGA MCO MIA LAX LAS SFO BOS ORD IAD SEA TPA FLL', CA: 'YYZ YVR YUL YYC', AE: 'DXB AUH DWC', EG: 'SSH HRG RMF CAI',
  MA: 'RAK AGA FEZ TNG', TN: 'NBE DJE TUN', TH: 'BKK HKT DMK USM', MX: 'CUN MEX', JM: 'MBJ KIN', BB: 'BGI', DO: 'PUJ',
  MV: 'MLE', LK: 'CMB', MU: 'MRU', AU: 'SYD MEL', NZ: 'AKL', JP: 'HND NRT KIX', ZA: 'CPT JNB', IN: 'DEL BOM GOI',
};
const AIRPORT = {};
for (const [c, list] of Object.entries(AIRPORTS)) for (const a of list.split(' ')) AIRPORT[a] = c;

/** Work out the country code for something typed like "Mallorca", "Spain", "PMI" or "ES". */
export function countryCode(text) {
  const raw = String(text || '').trim();
  if (/^[A-Z]{3}$/.test(raw) && AIRPORT[raw]) return AIRPORT[raw];
  const t = raw.toLowerCase();
  if (!t) return '';
  if (/^[a-z]{3}$/.test(t) && AIRPORT[t.toUpperCase()]) return AIRPORT[t.toUpperCase()];
  if (/^[a-z]{2}$/.test(t) && SLUG[t.toUpperCase()]) return t.toUpperCase();
  if (COUNTRIES[t]) return COUNTRIES[t];
  for (const [name, code] of Object.entries(COUNTRIES)) if (t.includes(name)) return code;
  return '';
}
export const countryName = (iso, fallback = '') => NAMES[iso] || (SLUG[iso] ? SLUG[iso].replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : fallback);
export const adviceSlug = (iso) => SLUG[iso] || '';
export const adviceUrl = (iso) => 'https://www.gov.uk/foreign-travel-advice/' + (SLUG[iso] || '');

/**
 * Passport rule for a destination.
 *  kind 'schengen': issued < 10 years before you arrive AND valid 3 months after you leave
 *  kind 'arrive':   valid N months from the day you arrive
 *  kind 'after':    valid N months after you leave
 *  kind 'stay':     valid for the whole stay
 *  auth: travel authorisation to apply for in advance
 */
export function passportRule(iso) {
  if (SCHENGEN.has(iso)) return { kind: 'schengen', months: 3, auth: 'etias' };
  if (iso === 'CY') return { kind: 'after', months: 3 }; // EU, not Schengen — cautious
  if (iso === 'IE') return { kind: 'stay', note: 'Common Travel Area — airlines still ask for photo ID; a passport is simplest.' };
  if (iso === 'TR') return { kind: 'arrive', days: 150 };
  if (iso === 'US') return { kind: 'stay', auth: 'esta' };
  if (iso === 'CA') return { kind: 'stay', auth: 'eta-ca' };
  if (iso === 'AU') return { kind: 'stay', auth: 'eta-au' };
  if (iso === 'JP' || iso === 'NZ' || iso === 'MX' || iso === 'MA') return { kind: 'stay', auth: iso === 'NZ' ? 'nzeta' : undefined };
  if (['AE', 'TH', 'EG', 'LK', 'MV', 'IN', 'TN', 'ZA', 'JM', 'BB', 'DO', 'CU', 'MU'].includes(iso)) return { kind: 'arrive', months: 6 };
  return { kind: 'after', months: 6, unknown: true }; // cautious default
}
const AUTH = {
  etias: { name: 'ETIAS', text: 'Check whether you need an ETIAS travel authorisation for Europe (official site only: travel-europe.europa.eu)', days: 30 },
  esta: { name: 'ESTA', text: 'Apply for an ESTA for the USA — official site esta.cbp.dhs.gov (avoid look-alike sites that charge extra)', days: 30 },
  'eta-ca': { name: 'eTA', text: 'Apply for a Canadian eTA — official site canada.ca', days: 30 },
  'eta-au': { name: 'ETA', text: 'Apply for an Australian ETA through the official AustralianETA app', days: 30 },
  nzeta: { name: 'NZeTA', text: 'Apply for a New Zealand NZeTA through the official app or immigration.govt.nz', days: 30 },
};

const addMonths = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
};
const addDays = (iso, n) => { const t = new Date(iso + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const ukDate = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
export const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
const isoOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/** The date a passport must still be valid on, for this rule and trip. */
export function validUntilNeeded(rule, start, end) {
  if (rule.kind === 'schengen' || rule.kind === 'after') return addMonths(end, rule.months);
  if (rule.kind === 'arrive') return rule.days ? addDays(start, rule.days) : addMonths(start, rule.months);
  return end; // 'stay'
}

/**
 * Check one person's passport for one trip.
 * person: { name, passportExpiry, passportIssued?, dob? }
 * Returns null if fine, otherwise { level: 'urgent'|'soon'|'info', text }.
 */
export function checkPassport(person, trip, iso) {
  const who = person.name || 'Someone';
  if (!isoOk(trip.start) || !isoOk(trip.end)) return null;
  if (!isoOk(person.passportExpiry)) return { level: 'info', text: `Add ${who}'s passport expiry date in Family so Evergreen can check it.` };
  const rule = passportRule(iso);
  const place = countryName(iso, 'this destination');
  if (person.passportExpiry < trip.end) return { level: 'urgent', text: `${who}'s passport runs out before you get home from ${place}.` };
  const need = validUntilNeeded(rule, trip.start, trip.end);
  if (person.passportExpiry < need) {
    const why = rule.kind === 'schengen' || rule.kind === 'after' ? `${rule.months} months after you leave` : rule.kind === 'arrive' ? (rule.days ? `${rule.days} days from arrival` : `${rule.months} months from arrival`) : 'for the whole stay';
    return { level: 'urgent', text: `${who}'s passport may not be accepted for ${place} — it needs to be valid ${why} (until ${ukDate(need)}).` };
  }
  if (rule.kind === 'schengen') {
    // Issued in the last 10 years on the day you arrive. If the issue date isn't stored,
    // assume a full-length passport: 10 years (adult) or 5 years (child under 16 when issued).
    let issued = person.passportIssued;
    if (!isoOk(issued)) {
      const childAtExpiry = person.dob && isoOk(person.dob) && daysBetween(person.dob, person.passportExpiry) < 21 * 365.25;
      issued = addMonths(person.passportExpiry, childAtExpiry ? -60 : -120);
    }
    if (addMonths(issued, 120) <= trip.start) return { level: 'urgent', text: `${who}'s passport was issued more than 10 years before you arrive in ${place} — the EU won't accept it.` };
  }
  return null;
}

/** Everything that needs doing for a trip, most urgent first. */
export function tripChecks(trip, people, today, { hasInsurance = false } = {}) {
  const out = [];
  if (!isoOk(trip.start) || !isoOk(trip.end) || trip.end < today) return out;
  const until = daysBetween(today, trip.start);
  const isos = [...new Set((trip.destinations || []).map((d) => d.iso || countryCode(d.country || d)).filter(Boolean))];
  if (!isos.length && trip.country) isos.push(countryCode(trip.country));
  const travellers = people.filter((p) => !trip.travellers || !trip.travellers.length || trip.travellers.includes(p.id));
  for (const iso of isos.filter(Boolean)) {
    for (const p of travellers) {
      const c = checkPassport(p, trip, iso);
      if (c) out.push({ ...c, kind: 'passport', url: adviceUrl(iso) });
    }
    const rule = passportRule(iso);
    if (rule.auth && until <= AUTH[rule.auth].days && until >= 0) out.push({ level: 'soon', kind: 'auth', text: AUTH[rule.auth].text });
    if (EU.has(iso) && until <= 28 && until >= 0) {
      const missing = travellers.filter((p) => !isoOk(p.ghicExpiry) || p.ghicExpiry < trip.end).map((p) => p.name).filter(Boolean);
      if (missing.length) out.push({ level: 'soon', kind: 'ghic', text: `Check ${missing.join(', ')} ${missing.length > 1 ? 'have' : 'has'} an in-date GHIC — it's free from the NHS (avoid paid sites).`, url: 'https://www.nhs.uk/using-the-nhs/healthcare-abroad/apply-for-a-free-uk-global-health-insurance-card-ghic/' });
    }
    if (rule.unknown && until <= 60) out.push({ level: 'info', kind: 'advice', text: `Check GOV.UK entry requirements for ${countryName(iso, 'your destination')}.`, url: adviceUrl(iso) });
  }
  const bookings = trip.bookings || [];
  if (!hasInsurance && !bookings.some((b) => b.kind === 'insurance') && until <= 42 && until >= 0) out.push({ level: 'soon', kind: 'insurance', text: 'No travel insurance saved for this trip — buy it soon after booking so cancellation is covered.' });
  for (const b of bookings) {
    if (b.kind !== 'flight' || !b.depart) continue;
    const d = daysBetween(today, b.depart.slice(0, 10));
    if (d >= 0 && d <= 2) out.push({ level: 'soon', kind: 'checkin', text: `Online check-in is probably open for ${b.flightNo || 'your flight'}${b.airline ? ' (' + b.airline + ')' : ''} — airlines open it 24–48 hours before.` });
  }
  const rank = { urgent: 0, soon: 1, info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

/** Bookings in the order they happen (each gets a `when` for sorting/showing). */
export function timeline(trip) {
  const when = (b) => b.depart || b.checkIn || b.pickUp || b.coverFrom || '';
  return (trip.bookings || []).map((b) => ({ ...b, when: when(b) })).sort((a, b) => (a.when || '9') < (b.when || '9') ? -1 : 1);
}

/** Short status line: "in 12 days", "Day 3 of 7", "Home today". */
export function tripStatus(trip, today) {
  if (!isoOk(trip.start) || !isoOk(trip.end)) return '';
  const until = daysBetween(today, trip.start);
  const length = daysBetween(trip.start, trip.end) + 1;
  if (until > 1) return `in ${until} days`;
  if (until === 1) return 'tomorrow';
  if (until === 0) return 'today!';
  if (today > trip.end) return 'finished';
  if (today === trip.end) return 'home today';
  return `day ${daysBetween(trip.start, today) + 1} of ${length}`;
}

/** Calendar rows for a trip (virtual, like birthdays): an all-day row per day, plus timed bookings. */
export function tripCalendarRows(trip, from, to) {
  const rows = [];
  if (!isoOk(trip.start) || !isoOk(trip.end)) return rows;
  const label = `${flag((trip.destinations || [])[0]?.iso)} ${trip.title || 'Trip'}`;
  for (let d = trip.start > from ? trip.start : from; d <= trip.end && d <= to; d = addDays(d, 1)) {
    rows.push({ id: `trip-${trip.id}-${d}`, tripId: trip.id, title: label, date: d, time: '', who: 'Trips', virtual: true });
  }
  for (const b of trip.bookings || []) {
    const at = b.depart || b.checkIn || b.pickUp;
    if (!at) continue;
    const date = at.slice(0, 10), time = at.length > 10 ? at.slice(11, 16) : '';
    if (date < from || date > to) continue;
    const title = b.kind === 'flight' ? `✈️ ${b.flightNo || 'Flight'} ${b.from || ''}${b.to ? '→' + b.to : ''}`.trim()
      : b.kind === 'stay' ? `🏨 Check in: ${b.name || 'hotel'}`
      : b.kind === 'car' ? `🚗 Car hire: ${b.company || ''}`.trim()
      : b.kind === 'transport' ? `${b.mode === 'ferry' ? '⛴️' : b.mode === 'train' ? '🚆' : '🚌'} ${b.operator || b.mode || 'Transport'}${b.to ? ' → ' + b.to : ''}`
      : '';
    if (title) rows.push({ id: `trip-${trip.id}-${b.id}`, tripId: trip.id, title, date, time, who: 'Trips', virtual: true });
  }
  return rows;
}

/** Find the trip a booking belongs to (dates overlapping, within a day either side). */
export function matchTrip(trips, date) {
  if (!isoOk(date)) return null;
  return trips.find((t) => isoOk(t.start) && isoOk(t.end) && addDays(t.start, -1) <= date && date <= addDays(t.end, 1)) || null;
}

export const BOOKING_KINDS = {
  flight: { icon: '✈️', label: 'Flight' },
  stay: { icon: '🏨', label: 'Hotel / stay' },
  car: { icon: '🚗', label: 'Car hire' },
  transport: { icon: '🚆', label: 'Train / ferry / transfer' },
  insurance: { icon: '🛡️', label: 'Travel insurance' },
  other: { icon: '📌', label: 'Other booking' },
};
