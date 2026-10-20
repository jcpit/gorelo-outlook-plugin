export type TicketStatus = { id: number; name: string; color?: string };

export function statusStyle(statusId: number | undefined, statusName: string, statuses: TicketStatus[]): { backgroundColor: string; color: string; borderColor: string } | undefined {
  const match = statusId
    ? statuses.find((status) => status.id === statusId)
    : statuses.find((status) => status.name.toLowerCase() === statusName.toLowerCase());
  const hex = match?.color;
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return undefined;
  const channels = [1, 3, 5].map((index) => {
    const value = parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  return { backgroundColor: hex, borderColor: luminance > 0.85 ? '#cbd7e5' : hex, color: luminance > 0.179 ? '#172438' : '#fff' };
}
