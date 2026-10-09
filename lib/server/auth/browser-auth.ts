import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createBrowserAuthCore, AuthError, randomSecret, requireSessionContext, type AuthRequest } from "@pt-ai/bff-auth/core";
import { createSqlAuthStore, type SqlQuery } from "@pt-ai/bff-auth/sql-store";
import { createIdentitySessionChecker, loadSessionPolicyV1, sessionTerms, type VerifiedSessionPolicy } from "@pt-ai/bff-auth/session-policy";
import { prisma, type Prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { activateSession, fetchPrincipal, AccessDeniedError, AccessUnavailableError, type AccessPrincipal } from "./access-client";

export interface Actor { id: string; name: string; email: string; role: string; contextId: string }
type Prepared = { principal: AccessPrincipal; identity: { issuer: string; subject: string; authTime?: number; sessionPolicy?: VerifiedSessionPolicy } };
const policy = () => loadSessionPolicyV1(env, "", false);
const key = () => createHash("sha256").update(env.AUTH_SECRET).digest();
function protect(value: string): string {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(), iv);
  return Buffer.concat([iv, cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]).toString("base64url");
}
function unprotect(value: string): string {
  const bytes = Buffer.from(value, "base64url"), decipher = createDecipheriv("aes-256-gcm", key(), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8");
}

// Prisma remains the connection owner; shared SQL runs inside its transactions.
function queryFor(db: Prisma.TransactionClient): SqlQuery {
  return async (sql, parameters = []) => {
    if (/^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) return { rows: await db.$queryRawUnsafe(sql, ...parameters) as Awaited<ReturnType<SqlQuery>>["rows"] };
    await db.$executeRawUnsafe(sql, ...parameters); return { rows: [] };
  };
}
async function transaction<T>(operation: (q: SqlQuery) => Promise<T>, deadline = Date.now()+20000): Promise<T> {
  const timeout = Math.max(1,Math.min(20000,deadline-Date.now()));
  return prisma.$transaction(async db => {
    await db.$executeRawUnsafe("SET LOCAL search_path TO cause, public");
    await db.$queryRawUnsafe("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)",String(timeout));
    return operation(queryFor(db));
  },{maxWait:timeout,timeout});
}
const query: SqlQuery = (sql,parameters) => transaction(q=>q(sql,parameters));
type Session = { id:string; subject:string; name:string; email:string; role:string; sessionPolicyVersion:number; identitySession?:{issuer:string;sid:string;subject:string} };
export const causeAuthStore = createSqlAuthStore<Prepared,Session>({
  appId:"cause",query,transaction,protect,unprotect,
  session:{
    async subject(q,ref) { return (await q("SELECT subject FROM auth_sessions WHERE id=$1",[ref])).rows[0]?.subject ?? null; },
    async create(q,prepared) {
      const p=prepared.principal;
      if(p.subject!==prepared.identity.subject || p.status!=="active" || !p.entitlements.includes(env.ACCESS_ENTRY_ID)) throw new AuthError("entry_entitlement_required","access",403);
      if(p.email && (await q("SELECT id FROM users WHERE email=$1 AND id<>$2",[p.email,p.subject])).rows.length) throw new AuthError("identity_projection_conflict","principal",409);
      await q("INSERT INTO users(id,username,email,name,last_login_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT(id) DO UPDATE SET username=excluded.username,email=excluded.email,name=excluded.name,last_login_at=now()",[p.subject,p.username,p.email,p.displayName || p.usernameDisplay]);
      const mode=policy(), enforced=mode.mode==="enforce";
      const terms=enforced?sessionTerms(mode,prepared.identity):{expiresAt:new Date(Date.now()+mode.maxSeconds*1000),idleSeconds:mode.idleSeconds,persistenceMode:"session" as const};
      const ref=randomSecret();
      await q("INSERT INTO auth_sessions(id,subject,idle_seconds,expires_at,session_policy_version,persistence_mode,issuer,issuer_sid) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[ref,p.subject,terms.idleSeconds,terms.expiresAt,enforced?1:0,terms.persistenceMode,prepared.identity.issuer,prepared.identity.sessionPolicy?.issuerSessionId ?? null]);
      return {sessionRef:ref,expiresAt:terms.expiresAt,persistenceMode:terms.persistenceMode};
    },
    async revoke(q,ref) { await q("UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1",[ref]); },
    async resolve(q,ref) {
      const r=(await q("SELECT s.*,u.name,u.email,u.role FROM auth_sessions s JOIN users u ON u.id=s.subject WHERE s.id=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND s.last_seen_at+s.idle_seconds*interval '1 second'>now()",[ref])).rows[0];
      if(!r)return null;
      return {id:r.subject,subject:r.subject,name:r.name,email:r.email ?? "",role:r.role,sessionPolicyVersion:r.session_policy_version,...(r.session_policy_version===1?{identitySession:{issuer:r.issuer,sid:r.issuer_sid,subject:r.subject}}:{})};
    },
  },
});
let checker:ReturnType<typeof createIdentitySessionChecker>|undefined;
export function causeBrowserAuth() {
  return createBrowserAuthCore<Prepared,Session>({
    config:{appId:"cause",publicOrigin:env.APP_URL.replace(/\/$/,""),issuer:env.OIDC_ISSUER.replace(/\/$/,""),internalIssuer:env.OIDC_INTERNAL_ISSUER,clientId:env.OIDC_CLIENT_ID,clientAuthentication:{method:"client_secret_post",secret:env.OIDC_CLIENT_SECRET},callbackPath:"/api/auth/callback",fallbackReturnTo:"/",errorPath:"/login",sessionPolicy:policy()},
    store:causeAuthStore,
    application:{
      async prepareSession({identity,signal}) {
        try { return {identity,principal:await activateSession(identity.subject,signal)}; }
        catch(e) {
          if(e instanceof AccessDeniedError)throw new AuthError(e.code==="account_disabled"?"account_disabled":"entry_entitlement_required","access",403);
          if(e instanceof AccessUnavailableError)throw new AuthError("access_unavailable","access",503,true);
          throw e;
        }
      },
      async checkIdentitySession(input) {
        checker ??= createIdentitySessionChecker({issuer:env.OIDC_INTERNAL_ISSUER || env.OIDC_ISSUER,clientId:env.IDENTITY_SESSION_CLIENT_ID ?? "",clientSecret:env.IDENTITY_SESSION_CLIENT_SECRET ?? ""});
        const result=await checker(input);
        if(!result.active)await query("UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE issuer_sid=$1 AND subject=$2",[input.sid,input.subject]);
        return result;
      },
    },
  });
}
export function authRequest(request:Request,form?:Record<string,string>):AuthRequest {
  return {url:new URL(request.url),method:request.method,headers:request.headers,correlationId:request.headers.get("x-correlation-id") || crypto.randomUUID(),...(form?{form}:{})};
}
export async function getSessionActor(request:Request):Promise<Actor|null> {
  const session=await causeBrowserAuth().resolve(authRequest(request));
  if(!session)return null;
  try { await fetchPrincipal(session.subject,undefined,request.method!=="GET" && request.method!=="HEAD"); }
  catch(e) {
    if(e instanceof AccessDeniedError){await query("UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1",[session.sessionRef]);return null;}
    throw e;
  }
  return {id:session.id,name:session.name,email:session.email,role:session.role,contextId:session.contextId};
}
export async function requireBusinessSession(request:Request):Promise<Actor> {
  const actor=await getSessionActor(request);
  if(!actor)throw new AuthError("session.revoked","session",401);
  requireSessionContext(request.headers,actor.contextId);
  if(request.method!=="GET" && request.method!=="HEAD" && request.headers.get("origin")!==new URL(env.APP_URL).origin)throw new AuthError("auth_origin_invalid","access",403);
  if(request.method!=="GET" && request.method!=="HEAD") {
    // Reads include background progress polling. Only valid mutations and the
    // explicit, user-driven activity endpoint may advance the activity clocks.
    await causeBrowserAuth().touchIdentity(authRequest(request));
    await query("UPDATE auth_sessions SET last_seen_at=now() WHERE id=(SELECT app_session_ref FROM cause_auth_contexts WHERE context_id=$1) AND revoked_at IS NULL AND expires_at>now() AND last_seen_at+idle_seconds*interval '1 second'>now() AND last_seen_at<now()-interval '60 seconds'",[actor.contextId]);
  }
  return actor;
}
