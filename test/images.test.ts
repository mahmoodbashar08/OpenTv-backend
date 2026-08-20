import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@/env';
import { MAX_COMMENT_IMAGE_BYTES } from '@/pure';
import { call, callForm, fakeBucket, freshDatabase, insertProfile, makeEnv, tokenFor } from './harness';

/**
 * Rescuing TV Time comment photographs.
 *
 * THE POINT OF THIS SUITE. TV Time's CDN is gone, so the copies on users'
 * phones are the only ones left and every reinstall destroys some. An endpoint
 * that answers 200 while quietly failing to bind an image to its comment would
 * look exactly like success and lose the thing it was built to save. So the
 * assertions are about what is in the BUCKET and in `comment_images`, never
 * about the status code alone.
 *
 * The second theme is that nothing here is served. `scan_status` must be
 * 'pending' on every stored row: preserving a picture and publishing it are
 * different decisions, and only the first one is being made.
 */

let raw: Database.Database;
let env: Env;
let bucket: ReturnType<typeof fakeBucket>;
let token: string;

const COMMENT = {
  target_source: 'tvdb',
  target_key: '121361',
  season: 1,
  episode: 3,
  body: 'That scene wrecked me.',
  created_at: '2019-04-02T10:00:00.000Z',
};

/** A file whose bytes are real enough to assert on. */
function imageFile(type = 'image/jpeg', bytes = 64, name = 'photo.jpg'): File {
  return new File([new Uint8Array(bytes).fill(7)], name, { type });
}

function form(over: Record<string, string> = {}, file: File | null = imageFile()): FormData {
  const fd = new FormData();
  if (file) fd.set('image', file);
  fd.set('target_source', COMMENT.target_source);
  fd.set('target_key', COMMENT.target_key);
  fd.set('season', String(COMMENT.season));
  fd.set('episode', String(COMMENT.episode));
  fd.set('body', COMMENT.body);
  fd.set('created_at', COMMENT.created_at);
  for (const [k, v] of Object.entries(over)) fd.set(k, v);
  return fd;
}

/** The comment has to exist first — an image belongs to something. */
async function importTheComment(): Promise<void> {
  const res = await call(env, 'POST', '/v1/comments/import', { token, body: { items: [COMMENT] } });
  expect(res.status).toBe(200);
}

const storedRow = () =>
  raw.prepare('SELECT comment_id, r2_key, is_gif, scan_status, width, height FROM comment_images').get() as
    | { comment_id: string; r2_key: string; is_gif: number; scan_status: string; width: number | null; height: number | null }
    | undefined;

beforeEach(async () => {
  const fresh = freshDatabase();
  raw = fresh.raw;
  bucket = fakeBucket();
  env = makeEnv(fresh.db, bucket);
  insertProfile(raw, 'p1', 'mahmood');
  insertProfile(raw, 'p2', 'sara');
  token = await tokenFor(env, 'p1');
});

