import {createRuntime,prepareFixtures} from '@crvouga/mockingbird-service-github';
import {readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {fixtureRepo} from './fixture-repo.mjs';
import {createRuntime as createOpenAI} from '@crvouga/mockingbird-service-openai';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
// Only the localhost launcher imports this module. Missing installation endpoints
// are explicit fixtures around Mockingbird's actual OAuth, repository and PR APIs.
export async function startGithub({origin,port}){
 const git=fixtureRepo('.wrangler/localhost/git'),model=createOpenAI({seed:42});
 const baseUrl='http://127.0.0.1:'+port;
 const clientId='starling-fixture-client',clientSecret='starling-fixture-secret';
 const repo='field-notes',owner='aviary',permissions={contents:'write',pull_requests:'write',issues:'write',checks:'read'};
 const disk='.wrangler/localhost/mock-fixtures.json';const prepared=existsSync(disk)?JSON.parse(readFileSync(disk,'utf8')):await prepareFixtures({users:[{login:'developer',name:'Local developer'}],orgs:[{login:owner,members:[{login:'developer',role:'admin'}]}],repos:[{owner,name:repo,auto_init:true}],oauth_apps:[{client_id:clientId,client_secret:clientSecret,name:'Starling Localhost',redirect_uris:[origin+'/auth/callback']}],apps:[{app_id:42,name:'Starling Localhost',slug:'starling-local',permissions,installations:[{installation_id:17,account:owner,repository_selection:'selected',repositories:[owner+'/'+repo],permissions}]}]});
 const {fixtures,generatedPrivateKeys}=prepared;fixtures.repos[0].auto_init=true;fixtures.oauth_apps[0].redirect_uris=[origin+'/auth/callback'];writeFileSync(disk,JSON.stringify(prepared),{mode:0o600});
 const runtime=createRuntime({fixtures,seed:415,baseUrl});
 const statefile='.wrangler/localhost/mock-state.json';
 if(existsSync(statefile)){const doc=JSON.parse(readFileSync(statefile,'utf8'));const snap=runtime.snapshots.import(doc);runtime.snapshots.restore(snap.id)}
 function save(){const snap=runtime.snapshots.create({name:'localhost'});writeFileSync(statefile+'.tmp',JSON.stringify(runtime.snapshots.export(snap.id)),{mode:0o600});renameSync(statefile+'.tmp',statefile)}
 function syncGit(){const state=runtime.instance().state,lines=git.git('rev-list','--parents','--reverse','--all',git.head).split('\n');for(const line of lines){const [sha,...parents]=line.split(' ');if(!state.commit(owner,repo,sha))state.commits.insert(owner+'/'+repo+':'+sha,{sha,parents})}
 for(const line of git.git('for-each-ref','--format=%(refname) %(objectname)','refs/heads').split('\n')){const [ref,sha]=line.split(' ');const existing=state.reference(owner,repo,ref);if(existing?.object.sha!==sha)state.writeReference(owner,repo,ref,sha,!existing,true)}}
 syncGit();
 const server=createServer(async(req,res)=>{try{
  const url=new URL(req.url,baseUrl),request=new Request(url,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Readable.toWeb(req),duplex:'half'})});
  let response;
  if(url.pathname.startsWith('/v1/'))response=await model.fetch(request);
  else if(url.pathname.startsWith('/aviary/field-notes.git/')){response=await git.transport(request,url);if(url.pathname.endsWith('/git-receive-pack'))syncGit()}
  else if(url.pathname==='/repos/aviary/field-notes/git/commits'&&req.method==='POST')response=Response.json({sha:git.head},{status:201});
  else if(url.pathname==='/repos/aviary/field-notes/git/refs'&&req.method==='POST'){const payload=await request.clone().json();response=await runtime.fetch(request);if(response.ok)git.git('update-ref',payload.ref,payload.sha)}
  else if(/^\/repos\/aviary\/field-notes\/commits\/[a-f0-9]+\/status$/.test(url.pathname))response=Response.json({state:'pending',statuses:[],total_count:0});
  else if(url.pathname.startsWith('/user/installations')){
   const who=await runtime.fetch(new Request(baseUrl+'/user',{headers:request.headers}));
   if(!who.ok)response=who;else{const actor=await who.json();const allowed=actor.login==='developer';const info=await (await runtime.fetch(new Request(baseUrl+'/repos/'+owner+'/'+repo))).json();response=Response.json(url.pathname==='/user/installations'?{total_count:+allowed,installations:allowed?[{id:17,suspended_at:null}]:[]}:{total_count:+allowed,repositories:allowed?[info]:[]})}
  }else{response=await runtime.fetch(request);
   if(url.pathname==='/repos/'+owner+'/'+repo&&response.ok){const info=await response.json(),who=await runtime.fetch(new Request(baseUrl+'/user',{headers:request.headers}));response=Response.json({...info,permissions:{push:who.ok&&(await who.json()).login==='developer'}})}
  }
  if(req.method!=='GET'&&req.method!=='HEAD'&&response.status<400&&!url.pathname.startsWith('/v1/'))save();
  res.writeHead(response.status,Object.fromEntries(response.headers));if(response.body)Readable.fromWeb(response.body).pipe(res);else res.end();
 }catch{res.writeHead(500);res.end('Mockingbird request failed')}});
 await new Promise((resolve,reject)=>server.once('error',reject).listen(port,'127.0.0.1',resolve));
 return {close:()=>server.close(),vars:{LOCAL_GITHUB:baseUrl,GH_CLIENT_ID:clientId,GH_CLIENT_SECRET:clientSecret,GH_APP_ID:'42',GH_SLUG:'starling-local',GH_WEBHOOK_SECRET:'synthetic-local-webhook',GH_PRIVATE_KEY:generatedPrivateKeys[0].private_key}}
}
