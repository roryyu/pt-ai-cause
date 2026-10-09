import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'node:http';

// Operator-created isolated fixtures only; never point this suite at a business environment.
test('Cause browser login, authorization, context fencing, switch and local logout', {skip:!process.env.CAUSE_BROWSER_FIXTURES, timeout:120000}, async()=>{
 const origin=process.env.CAUSE_BROWSER_ORIGIN || 'http://localhost:3100';
 const url=new URL(origin);assert.ok(['localhost','127.0.0.1'].includes(url.hostname));
 const fixtures=JSON.parse(await readFile(process.env.CAUSE_BROWSER_FIXTURES,'utf8'));
 const artifacts=process.env.CAUSE_BROWSER_ARTIFACTS || '/tmp/cause-browser-20261009';await mkdir(artifacts,{recursive:true});
 const modelRequests=[];
 let releaseFinal;
 const foundationFixture=createServer(async(req,res)=>{
  if(req.url==='/openai/v1/models'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'openai/gpt-5.6-sol'}]}));return;}
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw);modelRequests.push({url:req.url,body});
  if(req.url==='/openai/v1/chat/completions'){
   res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({route:'direct',reason:'isolated fixture'})}}]}));return;
  }
  if(req.url==='/openai/v1/responses' && body.stream===true){
   res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
   res.write('data: '+JSON.stringify({type:'response.output_text.delta',delta:'流式第一段'})+'\n\n');
   await new Promise(resolve=>{releaseFinal=resolve;res.once('close',resolve);});
   if(!res.destroyed){res.write('data: '+JSON.stringify({type:'response.output_text.delta',delta:'，第二段'})+'\n\n');res.end('data: '+JSON.stringify({type:'response.completed',response:{status:'completed'}})+'\n\n');}
   return;
  }
  res.writeHead(400);res.end();
 });
 await new Promise(resolve=>foundationFixture.listen(28080,'127.0.0.1',resolve));
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const context=await browser.newContext(); const page=await context.newPage();
 async function login(name) {
  await page.locator('input[name="username"]').fill(name);
  await page.locator('input[name="password"]').fill('CauseFixture123Test!');
  await page.locator('input[type="submit"],button[type="submit"]').first().click();
 }
 async function snapshot() { return page.evaluate(async()=> (await fetch('/api/auth/session')).json()); }
 async function business(method,ctx,originOverride) {
  return page.evaluate(async ({method,ctx,originOverride})=>{
   const r=await fetch('/api/auth/activity',{method,headers:{'x-pt-session-context':ctx,...(originOverride?{origin:originOverride}:{})}});
   return {status:r.status,body:await r.json().catch(()=>null)};
  },{method,ctx,originOverride});
 }
 try {
  await page.goto(origin+'/login');await page.waitForURL('**/realms/pt-ai/**');
  await page.waitForLoadState('networkidle');await page.screenshot({path:artifacts+'/identity-cause-login.png'});
  assert.match(await page.locator('body').innerText(),/Cause|归因/);
  await login(fixtures[0].name); await page.waitForURL(origin+'/');
  const initial=await snapshot();assert.equal(initial.authenticated,true);assert.ok(initial.contextId);
  await page.getByRole('button',{name:'用户菜单'}).waitFor();await page.waitForLoadState('networkidle');
  await page.screenshot({path:artifacts+'/cause-dashboard.png',fullPage:true});
  assert.equal((await business('POST','obsolete-context')).status,409);
  assert.equal((await business('POST',initial.contextId)).status,204);
  // Genuine HTTP deltas through the actual Cause route and hook, with final held back.
  await page.goto(origin+'/ask');
  await page.getByPlaceholder('输入您的业务问题...（Ctrl+Enter 发送）').fill('请做一个隔离流式验证');
  await page.getByRole('button',{name:'发送问题'}).click();
  await page.getByText('流式第一段',{exact:true}).waitFor();
  assert.equal(await page.getByText('流式第一段，第二段',{exact:true}).count(),0);
  await page.screenshot({path:artifacts+'/cause-native-first-delta.png'});
  assert.ok(releaseFinal);releaseFinal();
  await page.getByText('流式第一段，第二段',{exact:true}).waitFor();
  await page.getByRole('button',{name:'发送问题'}).waitFor();
  const native=modelRequests.find(r=>r.url==='/openai/v1/responses');
  assert.equal(native.body.model,'openai/gpt-5.6-sol');assert.deepEqual(native.body.reasoning,{effort:'low'});assert.equal(native.body.stream,true);
  assert.ok(modelRequests.filter(r=>r.url==='/openai/v1/chat/completions').every(r=>r.body.reasoning_effort==='low' && r.body.temperature===undefined));
  await page.screenshot({path:artifacts+'/cause-native-completed.png'});
  await page.goto(origin+'/');
  const anonymous=await browser.newContext();
  try {
   const denied=await anonymous.request.get(origin+'/api/v1/ask');assert.equal(denied.status(),401);
   const guestPage=await anonymous.newPage();const guestErrors=[];let loginRequests=0;
   guestPage.on('pageerror',error=>guestErrors.push(error.message));
   guestPage.on('request',request=>{if(new URL(request.url()).pathname==='/api/auth/login')loginRequests++;});
   await guestPage.goto(origin+'/');await guestPage.waitForURL('**/realms/pt-ai/**');
   assert.deepEqual(guestErrors,[]);assert.equal(loginRequests,1);
  }
  finally {await anonymous.close();}
  // Logout must revoke before navigation; an existing sibling page must lose authority.
  const sibling=await context.newPage(); await sibling.goto(origin+'/');
  // Real UI uses shared sessionFetch and announces logout to sibling tabs.
  await page.getByRole('button',{name:'用户菜单'}).click();
  const logoutResponse=page.waitForResponse(r=>r.url()===origin+'/api/auth/logout');
  await page.getByRole('button',{name:'退出登录',exact:true}).click();
  const lr=await logoutResponse;const logout={status:lr.status()};
  await page.waitForURL(origin+'/login?signedOut=1');
  assert.equal(logout.status,200);
  assert.equal((await snapshot()).authenticated,false);
  assert.equal((await context.request.get(origin+'/api/v1/ask',{headers:{'x-pt-session-context':'obsolete-context'}})).status(),401);
  await sibling.waitForURL(origin+'/login?authError=session_context_changed');
  await sibling.close();await page.goto(origin+'/login?signedOut=1');
  await page.screenshot({path:artifacts+'/cause-signed-out.png'});
  // Shared Identity SSO continues; switching explicitly selects a different person.
  await page.goto(origin+'/api/auth/login');await page.waitForURL(origin+'/');
  const resumed=await snapshot();assert.equal(resumed.authenticated,true);
  await page.getByRole('button',{name:'用户菜单'}).click();
  await page.locator('form[action="/api/auth/switch"] button').click();
  await page.waitForURL('**/realms/pt-ai/**');
  await login(fixtures[1].name);await page.waitForURL(origin+'/');
  const switched=await snapshot();assert.equal(switched.authenticated,true);assert.notEqual(switched.contextId,resumed.contextId);
  assert.equal((await business('POST',resumed.contextId)).status,409);
  assert.equal((await business('POST',switched.contextId)).status,204);
  const deniedContext=await browser.newContext();const deniedPage=await deniedContext.newPage();
  try {
   await deniedPage.goto(origin+'/login');await deniedPage.waitForURL('**/realms/pt-ai/**');
   await deniedPage.locator('input[name="username"]').fill(fixtures[2].name);
   await deniedPage.locator('input[name="password"]').fill('CauseFixture123Test!');
   await deniedPage.locator('input[type="submit"],button[type="submit"]').first().click();
   await deniedPage.waitForURL('**/login?**authError=entry_entitlement_required**');
   assert.equal(await deniedPage.evaluate(async()=> (await fetch('/api/auth/session')).json().then(x=>x.authenticated)),false);
   await deniedPage.screenshot({path:artifacts+'/cause-access-denied.png'});
  } finally {await deniedContext.close();}
  console.log('PASS real isolated Identity → Access → Cause, context fencing, local logout, SSO reuse, switch, unauthorized denial');
 } finally {releaseFinal?.();await context.close();await browser.close();await new Promise(resolve=>foundationFixture.close(resolve));}
});
