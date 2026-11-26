import {expect,test,type Page} from '@playwright/test';
import fs from 'node:fs';
function settings(){return JSON.parse(fs.readFileSync((process.env.STARLING_LOCAL_DIR??'.wrangler/localhost')+'/owner.json','utf8')) as {port:number;origin:string}}
async function login(page:Page,who='developer'){await page.goto(settings().origin);await page.getByRole('button',{name:'Continue with GitHub'}).click();await page.getByRole('button',{name:new RegExp(who)}).click();await expect(page.getByText('@'+who,{exact:true})).toBeVisible()}
test('login, mobile navigation, appearance and permission boundaries',async({page,context})=>{
 await page.goto(settings().origin);await expect(page.getByRole('heading',{name:'Your workspace'})).toBeVisible();await page.screenshot({path:'docs/evidence/login.png'});
 await page.getByRole('button',{name:'Appearance'}).click();await expect(page.locator('html')).toHaveClass(/dark/);await page.getByRole('button',{name:'Appearance'}).click();
 await login(page,'ghost');await expect(page.getByText('Install Starling on GitHub')).toBeVisible();
 const denied=await context.request.post(settings().origin+'/api/worktrees',{headers:{origin:'https://elsewhere.example'},data:{}});expect(denied.status()).toBe(403);
 const unknown=await context.request.get(settings().origin+'/api/worktrees/other/pr');expect(unknown.status()).toBe(404);
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Repositories',exact:true}).click();await page.getByRole('button',{name:'Sign out'}).click();await expect(page.getByRole('heading',{name:'Your workspace'})).toBeVisible()
});
test('native Codex change, PR evidence, feedback, restoration and merge',async({page,context},info)=>{
 const {port,origin}=settings();await login(page);
 const change=[
  'printf "Observed on the shore.\\n" > observation.txt',
  'mkdir -p scripts',
  "printf '%s\\n' '#!/bin/sh' 'exec node preview.cjs' > scripts/preview",
  'chmod +x scripts/preview',
  `cat > preview.cjs <<'PREVIEW'\nrequire('node:http').createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<title>Field notes</title><h1>Shore observation</h1>')}).listen(4173,'127.0.0.1')\nPREVIEW`
 ].join('\n');
 const queued=await context.request.post('http://127.0.0.1:'+(port+2)+'/__fixture/model-script',{headers:{'x-mockingbird-admin-key':'fixture-openai-admin'},data:{kind:'chat',message:{role:'assistant',content:null,tool_calls:[{id:'call_note',type:'function',function:{name:'exec_command',arguments:JSON.stringify({cmd:change})}}]}}});expect(queued.ok()).toBeTruthy();
 await page.getByRole('button',{name:'New worktree in aviary/field-notes'}).click();let modal=page.getByRole('dialog');await modal.getByText('Codex',{exact:true}).click();const title='Record a shore observation '+Date.now().toString(36);await modal.getByRole('textbox',{name:'Desired change'}).fill(title);
 const created=page.waitForResponse(r=>r.url().endsWith('/api/worktrees')&&r.request().method()==='POST');await modal.getByRole('button',{name:'Create worktree'}).click();const {id,session}=await(await created).json();expect(id).toBeTruthy();const base=origin+'/api/worktrees/'+id,read=async(path:string)=>(await context.request.get(base+path)).json(),write=(path:string,data:unknown)=>context.request.post(base+path,{headers:{origin},data});
 await expect.poll(async()=>(await read('/sessions/'+session)).turn.status,{timeout:80000,intervals:[500,1800]}).toBe('done');let pr=await read('/pr');expect(pr.files.map((f:{name:string})=>f.name)).toContain('observation.txt');expect(pr.body).toContain('check: passed');
 const url=pr.body.match(/https?:\/\/[^)]+\/preview\.png/)?.[0];expect(url).toBeTruthy();
 const preview=await context.request.get(url!);expect(preview.status()).toBe(200);expect(preview.headers()['content-type']).toBe('image/png');expect((await preview.body()).subarray(1,4).toString()).toBe('PNG');
 expect((await page.request.get(url!,{headers:{cookie:''}})).status()).toBe(401);
 await page.getByRole('tab',{name:/Files/}).click();await page.getByRole('button',{name:/observation.txt/}).click();await expect(page.getByText('+Observed on the shore.',{exact:false}).last()).toBeVisible();await page.screenshot({path:'docs/evidence/workspace.png'});
 await page.getByRole('tab',{name:'Overview'}).click();await page.getByRole('textbox',{name:'PR comment'}).fill('Please summarize the observation.');await page.getByRole('button',{name:'Comment',exact:true}).click();
 await expect.poll(async()=>{const h=await read('/sessions/'+session);return h.turn.id.startsWith('feedback-')&&h.turn.status},{timeout:70000,intervals:[800,1800]}).toBe('done');
 const h=await read('/sessions/'+session);expect(h.events.some((e:{body:string})=>e.body.includes('Restoring worktree'))).toBeTruthy();await page.reload();await expect(page.getByText(title,{exact:true}).last()).toBeVisible();
 const run=await write('/sessions/'+session,{id:crypto.randomUUID(),text:'Run check',script:'check'});expect(run.ok()).toBeTruthy();await expect.poll(async()=>(await read('/sessions/'+session)).turn.status,{timeout:40000}).toBe('done');
 await page.getByRole('button',{name:'Mark ready for review'}).click();await expect(page.getByRole('button',{name:'Merge pull request'})).toBeEnabled();await page.getByRole('button',{name:'Merge pull request'}).click();await expect.poll(async()=>(await read('/pr')).state,{timeout:12000}).toBe('merged');await info.attach('closed-pr',{body:JSON.stringify(await read('/pr')),contentType:'application/json'})
});

