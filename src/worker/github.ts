import {createPrivateKey} from 'node:crypto';
import {Octokit} from '@octokit/rest';
import {createAppAuth} from '@octokit/auth-app';
import {refreshToken} from '@octokit/oauth-methods';
import {z} from 'zod';
import {fail,now,open,seal,type Env,type User} from './core';
import type {Project,Pull,Tree} from '../shared';
export function localGithub(env:Env){return env.LOCAL_GITHUB && /^http:\/\/[a-z0-9.-]*localhost:\d+$/.test(env.ORIGIN) && /^http:\/\/127\.0\.0\.1:\d+$/.test(env.LOCAL_GITHUB)?env.LOCAL_GITHUB:undefined}
export function gh(token:string,env?:Env){return new Octokit({...(env&&localGithub(env)?{baseUrl:localGithub(env)}:{}),auth:token,userAgent:'Starling',log:{debug(){},info(){},warn(){},error(){}}})}
const access=z.object({token:z.string(),refresh:z.string().optional()});
export async function client(env:Env,user:User){
  const stored=access.parse(JSON.parse(await open(env,'github:'+user.id,user.credential)));
  if(user.expires>now()+90)return gh(stored.token,env);
  if(!stored.refresh)fail(401,'Sign in again to refresh GitHub access.');
  const {authentication:a}=await refreshToken({clientType:'github-app',clientId:env.GH_CLIENT_ID,clientSecret:env.GH_CLIENT_SECRET,refreshToken:stored.refresh});
  const box=await seal(env,'github:'+user.id,JSON.stringify({token:a.token,refresh:a.refreshToken}));
  await env.DB.prepare('UPDATE users SET credential=?,expires=? WHERE id=? AND credential=?').bind(box,Math.floor(Date.parse(a.expiresAt)/1000),user.id,user.credential).run();
  return gh(a.token,env)
}
export function split(name:string){const [owner,repo]=name.split('/');return {owner,repo}}
export async function projects(api:Octokit):Promise<Project[]>{
  const installs=await api.paginate(api.rest.apps.listInstallationsForAuthenticatedUser,{per_page:100});
  const result:Project[]=[];
  for(const i of installs){
    if(i.suspended_at)continue;
    const repos=await api.paginate(api.rest.apps.listInstallationReposForAuthenticatedUser,{installation_id:i.id,per_page:100});
    for(const r of repos)if(!r.archived && !r.disabled)result.push({id:r.id,name:r.full_name,installation:i.id,base:r.default_branch})
  }
  return result.sort((a,b)=>a.name.localeCompare(b.name))
}
export async function authorized(api:Octokit,p:Project,write=false){
  const {data:r}=await api.rest.repos.get(split(p.name));
  if(r.id!==p.id || (write && (!r.permissions?.push || r.archived || r.disabled)))fail(403,'GitHub repository permission required.');
  // User-to-server tokens are restricted to the intersection of the installation and user grants.
  // Public repository metadata remains visible after uninstallation, so check the installation too.
  const allowed=await api.paginate(api.rest.apps.listInstallationReposForAuthenticatedUser,{installation_id:p.installation,per_page:100});
  if(!allowed.some(r=>r.id===p.id))fail(403,'The GitHub App no longer has access to this repository.')
}
export async function tokenFor(env:Env,p:Project,write=false){
  const auth=createAppAuth({request:new Octokit({baseUrl:localGithub(env)}).request,appId:env.GH_APP_ID,privateKey:createPrivateKey(env.GH_PRIVATE_KEY.replaceAll('\\n','\n')).export({format:'pem',type:'pkcs8'}).toString(),clientId:env.GH_CLIENT_ID,clientSecret:env.GH_CLIENT_SECRET});
  const a=await auth({type:'installation',installationId:p.installation,repositoryIds:[p.id],permissions:{contents:write?'write':'read',pull_requests:write?'write':'read',issues:write?'write':'read'}});return a.token
}
export async function branchAndPull(api:Octokit,p:Project,t:Tree){
  const repo=split(p.name);
  const list=()=>api.rest.pulls.list({...repo,head:repo.owner+':'+t.branch,base:t.base,state:'all',per_page:1});
  const existing=(await list()).data[0];if(existing){if(existing.state!=='open')fail(409,'The pull request has closed.');return existing.number}
  try{await api.rest.git.getRef({...repo,ref:'heads/'+t.branch})}catch(e){
    if((e as {status?:number}).status!==404)throw e;
    const {data:base}=await api.rest.repos.getCommit({...repo,ref:t.base});
    const {data:commit}=await api.rest.git.createCommit({...repo,message:'Start '+t.title,tree:base.commit.tree.sha,parents:[base.sha]});
    await api.rest.git.createRef({...repo,ref:'refs/heads/'+t.branch,sha:commit.sha});
  }
  const {data}=await api.rest.pulls.create({...repo,head:t.branch,base:t.base,title:t.title,body:'Work in progress. Implementation and check results will appear here.',draft:true});return data.number
}
export async function pull(api:Octokit,p:Project,t:Tree):Promise<Pull>{
  const repo=split(p.name),q={...repo,pull_number:t.pr!};
  const {data:r}=await api.rest.pulls.get(q);
  if(r.head.ref!==t.branch || r.head.repo?.id!==p.id)fail(409,'The PR head no longer matches this worktree.');
  const [comments,inline,files,commits,checks,reviews,status]=await Promise.all([api.paginate(api.rest.issues.listComments,{...repo,issue_number:r.number,per_page:100}),api.paginate(api.rest.pulls.listReviewComments,{...q,per_page:100}),api.paginate(api.rest.pulls.listFiles,{...q,per_page:100}),api.paginate(api.rest.pulls.listCommits,{...q,per_page:100}),api.paginate(api.rest.checks.listForRef,{...repo,ref:r.head.sha,per_page:100}),api.paginate(api.rest.pulls.listReviews,{...q,per_page:100}),api.rest.repos.getCombinedStatusForRef({...repo,ref:r.head.sha})]);
  return {number:r.number,title:r.title,body:r.body??'',url:r.html_url,head:r.head.sha,draft:r.draft??false,state:r.merged?'merged':r.state,mergeable:r.mergeable,review:r.mergeable_state??null,comments:[...comments,...inline].sort((a,b)=>a.created_at.localeCompare(b.created_at)).map(c=>({id:c.id,author:c.user?.login??'GitHub',body:c.body??'',url:c.html_url})),files:files.map(f=>({name:f.filename,add:f.additions,del:f.deletions,patch:f.patch?.slice(0,48000)})),commits:commits.map(c=>({sha:c.sha,message:c.commit.message})),checks:[...checks.map(c=>({name:c.name,state:c.conclusion??c.status,url:c.html_url??null})),...status.data.statuses.map(c=>({name:c.context,state:c.state,url:c.target_url??null}))],reviews:reviews.map(v=>({author:v.user?.login??'GitHub',state:v.state,body:v.body??''}))}
}
