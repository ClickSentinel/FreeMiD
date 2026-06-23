import { afterEach, vi } from 'vitest';

import.meta.env.VITE_DISCORD_CLIENT_ID = 'test-discord-client-id';

afterEach(() => {
  vi.restoreAllMocks();
});
