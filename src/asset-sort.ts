import type { AssetItem } from './browse';

export function senderUsesDevice(asset: AssetItem, email: string): boolean {
  if (asset.kind !== 'agent' || !email.includes('@')) return false;
  const upn = asset.details?.lastLoggedOnUserUpn?.trim().toLowerCase() || '';
  const sender = email.trim().toLowerCase();
  // An email UPN has an unambiguous domain: never replace a mismatch with a name guess.
  if (upn.includes('@')) return upn === sender;
  const localPart = sender.split('@')[0]!.replace(/[^a-z0-9]/g, '');
  const accountMatches = (account: string): boolean => {
    const user = account.trim().toLowerCase().split('\\').pop() || '';
    return Boolean(localPart) && user.replace(/[^a-z0-9]/g, '') === localPart;
  };
  return Boolean((upn && accountMatches(upn)) || (asset.details?.lastLoggedOnUser && accountMatches(asset.details.lastLoggedOnUser)));
}

export function prioritizeSenderDevices(assets: AssetItem[], email: string): AssetItem[] {
  return [...assets].sort((left, right) => Number(senderUsesDevice(right, email)) - Number(senderUsesDevice(left, email)));
}
