/** Installed Hermes source enables CLI file logging and session persistence.
 * No supported per-task switch disabling both has been established. Do not infer
 * privacy from -Q, oneshot, ignore-rules, a temporary home, or browser defaults.
 * Code-owned gate: client flags and environment cannot override this boundary.
 * Synthetic runtime tests use trusted fixture executables, never this provider.
 */
export function hermesControlRetentionAdmission() {
  return {
    permitted: false as const,
    status: 503,
    body: { code: "hermes_retention_unverified", error: "Hermes control is unavailable: per-task transcript/history and file logging suppression has not been verified. Nothing was dispatched." },
  };
}
