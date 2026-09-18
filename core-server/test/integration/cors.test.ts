import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp } from '../helpers/buildTestApp';
import { parseCorsOrigins, DEFAULT_CORS_ORIGINS } from '../../src/lib/cors';

describe('CORS', () => {
  it('answers a preflight from the Capacitor WebView origin without requiring auth', async () => {
    const { app } = buildTestApp();
    const res = await request(app)
      .options('/api/v1/messages/draft')
      .set('Origin', 'https://localhost')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type,x-org-id');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://localhost');
    const allowedHeaders = res.headers['access-control-allow-headers'].split(',').map((h: string) => h.trim().toLowerCase());
    expect(allowedHeaders).toEqual(expect.arrayContaining(['authorization', 'content-type', 'x-org-id']));
  });

  it('allows the methods the org-management routes use (PATCH, DELETE)', async () => {
    const { app } = buildTestApp();
    const res = await request(app)
      .options('/api/v1/orgs/aaaaaaaa-0000-4000-8000-00000000000a/members/u1')
      .set('Origin', 'https://localhost')
      .set('Access-Control-Request-Method', 'PATCH');

    expect(res.status).toBe(204);
    const methods = res.headers['access-control-allow-methods'].split(',').map((m: string) => m.trim());
    expect(methods).toEqual(expect.arrayContaining(['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']));
  });

  it('adds the allow-origin header to actual responses, which still require auth', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/api/v1/messages/draft').set('Origin', 'https://localhost').send({ prompt: 'hi' });

    expect(res.status).toBe(401);
    expect(res.headers['access-control-allow-origin']).toBe('https://localhost');
  });

  it('does not allow other origins', async () => {
    const { app } = buildTestApp();
    const preflight = await request(app)
      .options('/api/v1/messages/draft')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    const actual = await request(app).get('/api/v1/health').set('Origin', 'https://evil.example');

    expect(preflight.status).toBe(403);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    expect(actual.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('parses CORS_ALLOWED_ORIGINS, falling back to the defaults', () => {
    expect(parseCorsOrigins(undefined)).toEqual(DEFAULT_CORS_ORIGINS);
    expect(parseCorsOrigins(' https://a.example , https://b.example ')).toEqual(['https://a.example', 'https://b.example']);
  });
});
