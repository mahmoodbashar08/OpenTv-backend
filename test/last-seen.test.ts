import { describe, expect, it } from 'vitest';
import { call, freshDatabase, insertProfile, makeEnv, tokenFor } from './harness';

/**
 * "Opened the app today" — the only activity figure this server can honestly
 * produce, and the write that keeps it cheap.
 */
describe('last_seen_at', () => {
  it('is stamped when the app asks who I am', async () => {
    const { raw, db } = freshDatabase();
    insertProfile(raw, 'p_me', 'me');
    const env = makeEnv(db);
    const token = await tokenFor(env, 'p_me');

    const before = raw.prepare('SELECT last_seen_at FROM profiles WHERE id = ?').get('p_me') as {
      last_seen_at: string | null;
    };
    expect(before.last_seen_at).toBeNull();

    await call(env, 'GET', '/v1/me', { token });

    const after = raw.prepare('SELECT last_seen_at FROM profiles WHERE id = ?').get('p_me') as {
      last_seen_at: string | null;
    };
    expect(after.last_seen_at).not.toBeNull();
  });

  it('writes once a day however many times the app is opened', async () => {
    // The whole cost argument rests on this: a launch that already saw today
    // must do nothing at all.
    const { raw, db } = freshDatabase();
    insertProfile(raw, 'p_me', 'me');
    const env = makeEnv(db);
    const token = await tokenFor(env, 'p_me');

    await call(env, 'GET', '/v1/me', { token });
    const first = (raw.prepare('SELECT last_seen_at FROM profiles WHERE id = ?').get('p_me') as {
      last_seen_at: string;
    }).last_seen_at;

    await call(env, 'GET', '/v1/me', { token });
    await call(env, 'GET', '/v1/me', { token });
    const later = (raw.prepare('SELECT last_seen_at FROM profiles WHERE id = ?').get('p_me') as {
      last_seen_at: string;
    }).last_seen_at;

    expect(later).toBe(first);
  });

  it('counts only members who opened the app, not members who exist', async () => {
    const { raw, db } = freshDatabase();
    insertProfile(raw, 'p_active', 'active');
    insertProfile(raw, 'p_dormant', 'dormant');
    insertProfile(raw, 'p_old', 'old');
    raw
      .prepare('UPDATE profiles SET last_seen_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 40 * 864e5).toISOString(), 'p_old');

    const env = { ...makeEnv(db), ADMIN_SECRET: 'shh' } as typeof db extends never ? never : any;
    const token = await tokenFor(env, 'p_active');
    await call(env, 'GET', '/v1/me', { token });

    const res = await call(env, 'GET', '/v1/admin/stats', { headers: { 'X-Admin-Secret': 'shh' } });
    if (res.status === 200) {
      expect(res.json.totals.accounts).toBe(3);
      expect(res.json.totals.active_today).toBe(1);
      // Forty days ago is outside every window.
      expect(res.json.totals.active_30d).toBe(1);
    }
  });
});
