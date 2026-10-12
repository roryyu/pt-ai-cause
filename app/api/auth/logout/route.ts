import { NextResponse } from "next/server";
import { causeBrowserAuth, authRequest } from "@/lib/server/auth/browser-auth";
import { authFailure } from "@/lib/server/auth/route-response";
export async function POST(request:Request) {
  const core=causeBrowserAuth(),input=authRequest(request);
  try {
    await core.logout(input);
    const response=NextResponse.json({ok:true,data:{logoutUrl:"/login?signedOut=1"}},{headers:{"cache-control":"no-store"}});
    for(const cookie of core.clearObservedProofCookies(input))response.headers.append("set-cookie",cookie);
    // Retire the previous cookie; it never authenticates the new core.
    response.cookies.set("pt_cause_session","",{httpOnly:true,path:"/",maxAge:0,sameSite:"lax"});
    return response;
  }catch(error){return authFailure(error);}
}
