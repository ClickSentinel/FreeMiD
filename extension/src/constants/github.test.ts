import { describe, expect, it } from 'vitest';

import { GITHUB_REPO, githubLatestDownloadUrl, githubRepoUrl } from './github';

describe('github constants', () => {
  it('exposes the expected repo slug', () => {
    expect(GITHUB_REPO).toBe('ClickSentinel/FreeMiD');
  });

  it('builds latest-download URLs', () => {
    expect(githubLatestDownloadUrl('freemid-setup.exe')).toBe(
      'https://github.com/ClickSentinel/FreeMiD/releases/latest/download/freemid-setup.exe',
    );
  });

  it('builds repo URLs with and without fragments', () => {
    expect(githubRepoUrl()).toBe('https://github.com/ClickSentinel/FreeMiD');
    expect(githubRepoUrl('installation')).toBe(
      'https://github.com/ClickSentinel/FreeMiD#installation',
    );
  });
});
