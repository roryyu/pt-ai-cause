import { it, expect, vi } from "vitest";
const base = { NODE_ENV: "test", AUTH_SECRET: "CauseIsolatedEnvironmentFixture123456", DATABASE_URL: "postgresql://fixture@localhost/test?schema=cause", MODEL_GATEWAY_BASE_URL: "http://localhost:28080/openai/v1", MODEL_GATEWAY_API_KEY: "isolated-fixture", MODEL_GATEWAY_DEFAULT_MODEL: "openai/gpt-5.6-sol" };
for (const [key, value] of Object.entries(base)) vi.stubEnv(key, value);
const { parseServerEnv } = await import("@/lib/env");
it("production must explicitly configure the shared identity, Access and model route", () => {
  const production = { ...base, NODE_ENV: "production", APP_ENV: "production", APP_URL: "https://cause.test", OIDC_ISSUER: "https://identity.test/realms/pt-ai", OIDC_CLIENT_SECRET: "isolated-oidc-fixture", ACCESS_INTERNAL_BASE_URL: "http://access.test", ACCESS_INTERNAL_SECRET: "isolated-access-fixture" };
  expect(parseServerEnv(production).MODEL_GATEWAY_DEFAULT_MODEL).toBe("openai/gpt-5.6-sol");
  for (const key of ["APP_URL", "OIDC_ISSUER", "OIDC_CLIENT_SECRET", "ACCESS_INTERNAL_BASE_URL", "ACCESS_INTERNAL_SECRET", "MODEL_GATEWAY_DEFAULT_MODEL"] as const) {
    const source: Record<string, string | undefined> = { ...production }; delete source[key];
    expect(() => parseServerEnv(source)).toThrow();
  }
  expect(() => parseServerEnv({ ...production, OIDC_ISSUER: "http://localhost:8094/realms/pt-ai" })).toThrow("HTTPS");
  expect(() => parseServerEnv({ ...production, OIDC_CLIENT_SECRET: "pt-ai-cause-oidc-local-only" })).toThrow();
});
it("enforce requires a restricted Identity status client; read cache is bounded", () => {
  expect(() => parseServerEnv({ ...base, SESSION_POLICY_V1_MODE: "enforce" })).toThrow("restricted");
  expect(parseServerEnv({ ...base, SESSION_POLICY_V1_MODE: "enforce", IDENTITY_SESSION_CLIENT_ID: "pt-ai-session-status-cause", IDENTITY_SESSION_CLIENT_SECRET: "isolated-status-fixture" }).SESSION_POLICY_V1_MODE).toBe("enforce");
  expect(() => parseServerEnv({ ...base, ACCESS_PRINCIPAL_CACHE_SECONDS: "61" })).toThrow();
});