describe('POST /v1/comments/image', () => {
  it('stores the bytes and binds them to the comment', async () => {
    await importTheComment();
    const res = await callForm(env, '/v1/comments/image', form(), token);

    expect(res.status).toBe(200);
    expect(res.json.stored).toBe(true);

    const row = storedRow();
    expect(row?.comment_id).toBe(res.json.comment_id);
    // In the bucket, under the key the row names, with its real type.
    expect(bucket.stored.get(row!.r2_key)).toEqual({ size: 64, type: 'image/jpeg' });
  });

  it('stores it as PENDING — nothing is published by preserving it', async () => {
    await importTheComment();
    await callForm(env, '/v1/comments/image', form(), token);
    expect(storedRow()?.scan_status).toBe('pending');
  });

  it('derives the same id the import did, so the image finds its own comment', async () => {
    await importTheComment();
    const res = await callForm(env, '/v1/comments/image', form(), token);
    const comment = raw.prepare('SELECT id FROM comments').get() as { id: string };
    expect(res.json.comment_id).toBe(comment.id);
  });

  it('is idempotent — a re-run neither duplicates the row nor spends an upload', async () => {
    await importTheComment();
    await callForm(env, '/v1/comments/image', form(), token);
    const second = await callForm(env, '/v1/comments/image', form(), token);

    expect(second.status).toBe(200);
    expect(second.json.stored).toBe(false);
    expect((raw.prepare('SELECT COUNT(*) AS n FROM comment_images').get() as { n: number }).n).toBe(1);
    expect(bucket.stored.size).toBe(1);
  });

  it('records a GIF as one, because it is displayed differently', async () => {
    await importTheComment();
    await callForm(env, '/v1/comments/image', form({}, imageFile('image/gif', 32, 'a.gif')), token);
    expect(storedRow()?.is_gif).toBe(1);
    expect(storedRow()?.r2_key.endsWith('.gif')).toBe(true);
  });

  it('keeps the dimensions when the phone sends them', async () => {
    await importTheComment();
    await callForm(env, '/v1/comments/image', form({ width: '1200', height: '1600' }), token);
    expect(storedRow()?.width).toBe(1200);
    expect(storedRow()?.height).toBe(1600);
  });

  it('refuses an image for a comment that was never imported', async () => {
    const res = await callForm(env, '/v1/comments/image', form(), token);
    expect(res.status).toBe(404);
    expect(bucket.stored.size).toBe(0);
  });

  it("cannot attach an image to somebody else's comment", async () => {
    await importTheComment();
    // p2 sends p1's exact details. The id is derived from the AUTHOR, so p2
    // arrives at a different id — one with no comment behind it.
    const res = await callForm(env, '/v1/comments/image', form(), await tokenFor(env, 'p2'));
    expect(res.status).toBe(404);
    expect((raw.prepare('SELECT COUNT(*) AS n FROM comment_images').get() as { n: number }).n).toBe(0);
  });

  it('requires a token', async () => {
    const res = await callForm(env, '/v1/comments/image', form());
    expect(res.status).toBe(401);
  });

  it('refuses a file that is not an image', async () => {
    await importTheComment();
    const res = await callForm(env, '/v1/comments/image', form({}, imageFile('application/pdf', 10, 'x.pdf')), token);
    expect(res.status).toBe(415);
    expect(bucket.stored.size).toBe(0);
  });

  it('refuses an oversized image before it is stored', async () => {
    await importTheComment();
    const big = imageFile('image/jpeg', MAX_COMMENT_IMAGE_BYTES + 1);
    const res = await callForm(env, '/v1/comments/image', form({}, big), token);
    expect(res.status).toBe(413);
    expect(bucket.stored.size).toBe(0);
  });

  it('refuses an empty file', async () => {
    await importTheComment();
    const res = await callForm(env, '/v1/comments/image', form({}, imageFile('image/jpeg', 0)), token);
    expect(res.status).toBe(400);
  });

  it('refuses a request with no file at all', async () => {
    await importTheComment();
    const res = await callForm(env, '/v1/comments/image', form({}, null), token);
    expect(res.status).toBe(400);
  });

  it('refuses an unusable target or timestamp', async () => {
    await importTheComment();
    expect((await callForm(env, '/v1/comments/image', form({ target_key: '' }), token)).status).toBe(400);
    expect((await callForm(env, '/v1/comments/image', form({ created_at: 'soon' }), token)).status).toBe(400);
  });

  it('accepts a PICTURE-ONLY comment — the case this whole route exists for', async () => {
    // Two of the four comments in the reference TV Time export have no text at
    // all, and they are exactly the two carrying photographs. Requiring words
    // discarded precisely the rows worth rescuing.
    const noWords = { ...COMMENT, body: '', has_image: true };
    expect((await call(env, 'POST', '/v1/comments/import', { token, body: { items: [noWords] } })).status).toBe(200);

    const fd = form({ body: '' });
    const res = await callForm(env, '/v1/comments/image', fd, token);

    expect(res.status).toBe(200);
    expect(res.json.stored).toBe(true);
    expect(storedRow()?.comment_id).toBe(res.json.comment_id);
  });

  it('still refuses an empty comment that claims no image', async () => {
    const noWords = { ...COMMENT, body: '' };
    await call(env, 'POST', '/v1/comments/import', { token, body: { items: [noWords] } });
    // Nothing was imported, so there is nothing for an image to attach to.
    expect((raw.prepare('SELECT COUNT(*) AS n FROM comments').get() as { n: number }).n).toBe(0);
  });

  it('is OFF, not broken, when the deployment has no bucket bound', async () => {
    const fresh = freshDatabase();
    const noBucket = makeEnv(fresh.db);
    insertProfile(fresh.raw, 'p1', 'mahmood');
    const res = await callForm(noBucket, '/v1/comments/image', form(), await tokenFor(noBucket, 'p1'));
    expect(res.status).toBe(503);
    expect(res.json.error.code).toBe('unavailable');
  });
});

