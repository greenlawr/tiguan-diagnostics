// Rich, app-style icons: each one is a coloured gradient tile with a soft gloss
// and a bold white symbol, so every area of the app has its own recognisable
// colour. Pure inline SVG (no image files), so they stay crisp and work offline.

// Per-icon colour: [top-left, bottom-right]. The darker stop also colours the
// small cut-out details inside each symbol.
const COLOURS = {
  gauge: ['#ff8a6b', '#e2382c'],
  car: ['#5ab8ff', '#1f5fd6'],
  cart: ['#4fdc95', '#109158'],
  doc: ['#8c9cff', '#4a4fd1'],
  bolt: ['#ffd25e', '#f08a06'],
  money: ['#3ee0a5', '#048a64'],
  house: ['#ffb05e', '#ea6512'],
  heart: ['#ff86aa', '#e0305f'],
  box: ['#e0ae74', '#a5612a'],
  card: ['#cf95ff', '#8434dc'],
  fuel: ['#3fe0c8', '#0b8b80'],
  gear: ['#a7b4c6', '#4f5c70'],
  refresh: ['#52c8ff', '#0679c2'],
  calendar: ['#ff8a96', '#dd2a4a'],
  share: ['#7fb2ff', '#3a4fd8'],
  split: ['#9aa2ff', '#5b3fe0'],
  tasks: ['#b9ec4d', '#4f9a0f'],
  flame: ['#ffa45c', '#e5481f'],
  drop: ['#5fd0ff', '#1677d6'],
  family: ['#f39bd8', '#a743cf'],
};

