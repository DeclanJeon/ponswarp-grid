/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SHOW_QA_CONTROLS?: string;
  readonly VITE_COMMIT_SHA?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
