import { causeBrowserAuth, authRequest } from "@/lib/server/auth/browser-auth";
import { authRedirect, authFailure } from "@/lib/server/auth/route-response";
export async function POST(request:Request) {
  const form=Object.fromEntries([...await request.formData()].filter((entry):entry is [string,string]=>typeof entry[1]==="string"));
  try { return authRedirect(await causeBrowserAuth().switchAccount(authRequest(request,form))); }
  catch(error){return authFailure(error);}
}
