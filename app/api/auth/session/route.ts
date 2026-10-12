import { AuthError } from "@pt-ai/bff-auth/core";
import { NextResponse } from "next/server";
import { getSessionActor } from "@/lib/server/auth/session";
import { AccessUnavailableError } from "@/lib/server/auth/access-client";
import { authFailure } from "@/lib/server/auth/route-response";
export async function GET(request:Request) {
  try {
    const actor=await getSessionActor(request);
    return NextResponse.json({authenticated:!!actor,contextId:actor?.contextId ?? null,ok:true,data:{authenticated:!!actor,contextId:actor?.contextId ?? null,...(actor || {})}},{headers:{"cache-control":"no-store"}});
  }catch(error){
    if(error instanceof AuthError && error.status===401)return NextResponse.json({authenticated:false,contextId:null,ok:true,data:{authenticated:false,contextId:null}},{headers:{"cache-control":"no-store"}});
    if(error instanceof AccessUnavailableError)return NextResponse.json({ok:false,error:{code:"ACCESS_UNAVAILABLE",message:"Access 暂时不可用",retryable:true}},{status:503,headers:{"cache-control":"no-store"}});
    return authFailure(error);
  }
}
