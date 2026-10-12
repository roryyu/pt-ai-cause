import { createSessionContextClient } from "@pt-ai/bff-auth/browser";
let client: ReturnType<typeof createSessionContextClient> | undefined;
export function sessionContext() {
  client ??= createSessionContextClient({appId:"cause",sessionPath:"/api/auth/session",onChanged:snapshot=>{
    if(typeof window!=="undefined" && !window.location.pathname.startsWith("/login")) {
      if(snapshot.authenticated) window.location.reload();
      else window.location.assign(new URL("/login?authError=session_context_changed", window.location.origin).href);
    }
  }});
  return client;
}
export function sessionFetch(input:RequestInfo|URL,init?:RequestInit) { return typeof window==="undefined"?fetch(input,init):sessionContext().fetch(input,init); }
