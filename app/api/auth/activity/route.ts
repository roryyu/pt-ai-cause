import { NextResponse } from "next/server";
import { requireBusinessSession } from "@/lib/server/auth/session";
import { authFailure } from "@/lib/server/auth/route-response";
export async function POST(request:Request) {
  try { await requireBusinessSession(request);return new NextResponse(null,{status:204,headers:{"cache-control":"no-store"}}); }
  catch(error){return authFailure(error);}
}
