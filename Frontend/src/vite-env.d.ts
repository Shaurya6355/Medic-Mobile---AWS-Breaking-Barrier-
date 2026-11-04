/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend base URL. Unset means the api layer uses in-memory sample data. */
  readonly VITE_API_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
