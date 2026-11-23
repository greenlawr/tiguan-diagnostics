// A small, cohesive line-icon set (stroke-based, inherits currentColor so it
// themes automatically). Replaces the emoji for a more designed, premium feel.

const PATHS = {
  gauge: '<path d="M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/><path d="M12 12l4-3"/><path d="M4 18a9 9 0 1 1 16 0"/>',
  car: '<path d="M5 12l1.5-4A2 2 0 0 1 8.4 7h7.2a2 2 0 0 1 1.9 1.4L19 12"/><path d="M4 12h16v5h-2.5"/><path d="M6.5 17H4v-5"/><path d="M8.5 17h7"/><circle cx="7" cy="17" r="1.4"/><circle cx="17" cy="17" r="1.4"/>',
  cart: '<circle cx="9" cy="20" r="1.3"/><circle cx="18" cy="20" r="1.3"/><path d="M3 4h2l2.2 11h10.3l1.8-7H6.5"/>',
  doc: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><path d="M10 13h5M10 16.5h5"/>',
  bolt: '<path d="M13 2 5 13h5l-1 9 9-12h-5z"/>',
  money: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v5M18 9.5v5"/>',
  house: '<path d="M4 11l8-6 8 6"/><path d="M6 10v9h12v-9"/><path d="M10 19v-5h4v5"/>',
  heart: '<path d="M12 20s-6.5-4.2-9-8.3A4.6 4.6 0 0 1 12 6.5a4.6 4.6 0 0 1 9 5.2C18.5 15.8 12 20 12 20z"/>',
  box: '<path d="M4 7.5 12 4l8 3.5v9L12 20l-8-3.5z"/><path d="M4 7.5 12 11l8-3.5M12 11v9"/>',
  card: '<rect x="2.5" y="5.5" width="19" height="13" rx="2.5"/><path d="M2.5 10h19"/><path d="M6 15h4"/>',
  fuel: '<path d="M5 20V6a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v14"/><path d="M4 20h11"/><path d="M8 9h3"/><path d="M14 10h2.5a1.5 1.5 0 0 1 1.5 1.5V16a1.5 1.5 0 0 0 3 0v-7l-2.5-2.5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M4.5 7.5l2 1.2M17.5 14.3l2 1.2M4.5 16.5l2-1.2M17.5 9.7l2-1.2"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-1 5"/><path d="M20 5v5h-5"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>',
  split: '<circle cx="7" cy="7" r="3"/><circle cx="17" cy="17" r="3"/><path d="M10 7h7v7"/>',
  tasks: '<path d="M4 6l2 2 3-3"/><path d="M4 13l2 2 3-3"/><path d="M12 7h8M12 14h8M4 20h16"/>',
};

export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', 'ic');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = PATHS[name] || PATHS.doc;
  return svg;
}

export const TILE_ICON = {
  'Car check': 'gauge', 'My car': 'car', 'Shopping list': 'cart', 'Documents': 'doc',
  'Utilities': 'bolt', 'Money & tax': 'money', 'Home': 'house', 'Health': 'heart',
  'Deliveries': 'box', 'Loyalty': 'card', 'Trips': 'fuel', 'Settings': 'gear',
};
export const SEC_ICON_NAME = {
  deliveries: 'box', documents: 'doc', utilities: 'bolt', subscriptions: 'refresh',
  tax: 'money', home: 'house', health: 'heart', loyalty: 'card', sharing: 'calendar', shopping: 'cart',
  bills: 'split', tasks: 'tasks',
};
