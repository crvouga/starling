import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {getCookie,deleteCookie} from 'hono/cookie';
import {bodyLimit} from 'hono/body-limit';
import {verify} from '@octokit/webhooks-methods';
import {z} from 'zod';
import {auth,identify,type App} from './auth';
import {client,gh,projects,split,pull,tokenFor} from './github';
import {connected,context,dispatchFeedback,turnStatements} from './state';
import {digest,fail,now,rows,seal,type Env,type User} from './core';
import {keySchema,provider,promptSchema,scriptName,type Activity,type Project,type Session,type Tree,type Turn} from '../shared';
export {Workspace,DirectoryBackupGateway} from './sandbox';
export {Outbound,ProviderProxy} from './outbound';
const app=new Hono<App>(),api=new Hono<App>();
app.use('*',async(c,next)=>{await next();c.header('X-Content-Type-Options','nosniff');c.header('Referrer-Policy','no-referrer');c.header('Cache-Control','no-store')});
app.route('/auth',auth);
app.get('/api/health',c=>c.json({service:'starling',githubConfigured:!!(c.env.GH_CLIENT_ID&&c.env.GH_PRIVATE_KEY&&c.env.GH_WEBHOOK_SECRET)}));
api.use('*',async(c,next)=>{if(!['GET','HEAD'].includes(c.req.method)&&c.req.header('origin')!==c.env.ORIGIN)fail(403,'Same-origin request required.');c.set('user',await identify(c.env,getCookie(c,'__Host-starling')));await next()});
api.use('*',bodyLimit({maxSize:2*1024*1024,onError:()=>fail(413,'Request is too large.')}));
api.get('/overview',async c=>{
 const u=c.get('user'),db=c.env.DB,ps=await projects(await client(c.env,u)),allowed=new Set(ps.map(p=>p.id));
 const trees=(await rows<Tree>(db,'SELECT * FROM worktrees WHERE user_id=? ORDER BY created DESC LIMIT 100',u.id)).filter(t=>allowed.has(t.project_id));
 const ids=new Set(trees.map(t=>t.id));const sessions=(await rows<Session>(db,'SELECT s.* FROM sessions s JOIN worktrees w ON w.id=s.worktree_id WHERE w.user_id=? ORDER BY s.created',u.id)).filter(s=>ids.has(s.worktree_id));
 const active=(await rows<Pick<Turn,'id'|'session_id'|'status'|'worktree_id'>>(db,"SELECT r.id,r.session_id,r.worktree_id,r.status FROM turns r JOIN worktrees w ON w.id=r.worktree_id WHERE w.user_id=? AND r.status IN ('queued','running','saving')",u.id)).filter(r=>ids.has(r.worktree_id));
 return c.json({user:{id:u.id,login:u.login},projects:ps,trees,sessions,active,accounts:(await rows<{provider:string}>(db,'SELECT provider FROM accounts WHERE user_id=?',u.id)).map(a=>a.provider),install:'https://github.com/apps/'+encodeURIComponent(c.env.GH_SLUG)+'/installations/new'})
});
api.post('/logout',async c=>{await c.env.DB.prepare('DELETE FROM logins WHERE id=?').bind(await digest(getCookie(c,'__Host-starling')!)).run();deleteCookie(c,'__Host-starling',{secure:true,path:'/'});return c.json({ok:true})});
api.put('/accounts/:p',async c=>{const p=provider.parse(c.req.param('p')),u=c.get('user'),{key}=z.object({key:keySchema}).parse(await c.req.json());
 // Only direct, provider-issued API keys are eligible.
 if(!(p==='claude'?key.startsWith('sk-ant-api'):key.startsWith('sk-')&&!key.startsWith('sk-ant-')))fail(400,'Use a provider-issued API key.');
 const r=await fetch(p==='claude'?'https://api.anthropic.com/v1/models?limit=1':'https://api.openai.com/v1/models',{headers:p==='claude'?{'x-api-key':key,'anthropic-version':'2023-06-01'}:{authorization:'Bearer '+key}});
 if(!r.ok)fail(400,'The provider could not verify the API key.');await r.body?.cancel();
 await c.env.DB.prepare('INSERT INTO accounts VALUES (?,?,?) ON CONFLICT(user_id,provider) DO UPDATE SET credential=excluded.credential').bind(u.id,p,await seal(c.env,u.id+':'+p,key)).run();await c.env.PROXIES.getByName(u.id+'-'+p).reset();return c.json({ok:true})
});
api.delete('/accounts/:p',async c=>{const p=provider.parse(c.req.param('p')),id=c.get('user').id;await c.env.DB.prepare('DELETE FROM accounts WHERE user_id=? AND provider=?').bind(id,p).run();await c.env.PROXIES.getByName(id+'-'+p).reset();return c.json({ok:true})});
api.post('/worktrees',async c=>{const b=promptSchema.extend({project:z.number().int(),provider}).parse(await c.req.json()),env=c.env,u=c.get('user');
 const prev=await env.DB.prepare('SELECT id,project_id FROM worktrees WHERE id=? AND user_id=?').bind(b.id,u.id).first<{id:string;project_id:number}>();if(prev){await context(env,u,prev.id);return c.json({id:prev.id})}
 const p=(await projects(await client(env,u))).find(p=>p.id===b.project);if(!p)fail(403,'Repository unavailable.');await connected(env,u.id,b.provider);
 const session=crypto.randomUUID(),title=b.text.split('\n')[0].slice(0,96),branch='starling/'+title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,32)+'-'+b.id.slice(0,8);
 await env.DB.batch([env.DB.prepare('INSERT INTO projects VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,installation=excluded.installation,base=excluded.base').bind(p.id,p.name,p.installation,p.base),env.DB.prepare('INSERT INTO worktrees(id,user_id,project_id,branch,base,title,created) VALUES(?,?,?,?,?,?,?)').bind(b.id,u.id,p.id,branch,p.base,title,now()),env.DB.prepare('INSERT INTO sessions VALUES(?,?,?,NULL,?)').bind(session,b.id,b.provider,now()),...turnStatements(env,b.id,session,b.id,'prompt',b.text,b.image)]);
 await env.WORKTREES.getByName(b.id).wake(b.id);return c.json({id:b.id,session},201)
});
api.post('/worktrees/:id/sessions',async c=>{const {t}=await context(c.env,c.get('user'),c.req.param('id'),true);const b=z.object({provider,id:z.uuid()}).parse(await c.req.json());await connected(c.env,t.user_id,b.provider);await c.env.DB.prepare('INSERT INTO sessions SELECT ?,?,?,NULL,? WHERE (SELECT count(*) FROM sessions WHERE worktree_id=?)<12 ON CONFLICT(id) DO NOTHING').bind(b.id,t.id,b.provider,now(),t.id).run();if(!await c.env.DB.prepare('SELECT 1 FROM sessions WHERE id=? AND worktree_id=?').bind(b.id,t.id).first())fail(429,'Session limit reached.');await c.env.WORKTREES.getByName(t.id).notify('state');return c.json({id:b.id})});
api.get('/worktrees/:id/stream',async c=>{const {t}=await context(c.env,c.get('user'),c.req.param('id'));return c.env.WORKTREES.getByName(t.id).subscribe()});
api.get('/worktrees/:id/pr',async c=>{const {t,p,api}=await context(c.env,c.get('user'),c.req.param('id'));if(!t.pr)return c.json(null);return c.json(await pull(api,p,t))});
api.post('/worktrees/:id/pr',async c=>{const {t,p,api}=await context(c.env,c.get('user'),c.req.param('id'),true);if(!t.pr)fail(409,'Waiting for draft PR.');const b=z.discriminatedUnion('action',[z.object({action:z.literal('comment'),body:z.string().trim().min(1).max(10000)}),z.object({action:z.enum(['merge','ready']),sha:z.string().regex(/^[\da-f]{40}$/)})]).parse(await c.req.json());
 const repo=split(p.name),{data:r}=await api.rest.pulls.get({...repo,pull_number:t.pr});if(r.state!=='open'||r.head.ref!==t.branch||r.head.repo?.id!==p.id)fail(409,'Pull request changed.');
 if(b.action==='comment')await api.rest.issues.createComment({...repo,issue_number:t.pr,body:b.body});else{if(b.sha!==r.head.sha)fail(409,'The head changed. Review the latest commit.');if(b.action==='ready')await api.graphql('mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id}}}',{id:r.node_id});else{if(r.draft || !r.mergeable || !['clean','has_hooks'].includes(r.mergeable_state??''))fail(409,'GitHub has not cleared this PR for merge.');await api.rest.pulls.merge({...repo,pull_number:t.pr,sha:b.sha})}}
 await c.env.WORKTREES.getByName(t.id).notify('pr');return c.json({ok:true})
});
api.get('/worktrees/:id/sessions/:s',async c=>{const {t}=await context(c.env,c.get('user'),c.req.param('id'));const s=await ownedSession(c.env,t,c.req.param('s'));const after=z.coerce.number().int().min(0).parse(c.req.query('after')??0);
 return c.json({events:await rows<Activity>(c.env.DB,'SELECT * FROM events WHERE session_id=? AND id>? ORDER BY id LIMIT 100',s.id,after),turn:await c.env.DB.prepare('SELECT id,status,error FROM turns WHERE session_id=? ORDER BY created DESC,rowid DESC LIMIT 1').bind(s.id).first()})
});
api.post('/worktrees/:id/sessions/:s',async c=>{const {t}=await context(c.env,c.get('user'),c.req.param('id'),true),s=await ownedSession(c.env,t,c.req.param('s')),b=promptSchema.extend({script:scriptName.optional()}).parse(await c.req.json());
 if(!b.script)await connected(c.env,t.user_id,s.provider);
 if(!await c.env.DB.prepare('SELECT id FROM turns WHERE id=? AND session_id=?').bind(b.id,s.id).first())await c.env.DB.batch(turnStatements(c.env,t.id,s.id,b.id,b.script??'prompt',b.script?'Run '+b.script:b.text,b.image));
 await c.env.WORKTREES.getByName(t.id).wake(t.id);return c.json({ok:true},202)
});
api.post('/worktrees/:id/cancel',async c=>{const {t}=await context(c.env,c.get('user'),c.req.param('id'),true),{id}=z.object({id:z.string().max(120)}).parse(await c.req.json());
 const r=await c.env.DB.prepare("UPDATE turns SET cancel=1 WHERE worktree_id=? AND id=? AND status IN ('queued','running')").bind(t.id,id).run();if(r.meta.changes)await c.env.WORKTREES.getByName(t.id).cancel();return c.json({ok:true})});
