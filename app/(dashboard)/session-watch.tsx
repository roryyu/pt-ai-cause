"use client";
import { useEffect } from "react";
import { createSessionActivityTracker, redirectToLoginOnce } from "@pt-ai/bff-auth/browser";
import { sessionContext } from "@/lib/session-context";
export function SessionWatch() {
  useEffect(()=>{
    const client=sessionContext();let redirecting=false;
    const probe=async()=>{
      if(redirecting || document.visibilityState!=="visible")return;
      const previouslyAuthenticated=client.current()?.authenticated;
      try { const s=await client.check();if(!s.authenticated){redirecting=true;if(!previouslyAuthenticated)redirectToLoginOnce({loginPath:"/api/auth/login",returnTo:location.pathname+location.search});} } catch { /* Keep the page; service failure is not account denial. */ }
    };
    void probe();
    const timer=window.setInterval(()=>void probe(),60000);
    document.addEventListener("visibilitychange",probe);
    const tracker=createSessionActivityTracker({onActivity:async()=>{await client.fetch("/api/auth/activity",{method:"POST"});}});
    return ()=>{window.clearInterval(timer);document.removeEventListener("visibilitychange",probe);tracker.dispose();};
  },[]);
  return null;
}
