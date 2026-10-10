import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@/env';
import { parseTemplateBlocks } from '@/pure';
import { call, callForm, fakeBucket, freshDatabase, makeEnv } from './harness';

/**
 * Profile templates from the server (0053). What can go quietly wrong: a
 * template the phone would leave out (an unknown block, a wrong size) saved
 * without a word; a hidden or off-season template still reaching phones; a
 * banner address that does not resolve; and the dashboard's door standing
 * open.
 */
let env: Env;
let bucket: ReturnType<typeof fakeBucket>;
let cookie: string;

const BLOCKS = ['banners', 'intro', 'counts', 'shelf:fav-shows', 'binge + streak', 'nowWatching:2x1', 'stats', 'lists'].join('\n');

function form(over: Record<string, string> = {}, image: File | null = new File([new Uint8Array(64).fill(9)], 'b.jpg', { type: 'image/jpeg' })): FormData {
  const fd = new FormData();
  if (image) fd.set('image', image);
  fd.set('name', 'Ramadan Nights');
  fd.set('layout', 'cards');
  fd.set('primary', '#d4a537');
  fd.set('secondary', '#0F766E');
  fd.set('persona', 'devotee');
  fd.set('event', '');
  fd.set('blocks', BLOCKS);
  for (const [k, v] of Object.entries(over)) fd.set(k, v);
  return fd;
}

const make = (over: Record<string, string> = {}, image?: File | null) =>
  callForm(env, '/v1/admin/templates', form(over, image), undefined, { Cookie: cookie });

beforeEach(async () => {
  bucket = fakeBucket();
  env = { ...makeEnv(freshDatabase().db, bucket), ADMIN_EMAIL: 'me@example.com', ADMIN_PASSWORD: 'a-long-one' };
  const res = await call(env, 'POST', '/v1/admin/login', { body: { email: 'me@example.com', password: 'a-long-one' } });
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
});

describe('parseTemplateBlocks', () => {
  it('reads the dashboard lines into the app\'s block list', () => {
    expect(parseTemplateBlocks(BLOCKS)).toEqual({
      ok: true,
      blocks: ['banners', 'intro', 'counts', 'shelf:fav-shows', ['binge', 'streak'], 'nowWatching:2x1', 'stats', 'lists'],
    });
  });

  it('names the line that is wrong', () => {
    expect(parseTemplateBlocks('banners\nphotos')).toMatchObject({ ok: false, reason: 'unknown block "photos"' });
    expect(parseTemplateBlocks('banners\nstats:1x1')).toMatchObject({ ok: false, reason: '"stats" cannot be 1x1' });
    // A pair is two squares; a wide block in one breaks the row.
    expect(parseTemplateBlocks('banners\nstats + since')).toMatchObject({ ok: false });
    expect(parseTemplateBlocks('banners\na + b + c')).toMatchObject({ ok: false });
    // Private widgets and the ones that need their own content are not placeable.
    expect(parseTemplateBlocks('banners\nwatchlist')).toMatchObject({ ok: false });
    expect(parseTemplateBlocks('banners\ngif')).toMatchObject({ ok: false });
    expect(parseTemplateBlocks('intro\nbanners')).toMatchObject({ ok: false, reason: 'the first line must be banners' });
    expect(parseTemplateBlocks('')).toMatchObject({ ok: false });
    expect(parseTemplateBlocks(7)).toMatchObject({ ok: false });
  });
});

