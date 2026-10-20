export function assetPresence(statusName?: string): 'online' | 'offline' | undefined {
  const status = statusName?.trim().toLowerCase();
  if (status === 'online') return 'online';
  if (status === 'offline') return 'offline';
  return undefined;
}

export function presenceLabel(statusName?: string): HTMLElement | undefined {
  const state = assetPresence(statusName);
  if (!state) return undefined;
  const label = document.createElement('span');
  label.className = 'asset-presence';
  const dot = document.createElement('span');
  dot.className = `presence-dot ${state}`;
  dot.setAttribute('aria-hidden', 'true');
  label.append(dot, document.createTextNode(state === 'online' ? 'Online' : 'Offline'));
  return label;
}
