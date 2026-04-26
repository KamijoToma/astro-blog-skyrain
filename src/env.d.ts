declare const __COMMIT_HASH__: string
declare const __BUILD_DATE__: string

interface ImportMetaEnv {
  readonly PUBLIC_TURNSTILE_SITE_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
