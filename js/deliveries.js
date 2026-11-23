// Deliveries / parcel tracker.
//
// The app can't read your Amazon/courier accounts (that needs logins + a server,
// which would break the on-device privacy model). Instead you add a parcel —
// by sharing a confirmation into the app or pasting a tracking number — and it
// keeps the expected date on your dashboard with a one-tap link to the carrier's
// own live tracking page.

const enc = encodeURIComponent;

export const CARRIERS = {
  'Royal Mail': (t) => `https://www.royalmail.com/track-your-item#/tracking-results/${enc(t)}`,
  'DPD': (t) => `https://www.dpd.co.uk/apps/tracking/?reference=${enc(t)}`,
  'Evri': (t) => `https://www.evri.com/track/parcel/${enc(t)}`,
  'Parcelforce': (t) => `https://www.parcelforce.com/track-trace?trackNumber=${enc(t)}`,
  'Yodel': (t) => `https://www.yodel.co.uk/tracking/${enc(t)}`,
  'UPS': (t) => `https://www.ups.com/track?tracknum=${enc(t)}`,
  'DHL': (t) => `https://www.dhl.com/gb-en/home/tracking.html?tracking-id=${enc(t)}`,
  'Amazon': () => 'https://www.amazon.co.uk/gp/css/order-history',
  'Other': (t) => `https://www.google.com/search?q=${enc('track parcel ' + t)}`,
};

export const CARRIER_NAMES = Object.keys(CARRIERS);

/** Link to the carrier's own live tracking for this parcel. */
export function trackingUrl(carrier, tracking) {
  const make = CARRIERS[carrier] || CARRIERS.Other;
  return make(tracking || '');
}

/** Friendly "arriving…" status with a severity band. Null if no expected date. */
export function parcelStatus(expectedISO, now = new Date()) {
  if (!expectedISO) return { text: 'No date set', level: 'dim', days: null };
  const due = new Date(expectedISO + 'T00:00:00');
  if (isNaN(due)) return { text: 'No date set', level: 'dim', days: null };
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((due - today) / 86400000);
  if (days < 0) return { text: `Was due ${-days} day${days === -1 ? '' : 's'} ago`, level: 'soon', days };
  if (days === 0) return { text: 'Arriving today', level: 'soon', days };
  if (days === 1) return { text: 'Arriving tomorrow', level: 'minor', days };
  if (days <= 7) return { text: `Arriving in ${days} days`, level: 'minor', days };
  return { text: `Arriving in ${days} days`, level: 'ok', days };
}

// Best-effort pull of a tracking link / number out of shared text (from the
// Android share sheet). Never throws; returns what it can.
export function parseShared({ title = '', text = '', url = '' } = {}) {
  const blob = [url, text, title].filter(Boolean).join(' ');
  const link = (blob.match(/https?:\/\/\S+/) || [])[0] || '';
  let carrier = 'Other';
  for (const name of CARRIER_NAMES) {
    if (new RegExp(name.replace(/\s/g, '\\s*'), 'i').test(blob)) {
      carrier = name;
      break;
    }
  }
  // A plausible tracking number: a longish alphanumeric run.
  const tracking = (blob.match(/\b[A-Z0-9]{8,}\b/i) || [])[0] || '';
  return { item: (title || text || '').slice(0, 80), carrier, tracking, link };
}