// Symbols drawn on a 48×48 grid. `D` is replaced with the tile's dark colour.
const GLYPHS = {
  gauge: `<path d="M12.5 31a11.5 11.5 0 0 1 23 0z" fill="#fff" opacity=".28"/>
    <path d="M12.5 31a11.5 11.5 0 0 1 23 0" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/>
    <path d="M24 31l7-8.5" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/>
    <circle cx="24" cy="31" r="3.4" fill="#fff"/>`,
  car: `<path d="M11.5 27.5l2.7-6.6a3 3 0 0 1 2.8-1.9h14a3 3 0 0 1 2.8 1.9l2.7 6.6v5a1.5 1.5 0 0 1-1.5 1.5h-22A1.5 1.5 0 0 1 11.5 32.5z" fill="#fff"/>
    <path d="M16.6 26.5l1.7-4.3h11.4l1.7 4.3z" fill="D" opacity=".55"/>
    <circle cx="17" cy="34" r="3.4" fill="D"/><circle cx="17" cy="34" r="1.6" fill="#fff"/>
    <circle cx="31" cy="34" r="3.4" fill="D"/><circle cx="31" cy="34" r="1.6" fill="#fff"/>`,
  cart: `<path d="M9.5 13h3.6l3.6 16.5h16" fill="none" stroke="#fff" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M14.6 16.5h22.4l-2.7 10.2a2 2 0 0 1-1.9 1.5H17.2z" fill="#fff"/>
    <path d="M21 20v5M26 20v5M31 20v5" stroke="D" stroke-width="1.6" stroke-linecap="round" opacity=".45"/>
    <circle cx="19" cy="34.5" r="2.6" fill="#fff"/><circle cx="31" cy="34.5" r="2.6" fill="#fff"/>`,
  doc: `<path d="M16 10.5h11l7.5 7.5v17.5a2.5 2.5 0 0 1-2.5 2.5H16a2.5 2.5 0 0 1-2.5-2.5V13a2.5 2.5 0 0 1 2.5-2.5z" fill="#fff"/>
    <path d="M27 10.5V16a2 2 0 0 0 2 2h5.5z" fill="D" opacity=".35"/>
    <rect x="18" y="22" width="12" height="2.4" rx="1.2" fill="D" opacity=".55"/>
    <rect x="18" y="26.8" width="12" height="2.4" rx="1.2" fill="D" opacity=".55"/>
    <rect x="18" y="31.6" width="7.5" height="2.4" rx="1.2" fill="D" opacity=".55"/>`,
  bolt: `<path d="M27.5 8.5L14.5 27h9l-2.5 12.5L34 20.5h-9z" fill="#fff" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/>`,
  money: `<rect x="9.5" y="15" width="29" height="18" rx="3.5" fill="#fff"/>
    <circle cx="24" cy="24" r="5" fill="D"/>
    <text x="24" y="27.4" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="9" fill="#fff">£</text>
    <circle cx="14.5" cy="24" r="1.6" fill="D" opacity=".45"/><circle cx="33.5" cy="24" r="1.6" fill="D" opacity=".45"/>`,
  house: `<path d="M24 10.5l13.4 11.6a1.3 1.3 0 0 1-.85 2.3H34.5V35a2.5 2.5 0 0 1-2.5 2.5H16a2.5 2.5 0 0 1-2.5-2.5V24.4h-2.05a1.3 1.3 0 0 1-.85-2.3z" fill="#fff"/>
    <rect x="21" y="27.5" width="6" height="10" rx="1.6" fill="D" opacity=".7"/>`,
  heart: `<path d="M24 37C14.5 30.6 10.5 26 10.5 20.6a6.6 6.6 0 0 1 13.5-2.9 6.6 6.6 0 0 1 13.5 2.9C37.5 26 33.5 30.6 24 37z" fill="#fff"/>
    <path d="M15.5 24.5h4.3l2.2-3.6 3.4 6.6 2.1-3h5" fill="none" stroke="D" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" opacity=".7"/>`,
  box: `<path d="M24 10.5l12.5 6.3L24 23.1l-12.5-6.3z" fill="#fff" opacity=".75"/>
    <path d="M11.5 16.8L24 23.1v14.4l-12.5-6.3z" fill="#fff"/>
    <path d="M36.5 16.8L24 23.1v14.4l12.5-6.3z" fill="#fff" opacity=".88"/>
    <path d="M17.8 13.6l12.5 6.3v4.6" fill="none" stroke="D" stroke-width="2" stroke-linejoin="round" opacity=".45"/>`,
  card: `<rect x="9.5" y="13.5" width="29" height="21" rx="3.5" fill="#fff"/>
    <rect x="9.5" y="18" width="29" height="4" fill="D" opacity=".75"/>
    <rect x="13.5" y="26" width="7" height="4.6" rx="1.2" fill="D" opacity=".4"/>
    <rect x="24" y="27.4" width="10.5" height="2" rx="1" fill="D" opacity=".3"/>`,
  fuel: `<rect x="12.5" y="11" width="15" height="25" rx="2.8" fill="#fff"/>
    <rect x="15.5" y="14.5" width="9" height="6.5" rx="1.3" fill="D" opacity=".55"/>
    <path d="M27.5 19h2.8a2.6 2.6 0 0 1 2.6 2.6V31a2 2 0 0 0 4 0V19.5l-3-3.2" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="10.5" y="35" width="19" height="3" rx="1.5" fill="#fff"/>`,
  gear: `<path d="M33.8 21.8 L36.9 22.3 L36.9 25.7 L33.8 26.2 L32.4 29.4 L34.3 31.9 L31.9 34.3 L29.4 32.4 L26.2 33.8 L25.7 36.9 L22.3 36.9 L21.8 33.8 L18.6 32.4 L16.1 34.3 L13.7 31.9 L15.6 29.4 L14.2 26.2 L11.1 25.7 L11.1 22.3 L14.2 21.8 L15.6 18.6 L13.7 16.1 L16.1 13.7 L18.6 15.6 L21.8 14.2 L22.3 11.1 L25.7 11.1 L26.2 14.2 L29.4 15.6 L31.9 13.7 L34.3 16.1 L32.4 18.6Z" fill="#fff" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/>
    <circle cx="24" cy="24" r="4.6" fill="D"/>`,
  refresh: `<path d="M15 22a9.5 9.5 0 0 1 16.6-5.4" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/>
    <path d="M33.5 11.5v6.8h-6.8" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M33 26a9.5 9.5 0 0 1-16.6 5.4" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/>
    <path d="M14.5 36.5v-6.8h6.8" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>`,
  calendar: `<rect x="11" y="13" width="26" height="24" rx="3.5" fill="#fff"/>
    <path d="M11 16.5a3.5 3.5 0 0 1 3.5-3.5h19a3.5 3.5 0 0 1 3.5 3.5V20H11z" fill="D" opacity=".75"/>
    <rect x="16.5" y="9.5" width="3" height="7" rx="1.5" fill="#fff"/><rect x="28.5" y="9.5" width="3" height="7" rx="1.5" fill="#fff"/>
    <g fill="D" opacity=".5"><rect x="15" y="23.5" width="4" height="3.2" rx=".8"/><rect x="22" y="23.5" width="4" height="3.2" rx=".8"/><rect x="29" y="23.5" width="4" height="3.2" rx=".8"/><rect x="15" y="29.5" width="4" height="3.2" rx=".8"/><rect x="22" y="29.5" width="4" height="3.2" rx=".8"/></g>`,
  share: `<circle cx="30.5" cy="19" r="4.4" fill="#fff" opacity=".7"/>
    <path d="M23.5 34a7.5 7.5 0 0 1 15 0z" fill="#fff" opacity=".7"/>
    <circle cx="19" cy="18.5" r="5" fill="#fff"/>
    <path d="M10 35a9 9 0 0 1 18 0z" fill="#fff"/>`,
  split: `<path d="M15 9.5h18v28.5l-3-2.2-3 2.2-3-2.2-3 2.2-3-2.2-3 2.2z" fill="#fff"/>
    <rect x="18.5" y="15" width="11" height="2.4" rx="1.2" fill="D" opacity=".5"/>
    <rect x="18.5" y="20" width="11" height="2.4" rx="1.2" fill="D" opacity=".5"/>
    <rect x="18.5" y="25" width="6.5" height="2.4" rx="1.2" fill="D" opacity=".5"/>
    <text x="28.5" y="31.6" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="8.5" fill="D">£</text>`,
  tasks: `<rect x="12.5" y="12" width="23" height="26" rx="3" fill="#fff"/>
    <rect x="18.5" y="9" width="11" height="5.6" rx="2" fill="D" opacity=".6"/>
    <path d="M16.5 21.5l2.1 2.1 3.6-3.8M16.5 29.5l2.1 2.1 3.6-3.8" fill="none" stroke="D" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="24.5" y="21" width="7.5" height="2.2" rx="1.1" fill="D" opacity=".45"/>
    <rect x="24.5" y="29" width="7.5" height="2.2" rx="1.1" fill="D" opacity=".45"/>`,
  flame: `<path d="M24 8.5c1.6 5.2 8 8.6 8 16a8 8 0 0 1-16 0c0-3.8 1.9-6.1 3.8-8 .4 2.5 1.7 4.1 3.3 4.8C22.3 16.6 22.2 12.3 24 8.5z" fill="#fff"/>
    <path d="M24 37.5a4 4 0 0 1-4-4c0-2.5 2.3-4 4-6.6 1.7 2.6 4 4.1 4 6.6a4 4 0 0 1-4 4z" fill="D" opacity=".55"/>`,
  family: `<circle cx="16" cy="15.5" r="4.2" fill="#fff" opacity=".85"/><circle cx="32" cy="15.5" r="4.2" fill="#fff" opacity=".85"/>
    <path d="M8 34a8 8 0 0 1 16 0z" fill="#fff" opacity=".85"/><path d="M24 34a8 8 0 0 1 16 0z" fill="#fff" opacity=".85"/>
    <circle cx="24" cy="24" r="3.6" fill="#fff"/><path d="M17.5 38.5a6.5 6.5 0 0 1 13 0z" fill="#fff"/>`,
  drop: `<path d="M24 9c5 6.6 10.5 12 10.5 18.2a10.5 10.5 0 0 1-21 0C13.5 21 19 15.6 24 9z" fill="#fff"/>
    <path d="M18.6 28a5.8 5.8 0 0 0 4.4 5.5" fill="none" stroke="D" stroke-width="2.3" stroke-linecap="round" opacity=".5"/>`,
};

