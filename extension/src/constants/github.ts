export const GITHUB_REPO = 'ClickSentinel/FreeMiD';

export function githubLatestDownloadUrl(fileName: string): string {
  return `https://github.com/${GITHUB_REPO}/releases/latest/download/${fileName}`;
}

export function githubRepoUrl(fragment?: string): string {
  return fragment ? `https://github.com/${GITHUB_REPO}#${fragment}` : `https://github.com/${GITHUB_REPO}`;
}

