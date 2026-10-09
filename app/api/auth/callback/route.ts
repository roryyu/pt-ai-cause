import { causeBrowserAuth, authRequest } from "@/lib/server/auth/browser-auth";
import { authRedirect } from "@/lib/server/auth/route-response";
export async function GET(request:Request) {
  return authRedirect(await causeBrowserAuth().callback(authRequest(request)));
}
