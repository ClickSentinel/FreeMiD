export function urlLike(value?: string): boolean {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}
