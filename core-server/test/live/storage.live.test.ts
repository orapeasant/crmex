import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { liveEnv, setupLiveFixture, type LiveFixture } from './harness';

/**
 * docs/spec/test-plan.md §18.4 (TEN-18, TEN-27) and §2.2 (ISO-07) against the
 * real Storage policies.
 *
 * The bucket is private and carries exactly one client policy —
 * `firm_images_read`, keyed on the FIRST path segment being a firm the caller
 * belongs to. Objects live at <org_id>/<user_id>/<sha256>.png; writes and
 * deletes are service-role only.
 */
const live = liveEnv();
const describeLive = live ? describe : describe.skip;

const BUCKET = 'user-images';
const png = (seed: string) => Buffer.from(`fake-png-${seed}`);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describeLive('TEN/ISO (live): Storage folder policy', () => {
  let f: LiveFixture;
  const uploaded: string[] = [];

  let pathA: string;
  let pathAUpper: string;
  let pathB: string;
  let legacyPath: string;
  let nonUuidPath: string;
  let topLevelPath: string;

  const upload = async (objectPath: string, body: Buffer) => {
    const { error } = await f.admin.storage
      .from(BUCKET)
      .upload(objectPath, body, { contentType: 'image/png', upsert: true });
    if (error) throw new Error(`upload ${objectPath}: ${error.message}`);
    uploaded.push(objectPath);
  };

  beforeAll(async () => {
    f = await setupLiveFixture();

    const bytesA = png(`a-${f.runId}`);
    const bytesB = png(`b-${f.runId}`);

    pathA = `${f.orgA}/${f.A1.id}/${sha(bytesA)}.png`;
    // Same firm, spelled with an upper-case uuid: the policy's regex is
    // case-insensitive, so this must be readable too rather than denied.
    pathAUpper = `${f.orgA.toUpperCase()}/${f.A1.id}/${sha(bytesA)}.png`;
    pathB = `${f.orgB}/${f.B1.id}/${sha(bytesB)}.png`;
    // Pre-tenancy layout: the first segment is a user id, not a firm id.
    legacyPath = `${f.A1.id}/${sha(bytesA)}.png`;
    nonUuidPath = `not-a-uuid-${f.runId}/${sha(bytesA)}.png`;
    topLevelPath = `toplevel-${f.runId}.png`;

    await upload(pathA, bytesA);
    await upload(pathAUpper, bytesA);
    await upload(pathB, bytesB);
    await upload(legacyPath, bytesA);
    await upload(nonUuidPath, bytesA);
    await upload(topLevelPath, bytesA);
  }, 120_000);

  afterAll(async () => {
    if (!f) return;
    if (uploaded.length) await f.admin.storage.from(BUCKET).remove(uploaded);
    await f.teardown();
  }, 60_000);

  it("TEN-18: a firm member reads another member's object, in either uuid case", async () => {
    const { data, error } = await f.A2.db.storage.from(BUCKET).download(pathA);
    expect(error).toBeNull();
    expect(data).not.toBeNull();

    const { error: upperErr } = await f.A2.db.storage.from(BUCKET).download(pathAUpper);
    expect(upperErr, 'an upper-case firm folder must not be denied').toBeNull();
  });

  it('TEN-18: B1 reads only Firm B — Firm A objects are denied', async () => {
    const { data: own, error: ownErr } = await f.B1.db.storage.from(BUCKET).download(pathB);
    expect(ownErr).toBeNull();
    expect(own).not.toBeNull();

    const { data, error } = await f.B1.db.storage.from(BUCKET).download(pathA);
    expect(data === null || error !== null, "B1 downloaded Firm A's object").toBe(true);
  });

  it('TEN-18: legacy, non-uuid and top-level paths are denied without a cast error', async () => {
    for (const [label, objectPath] of [
      ['legacy <user_id>/ path', legacyPath],
      ['non-uuid folder', nonUuidPath],
      ['top-level object', topLevelPath],
    ] as const) {
      const { data, error } = await f.A1.db.storage.from(BUCKET).download(objectPath);
      expect(data === null || error !== null, `${label} was readable`).toBe(true);
      // A cast failure would surface as a 500; the policy must simply not match.
      const status = (error as { statusCode?: string } | null)?.statusCode;
      if (status) expect(Number(status), `${label} raised a server error`).toBeLessThan(500);
    }
  });

  it('TEN-18: clients cannot upload or delete, even inside their own firm', async () => {
    const bytes = png(`client-write-${f.runId}`);
    const target = `${f.orgA}/${f.A1.id}/${sha(bytes)}.png`;

    const { error: uploadErr } = await f.A1.db.storage.from(BUCKET).upload(target, bytes, { contentType: 'image/png' });
    expect(uploadErr, 'a client must not be able to write to the bucket').not.toBeNull();

    const { data: removed } = await f.A1.db.storage.from(BUCKET).remove([pathA]);
    expect(removed ?? [], 'a client must not be able to delete an object').toEqual([]);

    // still there
    const { error: stillErr } = await f.admin.storage.from(BUCKET).download(pathA);
    expect(stillErr).toBeNull();
  });

  it('TEN-27: B1 gets no signed URL for a Firm A object', async () => {
    const { data, error } = await f.B1.db.storage.from(BUCKET).createSignedUrl(pathA, 60);
    expect(data?.signedUrl ?? null, 'a signed URL was issued across firms').toBeNull();
    expect(error).not.toBeNull();
  });

  it('TEN-27: a member does get a signed URL for their own firm, and it fetches', async () => {
    const { data, error } = await f.A2.db.storage.from(BUCKET).createSignedUrl(pathA, 60);
    expect(error).toBeNull();
    expect(data?.signedUrl).toBeTruthy();

    const res = await fetch(data!.signedUrl);
    expect(res.status).toBe(200);
  });

  it('ISO-07: an unauthenticated GET of a known object path is denied — the bucket is private', async () => {
    const base = live!.url;

    const publicRes = await fetch(`${base}/storage/v1/object/public/${BUCKET}/${pathA}`);
    expect(publicRes.ok, 'the bucket is served publicly').toBe(false);

    const authedRes = await fetch(`${base}/storage/v1/object/${BUCKET}/${pathA}`);
    expect(authedRes.ok, 'an object was readable with no credentials at all').toBe(false);

    // The anon role holds a valid API key but no session: still nothing.
    const { data, error } = await f.anon.storage.from(BUCKET).download(pathA);
    expect(data === null || error !== null).toBe(true);
  });

  it('TEN-18: listing a firm folder shows only firms the caller belongs to', async () => {
    const { data: ownList } = await f.A2.db.storage.from(BUCKET).list(`${f.orgA}/${f.A1.id}`);
    expect((ownList ?? []).length).toBeGreaterThan(0);

    const { data: crossList } = await f.B1.db.storage.from(BUCKET).list(`${f.orgA}/${f.A1.id}`);
    expect(crossList ?? [], "B1 listed Firm A's folder").toEqual([]);
  });
});
