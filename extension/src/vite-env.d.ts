/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DISCORD_CLIENT_ID: string;
  readonly VITE_UPDATE_LATEST_URL?: string;
  readonly VITE_UPDATE_RELEASES_BASE?: string;
  readonly VITE_MIN_SELF_UPDATE_HOST_VERSION?: string;
  readonly VITE_DISCORD_CHECK_DELAY_MS?: string;
  readonly VITE_WINDOWS_SETUP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
