import { describe, expect, it } from 'vitest';
import { assertSafeReference, buildObjectPath, isPathInOrg, isServableSessionPath, UnsafeReferenceError } from '../../src/lib/paths';

describe('lib/paths', () => {
  it('ISO-15: rejects a path traversal reference', () => {
    expect(() => assertSafeReference('../deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef/secret.png')).toThrow(
      UnsafeReferenceError,
    );
  });

  it('ISO-16: rejects an absolute path (POSIX)', () => {
    expect(() => assertSafeReference('/etc/passwd')).toThrow(UnsafeReferenceError);
  });

  it('ISO-16: rejects an absolute path (Windows drive letter)', () => {
    expect(() => assertSafeReference('C:\\Windows\\System32\\evil.png')).toThrow(UnsafeReferenceError);
  });

  it('ISO-17: rejects a URL-encoded traversal after decoding', () => {
    expect(() => assertSafeReference('%2e%2e%2fsecret.png')).toThrow(UnsafeReferenceError);
  });

  it('ISO-17: rejects a double URL-encoded traversal after decoding', () => {
    expect(() => assertSafeReference('%252e%252e%252fsecret.png')).toThrow(UnsafeReferenceError);
  });

  it('ISO-18: rejects an empty reference', () => {
    expect(() => assertSafeReference('')).toThrow(UnsafeReferenceError);
    expect(() => assertSafeReference('   ')).toThrow(UnsafeReferenceError);
  });

  it('ISO-18: rejects a null/undefined reference, without constructing an unprefixed path', () => {
    expect(() => assertSafeReference(null)).toThrow(UnsafeReferenceError);
    expect(() => assertSafeReference(undefined)).toThrow(UnsafeReferenceError);
  });

  it('accepts a plain safe relative reference', () => {
    expect(assertSafeReference('abcd1234.png')).toBe('abcd1234.png');
  });

  const orgId = 'aaaaaaaa-0000-4000-8000-00000000000a';
  const otherOrg = 'bbbbbbbb-0000-4000-8000-00000000000b';
  const userId = '11111111-2222-3333-4444-555555555555';
  const hash = 'a'.repeat(64);

  it('ISO-19: builds exactly <org_id>/<user_id>/<sha256>.png from a verified firm, user id and server-computed hash', () => {
    expect(buildObjectPath(orgId, userId, hash)).toBe(`${orgId}/${userId}/${hash}.png`);
  });

  it('ISO-19: normalizes the org id to lowercase so one firm never has two folders', () => {
    expect(buildObjectPath(orgId.toUpperCase(), userId, hash)).toBe(`${orgId}/${userId}/${hash}.png`);
  });

  it('ISO-19: rejects a non-UUID org id (Storage policy casts the first folder to uuid)', () => {
    expect(() => buildObjectPath('../evil', userId, hash)).toThrow(/INVALID_ORG_ID/);
    expect(() => buildObjectPath('', userId, hash)).toThrow(/INVALID_ORG_ID/);
    expect(() => buildObjectPath(`${orgId}/x`, userId, hash)).toThrow(/INVALID_ORG_ID/);
  });

  it('ISO-19: rejects an unsafe user id (no client input can smuggle a path segment in)', () => {
    expect(() => buildObjectPath(orgId, '../not-a-uuid', hash)).toThrow(/INVALID_USER_ID/);
    expect(() => buildObjectPath(orgId, 'a/b', hash)).toThrow(/INVALID_USER_ID/);
  });

  it('ISO-19: rejects a malformed hash', () => {
    expect(() => buildObjectPath(orgId, userId, 'not-a-hash')).toThrow(/INVALID_HASH/);
    expect(() => buildObjectPath(orgId, userId, '../../etc/passwd')).toThrow(/INVALID_HASH/);
  });

  it('isPathInOrg accepts only canonical paths under the given firm', () => {
    const path = buildObjectPath(orgId, userId, hash);
    expect(isPathInOrg(path, orgId)).toBe(true);
    expect(isPathInOrg(path, otherOrg)).toBe(false);
    expect(isPathInOrg(`${userId}/${hash}.png`, orgId)).toBe(false); // legacy per-user path
    expect(isPathInOrg(`${orgId}/../${otherOrg}/${hash}.png`, orgId)).toBe(false);
    expect(isPathInOrg(`${orgId}/${userId}/x/${hash}.png`, orgId)).toBe(false);
    expect(isPathInOrg(null, orgId)).toBe(false);
  });

  it('isServableSessionPath allows this firm\'s paths and legacy per-user paths, never another firm\'s canonical path', () => {
    expect(isServableSessionPath(buildObjectPath(orgId, userId, hash), orgId)).toBe(true);
    expect(isServableSessionPath(`${userId}/${hash}.png`, orgId)).toBe(true);
    expect(isServableSessionPath(buildObjectPath(otherOrg, userId, hash), orgId)).toBe(false);
    expect(isServableSessionPath(`../${hash}.png`, orgId)).toBe(false);
    expect(isServableSessionPath(`${userId}/not-a-hash.png`, orgId)).toBe(false);
  });
});
