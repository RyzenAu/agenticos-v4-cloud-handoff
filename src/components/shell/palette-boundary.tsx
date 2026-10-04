import { Component, type ReactNode } from "react";

/**
 * The palette's code loads on first use. When that fails (offline, or the hub is down) only the palette is missing: a one-line notice, and the
 * page underneath and anything typed on it stay (audit S13: Ctrl+K while offline replaced the whole app with the error screen).
 */
export class PaletteLoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  private timer: ReturnType<typeof setTimeout> | undefined;
  componentDidCatch() { this.timer = setTimeout(() => this.setState({ failed: false }), 6000); }
  componentWillUnmount() { if (this.timer) clearTimeout(this.timer); }
  render() {
    if (!this.state.failed) return this.props.children;
    const offline = typeof navigator !== "undefined" && !navigator.onLine;
    return (
      <div role="status" className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-border bg-card px-4 py-2 text-sm text-foreground shadow-lg">
        {offline ? "Go to… can't open while you're offline." : "Go to… couldn't load. Try again in a moment."}
      </div>
    );
  }
}
