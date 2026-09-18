import { describe, expect, it } from 'vitest';
import { createAdminRouter, ADMIN_ROUTE_PATHS } from '../../src/api/admin';
import { requireAdmin } from '../../src/auth/adminMiddleware';

interface ExpressLayer {
  route?: { path: string; stack: Array<{ handle: unknown }> };
}

/**
 * ROLE-05: "Admin route reached without the admin middleware applied ->
 * caught by a route-coverage test asserting every /admin/* route is
 * wrapped." This inspects the actual Express router's middleware stack
 * rather than trusting that every handler remembered to call requireAdmin —
 * a route added later without it will fail this test immediately.
 */
describe('ROLE-05: admin route coverage', () => {
  it('every registered admin route has requireAdmin in its middleware stack', () => {
    const router = createAdminRouter();
    const layers = (router as unknown as { stack: ExpressLayer[] }).stack.filter((l) => l.route);

    expect(layers.length).toBeGreaterThan(0);
    expect(layers.length).toBe(ADMIN_ROUTE_PATHS.length);

    for (const layer of layers) {
      const handlers = layer.route!.stack.map((s) => s.handle);
      expect(handlers, `route ${layer.route!.path} must include requireAdmin`).toContain(requireAdmin);
    }
  });
});
