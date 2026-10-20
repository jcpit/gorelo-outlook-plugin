import type { Address } from './mail';

export function nameParts(address: Address): { firstName: string; lastName: string } {
  const local = address.email.split('@')[0] || '';
  const parts = (address.name.trim() || local.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[._-]+/g, ' '))
    .split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || 'Email', lastName: parts.slice(1).join(' ') || 'Contact' };
}

export function uniqueRecipients(email: { from: Address; to: Address[]; cc: Address[] }, technicianEmails: ReadonlySet<string> = new Set(), includeTo = false): Array<Address & { role: string }> {
  const seen = new Map<string, Address & { role: string }>();
  for (const { addresses, role } of [{ addresses: includeTo ? email.to : [], role: 'To' }, { addresses: email.cc, role: 'Cc' }]) {
    for (const address of addresses) {
      const key = address.email.trim().toLowerCase();
      if (!key || key === email.from.email.trim().toLowerCase() || technicianEmails.has(key)) continue;
      if (!seen.has(key)) seen.set(key, { ...address, email: key, role });
    }
  }
  return [...seen.values()];
}
