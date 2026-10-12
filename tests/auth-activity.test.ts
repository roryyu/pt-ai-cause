import { beforeEach, it, expect, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  touch: vi.fn(), execute: vi.fn(), raw: vi.fn(), principal: vi.fn(),
  session: { id: "fixture-user", subject: "fixture-user", name: "Fixture", email: "", role: "viewer", contextId: "C".repeat(22) },
}));
vi.mock("@pt-ai/bff-auth/core", async original => ({
  ...await original<typeof import("@pt-ai/bff-auth/core")>(),
  createBrowserAuthCore: () => ({ resolve: async () => fixture.session, touchIdentity: fixture.touch }),
}));
vi.mock("@/lib/db", () => ({ prisma: { $transaction: async (operation: (db: unknown) => unknown) => operation({ $executeRawUnsafe: fixture.execute, $queryRawUnsafe: fixture.raw }) } }));
vi.mock("@/lib/env", () => ({ env: { APP_URL: "https://cause.test", AUTH_SECRET: "isolated-activity-secret-fixture-123456", OIDC_ISSUER: "https://identity.test/realms/pt-ai", OIDC_CLIENT_ID: "pt-ai-cause", OIDC_CLIENT_SECRET: "isolated-fixture", SESSION_POLICY_V1_MODE: "legacy" } }));
vi.mock("@/lib/server/auth/access-client", async original => ({ ...await original<typeof import("@/lib/server/auth/access-client")>(), fetchPrincipal: fixture.principal }));
import { requireBusinessSession } from "@/lib/server/auth/browser-auth";
beforeEach(() => { vi.clearAllMocks();fixture.raw.mockResolvedValue([]);fixture.execute.mockResolvedValue(1);fixture.touch.mockResolvedValue(undefined);fixture.principal.mockResolvedValue({}); });
it.each(["GET", "HEAD"])("background %s reads cannot advance either activity clock", async method => {
  const request = new Request("https://cause.test/api/v1/research", { method, headers: { "x-pt-session-context": fixture.session.contextId } });
  expect((await requireBusinessSession(request)).id).toBe("fixture-user");
  expect(fixture.execute).not.toHaveBeenCalled();expect(fixture.touch).not.toHaveBeenCalled();
});
it("validated activity checks Identity before updating the local clock", async () => {
  await requireBusinessSession(new Request("https://cause.test/api/auth/activity", { method: "POST", headers: { origin: "https://cause.test", "x-pt-session-context": fixture.session.contextId } }));
  expect(fixture.touch).toHaveBeenCalledOnce();
  expect(fixture.execute.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE auth_sessions SET last_seen_at"))).toBe(true);
  fixture.execute.mockClear();fixture.touch.mockRejectedValueOnce(new Error("Identity unavailable"));
  await expect(requireBusinessSession(new Request("https://cause.test/api/auth/activity", { method: "POST", headers: { origin: "https://cause.test", "x-pt-session-context": fixture.session.contextId } }))).rejects.toThrow("Identity unavailable");
  expect(fixture.execute).not.toHaveBeenCalled();
});
