import { NextResponse } from "next/server";
import { AuthError, type AuthRedirect } from "@pt-ai/bff-auth/core";
export function authRedirect(result:AuthRedirect):NextResponse {
  const response=NextResponse.redirect(result.location,result.status);
  response.headers.set("cache-control","no-store");
  for(const cookie of result.setCookies)response.headers.append("set-cookie",cookie);
  return response;
}
export function authFailure(error:unknown):NextResponse {
  const e=error instanceof AuthError?error:new AuthError("auth_persistence_failed","persistence",503,true);
  return NextResponse.json({ok:false,error:{code:e.code,message:e.message,retryable:e.retryable}},{status:e.status,headers:{"cache-control":"no-store"}});
}
