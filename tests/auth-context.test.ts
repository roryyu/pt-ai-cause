import {it,expect} from 'vitest';
import {requireAuthMutation,requireSessionContext} from '@pt-ai/bff-auth/core';
it('auth mutations and old business pages cannot act on a new context',()=>{
 const request={url:new URL('https://cause.test/api/auth/logout'),method:'POST',headers:new Headers({'origin':'https://other.test','x-pt-session-context':'none'}),correlationId:'test'};
 expect(()=>requireAuthMutation(request,'https://cause.test')).toThrow();
 request.headers.set('origin','https://cause.test');expect(requireAuthMutation(request,'https://cause.test')).toBeNull();
 expect(()=>requireSessionContext(new Headers({'x-pt-session-context':'old'}),'new')).toThrow();
});
