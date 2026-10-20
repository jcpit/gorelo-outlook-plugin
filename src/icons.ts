import {
  faArrowLeft, faArrowRight, faCircleCheck, faComputer,
  faEnvelope, faPaperclip, faTicket, faTriangleExclamation,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons';

const symbols = {
  mail: faEnvelope, ticket: faTicket, asset: faComputer,
  arrow: faArrowRight, back: faArrowLeft, check: faCircleCheck,
  paperclip: faPaperclip, alert: faTriangleExclamation,
} satisfies Record<string, IconDefinition>;

export type GoreloIconName = keyof typeof symbols;

export function icon(name: GoreloIconName): SVGElement {
  const [width, height, , , data] = symbols[name].icon;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of Array.isArray(data) ? data : [data]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
