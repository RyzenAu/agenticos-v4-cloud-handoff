/** The message for a failed job-history read: the server's own reason (without its closing full stop) with the status, else the status alone. */
export function jobsReadMessage(why: string, status: number): string {
  const reason = why.trim().replace(/\.+$/, "");
  return reason ? `${reason} (HTTP ${status})` : `The server answered HTTP ${status}`;
}
