type OfficeHost = {
  HostType?: { Outlook: unknown };
  onReady(): PromiseLike<{ host: unknown }>;
  context?: { mailbox?: unknown };
};

// Host detection is a UI gate, not authentication. Business APIs still require
// the user's Microsoft access token and assigned Gorelo role.
export async function isOutlookHost(office: OfficeHost | undefined): Promise<boolean> {
  if (!office) return false;
  try {
    const ready = await office.onReady();
    return office.HostType?.Outlook != null && ready.host === office.HostType.Outlook && Boolean(office.context?.mailbox);
  } catch {
    return false;
  }
}
