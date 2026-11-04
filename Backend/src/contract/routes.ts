const pattern = {
  runs: "/runs",
  run: "/runs/:id",
  versions: "/runs/:id/versions",
  version: "/runs/:id/versions/:n",
  comments: "/runs/:id/versions/:n/comments",
  // Sign-off (DEC-019): findings of a version (optionally ?audience=program_officer|clinician), its
  // approval status, and one signature endpoint per role (:role is program_officer or clinician).
  findings: "/runs/:id/versions/:n/findings",
  // The cross-check flags of a version, stored as flags.json for the front end (DEC-035).
  flags: "/runs/:id/versions/:n/flags",
  status: "/runs/:id/versions/:n/status",
  sign: "/runs/:id/versions/:n/signatures/:role",
  // The clinician's rejection with a comment (AR-06, RR-02; DEC-020).
  reject: "/runs/:id/versions/:n/reject",
  resume: "/runs/:id/resume",
  // Timing and cost of a run: per step, per model call, cumulative, with AWS extras estimated.
  metrics: "/runs/:id/metrics",
  ping: "/ping",
  invocations: "/invocations",
  events: "/events",
} as const;

// Patterns an "http" invocation may reach: the API routes, never ping or invocations.
const proxiable = [
  pattern.runs,
  pattern.run,
  pattern.versions,
  pattern.version,
  pattern.comments,
  pattern.findings,
  pattern.flags,
  pattern.status,
  pattern.sign,
  pattern.reject,
  pattern.resume,
  pattern.metrics,
] as const;

export const routes = {
  runs: () => "/runs",
  run: (id: string) => `/runs/${id}`,
  versions: (id: string) => `/runs/${id}/versions`,
  version: (id: string, n: number) => `/runs/${id}/versions/${n}`,
  comments: (id: string, n: number) => `/runs/${id}/versions/${n}/comments`,
  findings: (id: string, n: number) => `/runs/${id}/versions/${n}/findings`,
  flags: (id: string, n: number) => `/runs/${id}/versions/${n}/flags`,
  status: (id: string, n: number) => `/runs/${id}/versions/${n}/status`,
  sign: (id: string, n: number, role: string) => `/runs/${id}/versions/${n}/signatures/${role}`,
  reject: (id: string, n: number) => `/runs/${id}/versions/${n}/reject`,
  resume: (id: string) => `/runs/${id}/resume`,
  metrics: (id: string) => `/runs/${id}/metrics`,
  ping: () => "/ping",
  invocations: () => "/invocations",
  events: () => "/events",
  pattern,
  proxiable,
} as const;