describe('POST /v1/comments/:id/image — a picture on a comment written now', () => {
  /** Write a comment through the normal route and hand back its server id. */
  async function postComment(as = token): Promise<string> {
    const res = await call(env, 'POST', '/v1/comments', {
      token: as,
      body: { target_source: 'tvdb', target_key: '121361', season: 1, episode: 4, body: 'Look at this.' },
    });
    expect(res.status).toBe(201);
    return res.json.id as string;
  }

  function picture(file: File = imageFile()): FormData {
    const fd = new FormData();
    fd.set('image', file);
    fd.set('width', '800');
    fd.set('height', '600');
    return fd;
  }

  const makePlus = (id: string) => raw.prepare('UPDATE profiles SET is_plus = 1 WHERE id = ?').run(id);

  it('refuses a picture from somebody who is not Plus, and stores nothing', async () => {
    const id = await postComment();
    const res = await callForm(env, `/v1/comments/${id}/image`, picture(), token);
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe('plus_required');
    expect(storedRow()).toBeUndefined();
  });

  it('stores a Plus subscriber\'s picture, PENDING and therefore not yet served', async () => {
    makePlus('p1');
    const id = await postComment();
    const res = await callForm(env, `/v1/comments/${id}/image`, picture(), token);
    expect(res.status).toBe(200);

    const row = storedRow();
    expect(row?.comment_id).toBe(id);
    expect(row?.scan_status).toBe('pending'); // nothing is visible until a person says so
    expect(row?.width).toBe(800);
    expect(bucket.stored.has(row!.r2_key)).toBe(true);
  });

  it('takes a GIF and remembers that is what it is', async () => {
    makePlus('p1');
    const id = await postComment();
    await callForm(env, `/v1/comments/${id}/image`, picture(imageFile('image/gif', 64, 'a.gif')), token);
    expect(storedRow()?.is_gif).toBe(1);
  });

  it('will not let anyone put a picture on somebody else\'s comment', async () => {
    makePlus('p1');
    makePlus('p2');
    const mine = await postComment();
    const other = await tokenFor(env, 'p2');
    const res = await callForm(env, `/v1/comments/${mine}/image`, picture(), other);
    // 404, not 403: an upload attempt must not confirm that a comment exists.
    expect(res.status).toBe(404);
    expect(storedRow()).toBeUndefined();
  });

  it('replacing a picture sends it back for review', async () => {
    makePlus('p1');
    const id = await postComment();
    await callForm(env, `/v1/comments/${id}/image`, picture(), token);
    raw.prepare("UPDATE comment_images SET scan_status = 'clean' WHERE comment_id = ?").run(id);

    await callForm(env, `/v1/comments/${id}/image`, picture(imageFile('image/png', 32, 'b.png')), token);
    // An approved stamp on bytes nobody approved is the one thing this must
    // never do.
    expect(storedRow()?.scan_status).toBe('pending');
  });

  it('refuses anything that is not an image', async () => {
    makePlus('p1');
    const id = await postComment();
    const res = await callForm(env, `/v1/comments/${id}/image`, picture(imageFile('application/pdf', 16, 'x.pdf')), token);
    expect(res.status).toBe(415);
    expect(storedRow()).toBeUndefined();
  });
});
