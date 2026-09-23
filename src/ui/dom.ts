// Tiny DOM helpers for the game UI.

type Child = Node | string | number | null | undefined | false;
type Props = Record<string, any>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function svg(markup: string): HTMLElement {
  const span = document.createElement('span');
  span.style.display = 'contents';
  span.innerHTML = markup;
  return span;
}

const S = (inner: string, vb = '0 0 24 24') => `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

export const ICONS = {
  bulb: S('<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.5 1.1 1.3 1.1 2.2h5c0-.9.4-1.7 1.1-2.2A6 6 0 0 0 12 3z" fill="currentColor" fill-opacity=".25"/>'),
  bag: S('<path d="M5 8h14l-1.2 11.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8z" fill="currentColor" fill-opacity=".25"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>'),
  door: S('<path d="M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17" fill="currentColor" fill-opacity=".25"/><path d="M3 21h18"/><circle cx="14.5" cy="12.5" r="1" fill="currentColor"/>'),
  camera: S('<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" fill="currentColor" fill-opacity=".25"/><circle cx="12" cy="13" r="3.5"/>'),
  paw: S('<ellipse cx="12" cy="16" rx="4.5" ry="3.8" fill="currentColor" fill-opacity=".35"/><circle cx="6.5" cy="10.5" r="1.8"/><circle cx="10" cy="6.8" r="1.8"/><circle cx="14" cy="6.8" r="1.8"/><circle cx="17.5" cy="10.5" r="1.8"/>'),
  gear: S('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  mic: S('<rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" fill-opacity=".3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
  keyboard: S('<rect x="2.5" y="6" width="19" height="12" rx="2.5" fill="currentColor" fill-opacity=".2"/><path d="M6.5 10h.01M10.5 10h.01M14.5 10h.01M18 10h.01M6.5 13.5h.01M18 13.5h.01M9.5 14h5"/>'),
  send: S('<path d="M4 12l16-8-6 16-2.5-6.5z" fill="currentColor" fill-opacity=".3"/><path d="M11.5 13.5L20 4"/>'),
  whistle: S('<circle cx="9" cy="14" r="5" fill="currentColor" fill-opacity=".25"/><path d="M13 11l8-4v4l-6 2"/><circle cx="9" cy="14" r="1.2" fill="currentColor"/>'),
  back: S('<path d="M15 18l-6-6 6-6"/>'),
  close: S('<path d="M6 6l12 12M18 6L6 18"/>'),
  heart: S('<path d="M12 21s-7-4.4-9.3-9A5.3 5.3 0 0 1 12 6.6 5.3 5.3 0 0 1 21.3 12C19 16.6 12 21 12 21z" fill="currentColor" fill-opacity=".3"/>'),
  home: S('<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" fill="currentColor" fill-opacity=".25"/>'),
  hand: S('<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11.5V4a1.5 1.5 0 0 1 3 0v7.5M14 11.5V5.5a1.5 1.5 0 0 1 3 0V14c0 4-2.5 7-6.5 7S5 18.5 4 16l-1-2.5a1.5 1.5 0 0 1 2.7-1.3L8 15" fill="currentColor" fill-opacity=".2"/>'),
  info: S('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>'),
  star: S('<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" fill="currentColor" fill-opacity=".3"/>'),
  trophy: S('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z" fill="currentColor" fill-opacity=".25"/><path d="M7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3"/>'),
  shop: S('<path d="M4 9l1.5-5h13L20 9M4 9h16v11H4z" fill="currentColor" fill-opacity=".2"/><path d="M4 9a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0M10 20v-5h4v5"/>'),
  photo: S('<rect x="3" y="4" width="18" height="16" rx="2" fill="currentColor" fill-opacity=".2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>'),
};

export function iconBtn(icon: keyof typeof ICONS, label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = h('button', { class: 'icon-btn ' + cls, title: label, onclick: (e: Event) => { e.stopPropagation(); onClick(); } }, svg(ICONS[icon]), label);
  return b;
}

export function clear(el: HTMLElement) {
  while (el.firstChild) el.removeChild(el.firstChild);
}
