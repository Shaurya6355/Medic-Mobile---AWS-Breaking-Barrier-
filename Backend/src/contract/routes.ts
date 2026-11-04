const pattern = {
  runs: "/runs",
  run: "/runs/:id",
  versions: "/runs/:id/versions",
  version: "/runs/:id/versions/:n",
  comments: "/runs/:id/versions/:n/comments",
  resume: "/runs/:id/resume",
  ping: "/ping",
  invocations: "/invocations",
  events: "/events",
} as const;

// Patterns an "http" invocation may reach: the API routes, never ping or invocations.
const proxiable = [pattern.runs, pattern.run, pattern.versions, pattern.version, pattern.comments, pattern.resume] as const;

export const routes = {
  runs: () => "/runs",
  run: (id: string) => `/runs/${id}`,
  versions: (id: string) => `/runs/${id}/versions`,
  version: (id: string, n: number) => `/runs/${id}/versions/${n}`,
  comments: (id: string, n: number) => `/runs/${id}/versions/${n}/comments`,
  resume: (id: string) => `/runs/${id}/resume`,
  ping: () => "/ping",
  invocations: () => "/invocations",
  events: () => "/events",
  pattern,
  proxiable,
} as const;