let seq = 0;
export function icon(name) {
  const key = GLYPHS[name] ? name : 'doc';
  const [light, dark] = COLOURS[key];
  const id = 'ic' + seq++;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 48 48');
  svg.setAttribute('class', 'ic rich');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `<defs>
      <linearGradient id="${id}g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${light}"/><stop offset="1" stop-color="${dark}"/></linearGradient>
      <linearGradient id="${id}s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".32"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
    </defs>
    <rect width="48" height="48" rx="12.5" fill="url(#${id}g)"/>
    <path d="M0 12.5A12.5 12.5 0 0 1 12.5 0h23A12.5 12.5 0 0 1 48 12.5V20C34 26 14 26 0 20z" fill="url(#${id}s)"/>
    ${GLYPHS[key].replace(/"D"/g, `"${dark}"`)}`;
  return svg;
}

export const TILE_ICON = {
  'Car check': 'gauge', 'My car': 'car', 'Shopping list': 'cart', 'Documents': 'doc',
  'Utilities': 'bolt', 'Money & tax': 'money', 'Home': 'house', 'Health': 'heart',
  'Deliveries': 'box', 'Loyalty': 'card', 'Trips': 'fuel', 'Settings': 'gear',
  'Calendar': 'calendar', 'Sharing': 'share', 'To-do list': 'tasks', 'Family': 'family',
};
export const SEC_ICON_NAME = {
  deliveries: 'box', documents: 'doc', utilities: 'bolt', subscriptions: 'refresh',
  tax: 'money', home: 'house', health: 'heart', loyalty: 'card', sharing: 'share', shopping: 'cart',
  bills: 'split', tasks: 'tasks', calendar: 'calendar', family: 'family',
};