test('Claude approval, continuation, cancellation and single worktree writer',async({page,context})=>{
 const {origin,port}=settings();
 await login(page);
 const post=(path:string,data:unknown)=>context.request.post(origin+'/api/'+path,{headers:{origin},data});
 const scriptTool=async(command:string)=>{
  const response=await context.request.post('http://127.0.0.1:'+(port+2)+'/__fixture/model-script',{headers:{'x-mockingbird-admin-key':'fixture-openai-admin'},data:{kind:'chat',message:{role:'assistant',content:null,tool_calls:[{id:'call_'+crypto.randomUUID(),type:'function',function:{name:'Bash',arguments:JSON.stringify({command,description:'Run the requested development check'})}}]}}});
  expect(response.ok()).toBe(true)
 };
 const command=(name:string)=>'node -e "require(\'fs\').writeFileSync(\''+name+'\', \'ok\')"';
 await scriptTool(command('approved.txt'));
 const result=await post('worktrees',{id:crypto.randomUUID(),project:1,provider:'claude',text:'Write a note after asking permission.'});
 expect(result.ok()).toBe(true);const {id,session}=await result.json(),path='worktrees/'+id,conversation=path+'/sessions/'+session;
 const history=async()=>(await context.request.get(origin+'/api/'+conversation)).json();
 async function permission(){
  let request;await expect.poll(async()=>{const h=await history();if(h.turn?.status==='failed')throw Error(h.turn.error);request=h.approval;return h.approval?.name},{timeout:38000,intervals:[400,750]}).toBe('Bash');
  return request as unknown as {turn:string;id:string}
 }
 const first=await permission(),another=crypto.randomUUID();
 expect((await post(path+'/sessions',{id:another,provider:'codex'})).ok()).toBe(true);
 expect((await post(path+'/sessions/'+another,{id:crypto.randomUUID(),text:'Run check',script:'check'})).status()).toBe(409);
 expect((await post(path+'/approval',{...first,allow:true})).ok()).toBe(true);
 await expect.poll(async()=>(await history()).turn.status,{timeout:40000}).toBe('done');
 const currentPr=async()=>(await context.request.get(origin+'/api/'+path+'/pr')).json();
 expect((await currentPr()).files.map((f:{name:string})=>f.name)).toContain('approved.txt');
 await scriptTool(command('declined.txt'));
 expect((await post(conversation,{id:crypto.randomUUID(),text:'Try a different note.'})).ok()).toBe(true);
 const second=await permission();expect(second.turn).not.toBe(first.turn);
 expect((await post(path+'/approval',{...second,allow:false})).ok()).toBe(true);
 await expect.poll(async()=>(await history()).turn.status,{timeout:40000}).toBe('done');
 expect((await currentPr()).files.map((f:{name:string})=>f.name)).not.toContain('declined.txt');
 await scriptTool(command('cancelled.txt'));expect((await post(conversation,{id:crypto.randomUUID(),text:'Start one more change.'})).ok()).toBe(true);
 const third=await permission();expect((await post(path+'/cancel',{id:third.turn})).ok()).toBe(true);
 await expect.poll(async()=>(await history()).turn.status,{timeout:40000}).toBe('cancelled');
 expect((await post(path+'/approval',{...third,allow:true})).status()).toBe(409)
});