describe('the dashboard makes, hides and deletes a template', () => {
  it('refuses everything without the cookie', async () => {
    expect((await call(env, 'GET', '/v1/admin/templates')).status).toBe(401);
    expect((await callForm(env, '/v1/admin/templates', form())).status).toBe(401);
    expect((await call(env, 'POST', '/v1/admin/templates/x', { body: { hidden: true } })).status).toBe(401);
    expect((await call(env, 'DELETE', '/v1/admin/templates/x')).status).toBe(401);
  });

  it('stores the banner under templates/ and the row with the colours upper-cased', async () => {
    const res = await make();
    expect(res.status).toBe(201);
    const t = res.json.template;
    expect(t.banner).toBe(`https://api.opentv.test/v1/templates/${t.id}.jpg`);
    expect(t).toMatchObject({ name: 'Ramadan Nights', layout: 'cards', primary: '#D4A537', secondary: '#0F766E', persona: 'devotee', event: null, hidden: false });
    expect(t.blocks).toEqual(['banners', 'intro', 'counts', 'shelf:fav-shows', ['binge', 'streak'], 'nowWatching:2x1', 'stats', 'lists']);
    expect(bucket.stored.get(`templates/${t.id}.jpg`)).toMatchObject({ size: 64, type: 'image/jpeg' });

    const list = await call(env, 'GET', '/v1/admin/templates', { headers: { Cookie: cookie } });
    expect(list.json.items.map((x: { id: string }) => x.id)).toEqual([t.id]);
  });

  it('refuses what the phone would leave out, and says which field', async () => {
    expect((await make({ layout: 'grid' })).json.error.message).toContain('layout');
    expect((await make({ primary: 'purple' })).json.error.message).toContain('colours');
    expect((await make({ persona: 'hero' })).json.error.message).toContain('persona');
    expect((await make({ event: 'easter' })).json.error.message).toContain('event');
    expect((await make({ blocks: 'banners\nphotos' })).json.error.message).toContain('unknown block "photos"');
    expect((await make({ name: '' })).status).toBe(400);
    expect((await make({}, null)).status).toBe(400);
    expect((await make({}, new File([new Uint8Array(8)], 'b.gif', { type: 'image/gif' }))).status).toBe(415);
    expect(bucket.stored.size).toBe(0);
  });

  it('answers 503 rather than storing nowhere when there is no image bucket', async () => {
    const bare = { ...env, COMMENT_IMAGES: undefined };
    expect((await callForm(bare, '/v1/admin/templates', form(), undefined, { Cookie: cookie })).status).toBe(503);
  });

  it('hides, shows again, and deletes the banner with the row', async () => {
    const { id } = (await make()).json.template;
    expect((await call(env, 'POST', `/v1/admin/templates/${id}`, { body: { hidden: true }, headers: { Cookie: cookie } })).json).toEqual({ ok: true, hidden: true });
    expect((await call(env, 'GET', '/v1/admin/templates', { headers: { Cookie: cookie } })).json.items[0].hidden).toBe(true);
    expect((await call(env, 'POST', `/v1/admin/templates/${id}`, { body: { hidden: 'yes' }, headers: { Cookie: cookie } })).status).toBe(400);
    expect((await call(env, 'POST', '/v1/admin/templates/nope', { body: { hidden: false }, headers: { Cookie: cookie } })).status).toBe(404);

    expect((await call(env, 'DELETE', `/v1/admin/templates/${id}`, { headers: { Cookie: cookie } })).status).toBe(204);
    expect(bucket.stored.size).toBe(0);
    expect((await call(env, 'GET', '/v1/admin/templates', { headers: { Cookie: cookie } })).json.items).toEqual([]);
    expect((await call(env, 'DELETE', `/v1/admin/templates/${id}`, { headers: { Cookie: cookie } })).status).toBe(404);
  });
});

describe('GET /v1/links carries the templates', () => {
  it('sends the visible ones, newest first, with an address on this origin', async () => {
    const first = (await make({ name: 'First' })).json.template;
    await new Promise((r) => setTimeout(r, 2));
    const second = (await make({ name: 'Second' })).json.template;
    const res = await call(env, 'GET', '/v1/links');
    expect(res.status).toBe(200);
    expect(res.json.templates.map((t: { name: string }) => t.name)).toEqual(['Second', 'First']);
    expect(res.json.templates[1].banner).toBe(first.banner);
    expect(res.json.templates[0].id).toBe(second.id);
    // Still no account needed and still cached: the same for everybody.
    expect(res.headers.get('Cache-Control')).toContain('max-age=300');
  });

  it('leaves out a hidden one', async () => {
    const { id } = (await make()).json.template;
    await call(env, 'POST', `/v1/admin/templates/${id}`, { body: { hidden: true }, headers: { Cookie: cookie } });
    expect((await call(env, 'GET', '/v1/links')).json.templates).toEqual([]);
  });

  it('sends an event-tied one only while that event is on', async () => {
    await make({ name: 'Pumpkins', event: 'halloween' });
    await make({ name: 'Always' });
    const names = async () => ((await call(env, 'GET', '/v1/links')).json.templates as { name: string }[]).map((t) => t.name).sort();
    expect(await names()).toEqual(['Always']);
    await env.CACHE.put('event:active', 'halloween');
    expect(await names()).toEqual(['Always', 'Pumpkins']);
    await env.CACHE.put('event:active', 'christmas');
    expect(await names()).toEqual(['Always']);
  });

  it('is an empty list, not an error, when there are none', async () => {
    expect((await call(env, 'GET', '/v1/links')).json.templates).toEqual([]);
  });
});

describe('GET /v1/templates/:name', () => {
  it('serves the banner, immutable, to anybody', async () => {
    const t = (await make()).json.template;
    const res = await call(env, 'GET', `/v1/templates/${t.id}.jpg`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('Cache-Control')).toContain('immutable');
    expect(res.text.length).toBe(64);
  });

  it('answers 404 for a name it does not hold, and never reads outside templates/', async () => {
    expect((await call(env, 'GET', '/v1/templates/missing.jpg')).status).toBe(404);
    expect((await call(env, 'GET', '/v1/templates/..%2Fcomments%2Fx.jpg')).status).toBe(404);
  });
});
