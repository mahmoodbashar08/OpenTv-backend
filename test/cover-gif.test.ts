import { describe, expect, it } from 'vitest';
import { callForm, freshDatabase, insertProfile, makeEnv, tokenFor } from './harness';

/** An uploaded GIF banner is Plus, and only ever a banner — never an avatar. */
describe('uploading a GIF banner', () => {
  const setup = async (plus: boolean) => {
    const fresh = freshDatabase();
    insertProfile(fresh.raw, 'p1', 'mahmood');
    if (plus) fresh.raw.prepare("UPDATE profiles SET plus_until = '2099-01-01T00:00:00Z' WHERE id = 'p1'").run();
    const stored: string[] = [];
    const bucket = { put: async (k: string) => void stored.push(k), delete: async () => {} } as unknown as R2Bucket;
    const env = { ...makeEnv(fresh.db), AVATARS: bucket };
    return { env, stored, token: await tokenFor(env, 'p1') };
  };
  const gif = () => {
    const f = new FormData();
    f.append('image', new File([new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])], 'b.gif', { type: 'image/gif' }));
    return f;
  };

  it('refuses without Plus', async () => {
    const { env, stored, token } = await setup(false);
    expect((await callForm(env, '/v1/me/cover', gif(), token)).status).toBe(403);
    expect(stored).toHaveLength(0);
  });

  it('stores a .gif banner on Plus', async () => {
    const { env, stored, token } = await setup(true);
    const res = await callForm(env, '/v1/me/cover', gif(), token);
    expect(res.status).toBe(200);
    expect(stored[0]).toMatch(/\.gif$/);
  });

  it('never takes a GIF avatar, Plus or not', async () => {
    const { env, token } = await setup(true);
    expect((await callForm(env, '/v1/me/avatar', gif(), token)).status).toBe(415);
  });
});
