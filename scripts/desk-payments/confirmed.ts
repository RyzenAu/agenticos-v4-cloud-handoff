// A ConfirmedPress is the ONLY thing that lets the browser hands press a money button (scripts/j2/agent-browser.ts
// pressBound). The desk payment store makes one when a pending payment is consumed by his click on the card or his
// yes at the desk (scripts/desk-payments/store.ts), and each is good for one press of one control.
// This file has no other logic on purpose: the hands import it without pulling in the service. The class has no public
// way to build one; `mintConfirmed` is the store's, and a test (desk-payments.test.ts "only the store mints") fails if any
// other file names it.
export type BoundControl = {
  /** The control's signature: role, name and which of the same-named controls on the page it is. */
  element: string;
  /** The tab it was read on and its address, host and title at that moment. */
  targetId: string;
  url: string;
  host: string;
};

const MINT = Symbol("desk-payment-confirmed");

export class ConfirmedPress {
  /** Set by pressBound the moment the press is made (or refused after the check): it never presses twice. */
  used = false;
  constructor(
    mint: symbol,
    readonly paymentId: string,
    readonly how: "card-click" | "spoken-yes" | "typed-yes",
    readonly control: BoundControl,
    readonly at: number,
  ) {
    if (mint !== MINT) throw new Error("A ConfirmedPress is made only by the desk payment store.");
  }
}

/** For the desk payment store only. */
export function mintConfirmed(paymentId: string, how: ConfirmedPress["how"], control: BoundControl, at: number): ConfirmedPress {
  return new ConfirmedPress(MINT, paymentId, how, control, at);
}
