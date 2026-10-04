/** Where a closing dialog may put focus back: the control that opened it, only if it is still in the page AND visible. A control that is
 *  connected but hidden (a collapsed menu, display:none) silently ignores focus(), and taking over would also cancel Radix's own fallback. */
export function focusReturnTarget(opener: HTMLElement | null): HTMLElement | null {
  return opener && opener.isConnected && opener.getClientRects().length > 0 ? opener : null;
}
