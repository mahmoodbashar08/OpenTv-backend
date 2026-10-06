import { describe, expect, it } from 'vitest';
import { ADMIN_PAGE } from '@/admin-page';

/**
 * The dashboard's script lives inside a TypeScript template string, where a
 * `\n` meant for a JS string becomes a real line break — a syntax error that
 * killed the whole page, sign-in included (6 Oct). Parse it here first.
 */
describe('the dashboard page', () => {
  it('carries a script that parses', () => {
    const scripts = [...ADMIN_PAGE.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(scripts.length).toBeGreaterThan(0);
    for (const js of scripts) expect(() => new Function(js)).not.toThrow();
  });
});
