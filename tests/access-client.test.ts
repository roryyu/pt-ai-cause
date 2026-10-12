import {beforeEach,describe,it,expect,vi} from 'vitest';
vi.mock('@/lib/env',()=>({env:{ACCESS_INTERNAL_BASE_URL:'https://access.test',ACCESS_INTERNAL_SECRET:'isolated-fixture',ACCESS_ENTRY_ID:'cause',ACCESS_PRINCIPAL_CACHE_SECONDS:60}}));
import {activateSession,fetchPrincipal,invalidatePrincipal} from '@/lib/server/auth/access-client';
const principal={id:'u',subject:'subject',username:'user',usernameDisplay:'User',email:null,displayName:'User',status:'active',entitlements:['cause'],accessRoles:[]};
beforeEach(()=>{invalidatePrincipal('subject');vi.restoreAllMocks();});
describe('Cause Access boundary',()=>{
 it('passes the Cause entry and requires matching active principal',async()=>{
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({principal}));
  const caller=new AbortController();
  expect((await activateSession('subject',caller.signal)).subject).toBe('subject');
  const requestSignal=fetcher.mock.calls[0]?.[1]?.signal;
  expect(requestSignal).not.toBe(caller.signal);caller.abort();expect(requestSignal?.aborted).toBe(true);
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({subject:'subject',entryId:'cause'});
  expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  for(const bad of [{...principal,subject:'other'},{...principal,entitlements:[]},{...principal,status:'disabled'}]){
   fetcher.mockResolvedValueOnce(Response.json({principal:bad}));await expect(activateSession('subject')).rejects.toThrow();
  }
 });
 it('fresh writes bypass cache and expired or failed checks never use stale data',async()=>{
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({principal}));
  await fetchPrincipal('subject');await fetchPrincipal('subject');expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockResolvedValueOnce(Response.json({error:{code:'entry_entitlement_required'}},{status:403}));
  await expect(fetchPrincipal('subject',undefined,true)).rejects.toThrow();
  fetcher.mockRejectedValueOnce(new Error('network'));
  await expect(fetchPrincipal('subject')).rejects.toThrow();
 });
});