api.post('/images',async c=>{const data=new Uint8Array(await c.req.arrayBuffer()),png=[137,80,78,71,13,10,26,10].every((n,i)=>data[i]===n),jpeg=data[0]===255&&data[1]===216&&data[2]===255;
 if(!png&&!jpeg)fail(400,'Choose a PNG or JPEG image.');const id=crypto.randomUUID();await c.env.PRIVATE.put('inputs/'+c.get('user').id+'/'+id,data,{httpMetadata:{contentType:png?'image/png':'image/jpeg'}});return c.json({id})});
api.get('/evidence/:tree/:turn/:name',async c=>{const {t}=await context(c.env,c.get('user'),c.req.param('tree'),false,true);const obj=await c.env.PRIVATE.get('evidence/'+t.id+'/'+c.req.param('turn')+'/'+c.req.param('name'));if(!obj)fail(404,'Evidence not found.');return new Response(obj.body,{headers:{'content-type':obj.httpMetadata?.contentType??'application/octet-stream','content-security-policy':"default-src 'none'; sandbox",'cache-control':'private, no-store'}})});
async function ownedSession(env:Env,t:Tree,id:string){const s=await env.DB.prepare('SELECT * FROM sessions WHERE id=? AND worktree_id=?').bind(id,t.id).first<Session>();if(!s)fail(404,'Session not found.');return s}
app.route('/api',api);
app.post('/webhooks/github',bodyLimit({maxSize:1024*1024}),async c=>{
 const body=await c.req.text(),env=c.env,sig=c.req.header('x-hub-signature-256'),id=c.req.header('x-github-delivery');
 if(!env.GH_WEBHOOK_SECRET||!sig||!id||!await verify(env.GH_WEBHOOK_SECRET,body,sig))fail(403,'Invalid signature.');
 if(await env.DB.prepare('SELECT 1 FROM deliveries WHERE id=?').bind(id).first())return c.json({ok:true});
 const b=z.object({action:z.string().optional(),repository:z.object({id:z.number()}).optional(),sender:z.object({id:z.number(),type:z.string()}).optional(),issue:z.object({number:z.number()}).optional(),pull_request:z.object({number:z.number()}).optional(),comment:z.object({body:z.string(),id:z.number()}).optional(),review:z.object({body:z.string().nullable(),id:z.number()}).optional(),check_run:z.object({pull_requests:z.array(z.object({number:z.number()})),conclusion:z.string().nullable(),head_sha:z.string()}).optional(),ref:z.string().optional()}).parse(JSON.parse(body));
 const event=c.req.header('x-github-event'),number=b.pull_request?.number??b.issue?.number??b.check_run?.pull_requests[0]?.number;
 const t=await env.DB.prepare('SELECT * FROM worktrees WHERE project_id=? AND (pr=? OR branch=?)').bind(b.repository?.id??0,number??-1,b.ref?.replace(/^refs\/heads\//,'')??'').first<Tree>();
 const actions:D1PreparedStatement[]=[];
 if(t){const message=b.comment??b.review;
  if(message?.body&&b.sender?.id===t.user_id&&b.sender.type==='User'&&['created','submitted'].includes(b.action??'')&&!message.body.includes('<!-- starling:'))actions.push(env.DB.prepare('INSERT OR IGNORE INTO feedback VALUES(?,?,?,?)').bind(event+'-'+message.id,t.id,'GitHub feedback:\n'+message.body.slice(0,12000),now()));
  if(event==='pull_request'&&b.action==='closed')await reconcileClosed(env,t);
  actions.push(env.DB.prepare('UPDATE worktrees SET revision=revision+1 WHERE id=?').bind(t.id))
 }
 actions.push(env.DB.prepare('INSERT OR IGNORE INTO deliveries VALUES (?,?)').bind(id,now()));await env.DB.batch(actions);if(t){await env.WORKTREES.getByName(t.id).notify('pr');await dispatchFeedback(env,t)}return c.json({ok:true})
});
async function reconcileClosed(env:Env,t:Tree){
 if(!t.pr)return;
 const p=(await env.DB.prepare('SELECT * FROM projects WHERE id=?').bind(t.project_id).first<Project>())!,api=gh(await tokenFor(env,p,true)),repo=split(p.name);
 const {data:r}=await api.rest.pulls.get({...repo,pull_number:t.pr});if(r.state!=='closed')return;
 await env.DB.prepare("UPDATE worktrees SET state='closed',revision=revision+1 WHERE id=? AND state='open'").bind(t.id).run();
 if(!r.merged)return; // Closed unmerged branches keep their checkpoint.
 if(await env.DB.prepare("SELECT 1 FROM turns WHERE worktree_id=? AND status IN ('running','queued','saving')").bind(t.id).first())return;
 if((await env.DB.prepare("SELECT status FROM turns WHERE worktree_id=? ORDER BY created DESC,rowid DESC LIMIT 1").bind(t.id).first<{status:string}>())?.status!=='done')return;
 if(r.head.ref===t.branch&&r.head.repo?.id===p.id&&t.branch.startsWith('starling/')&&p.base!==t.branch){
  try{const {data:ref}=await api.rest.git.getRef({...repo,ref:'heads/'+t.branch});if(ref.object.sha!==r.head.sha)return;await api.rest.git.deleteRef({...repo,ref:'heads/'+t.branch})}catch(e){if(![404,422].includes((e as {status:number}).status))throw e}
  await env.WORKTREES.getByName(t.id).cleanup()
 }
}
app.onError((err,c)=>{if(err instanceof HTTPException)return c.json({error:err.message},err.status);if(err instanceof z.ZodError||err instanceof SyntaxError)return c.json({error:'Invalid request.'},400);
 const status=(err as {status?:number}).status;if(status&&[401,403,404,409,422,429].includes(status))return c.json({error:'GitHub declined the request ('+status+').'},status as 403);
 if(/quota|one_writer|UNIQUE constraint failed: turns.worktree_id/.test(String(err)))return c.json({error:'A worktree is busy or its execution quota was reached.'},409);
 console.error(JSON.stringify({event:'request_failed',path:new URL(c.req.url).pathname.split('/').slice(0,3).join('/'),type:err.name}));return c.json({error:'Starling could not finish the request.'},503)});
app.notFound(c=>c.json({error:'Not found.'},404));
export default {fetch:app.fetch,async scheduled(_controller:ScheduledController,env:Env){
 await env.DB.batch(['DELETE FROM logins WHERE expires<unixepoch()','DELETE FROM oauth_states WHERE expires<unixepoch()','DELETE FROM deliveries WHERE received<unixepoch()-604800'].map(sql=>env.DB.prepare(sql)));
 for(const r of await rows<{worktree_id:string}>(env.DB,"SELECT worktree_id FROM turns WHERE status IN ('queued','running','saving')"))await env.WORKTREES.getByName(r.worktree_id).wake(r.worktree_id);
 for(const t of await rows<Tree>(env.DB,"SELECT DISTINCT w.* FROM worktrees w JOIN feedback f ON f.worktree_id=w.id WHERE state='open' LIMIT 8"))await dispatchFeedback(env,t);
}} satisfies ExportedHandler<Env>;
