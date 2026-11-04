const pattern = {
  runs: "/runs",
  run: "/runs/:id",
  versions: "/runs/:id/versions",
  version: "/runs/:id/versions/:n",
  comments: "/runs/:id/versions/:n/comments",
  resume: "/runs/:id/resume",
} as const;

export const routes = {
  runs: () => "/runs",
  run: (id: string) => `/runs/${id}`,
  versions: (id: string) => `/runs/${id}/versions`,
  version: (id: string, n: number) => `/runs/${id}/versions/${n}`,
  comments: (id: string, n: number) => `/runs/${id}/versions/${n}/comments`,
  resume: (id: string) => `/runs/${id}/resume`,
  pattern,
} as const;
