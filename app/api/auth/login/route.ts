import { causeBrowserAuth, authRequest } from "@/lib/server/auth/browser-auth";
import { authRedirect } from "@/lib/server/auth/route-response";
export async function GET(request:Request) {
  const core=causeBrowserAuth(),input=authRequest(request);
  try { return authRedirect(await core.begin(input)); }
  catch(error) { return authRedirect(core.failure(input,error)); }
}
