import type {Octokit} from '@octokit/rest';
import type {Project,Tree} from '../shared';
import {now,type Env} from './core';
import {gh,split,tokenFor} from './github';
import {dispatchFeedback} from './state';

type Author={id:number;login?:string;type:string};
type Note={id:number;body?:string|null;user?:Author|null};
type Source='issue_comment'|'pull_request_review_comment'|'pull_request_review';
type Change={source:Source;note:Note};
const failures=new Set(['failure','error','timed_out','action_required','startup_failure']);
export const failing=(conclusion:string|null)=>conclusion!==null&&failures.has(conclusion);

async function enqueue(env:Env,t:Tree,key:string,body:string){
 const id=t.id+'-'+key;
 await env.DB.prepare(`INSERT OR IGNORE INTO feedback (id,worktree_id,body,created)
 SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM turns WHERE id=?)`)
 .bind(id,t.id,body,now(),'feedback-'+id).run()
}
async function trusted(api:Octokit,p:Project,t:Tree,actor:Author){
 if(actor.type!=='User')return false;
 if(actor.id===t.user_id)return true;
 if(!actor.login)return false;
 try{
 const {data}=await api.rest.repos.getCollaboratorPermissionLevel({...split(p.name),username:actor.login});
 return data.user?.id===actor.id&&['admin','maintain','write'].includes(data.permission)
 }catch(e){if((e as {status?:number}).status===404)return false;throw e}
}

export async function recordNotes(env:Env,t:Tree,p:Project,api:Octokit,changes:Change[]){
 const authors=new Map<number,boolean>();
 for(const {source,note} of changes){
  const actor=note.user;
  if(!actor||!note.body?.trim()||actor.type!=='User'||note.body.includes('<!-- starling:'))continue;
  let allowed=authors.get(actor.id);
  if(allowed===undefined){allowed=await trusted(api,p,t,actor);authors.set(actor.id,allowed)}
  if(allowed)await enqueue(env,t,source+'-'+note.id,'GitHub feedback from '+(actor.login??actor.id)+':\n'+note.body.slice(0,12000))
 }
}

export async function recordFailure(env:Env,t:Tree,sha:string,names:string[]){
 if(!names.length)return;
 // A CI fix can produce another failing commit. Only a new human instruction
 // opens another automatic attempt, across both webhook delivery and catch-up.
 const anchor=await env.DB.prepare("SELECT rowid AS anchor FROM turns WHERE worktree_id=? AND kind='prompt' AND id NOT LIKE ? ORDER BY rowid DESC LIMIT 1").bind(t.id,'feedback-'+t.id+'-ci-%').first<number>('anchor');
 if(anchor)await enqueue(env,t,'ci-'+anchor,'GitHub reported failing checks for '+sha+': '+names.join(', ').slice(0,1500)+'. Inspect the failure, run the corresponding repository checks and update this pull request.')
}

export async function reconcileTree(env:Env,t:Tree,full=false){
 if(!t.pr)return;
 const p=(await env.DB.prepare('SELECT * FROM projects WHERE id=?').bind(t.project_id).first<Project>())!;
 const api=gh(await tokenFor(env,p,true),env),repo=split(p.name),q={...repo,pull_number:t.pr};
 const {data:r}=await api.rest.pulls.get(q);
 if(r.head.ref!==t.branch||r.head.repo?.id!==p.id)return;
 if(r.state==='closed'){
  await env.DB.prepare("UPDATE worktrees SET state='closed',revision=revision+1 WHERE id=? AND state='open'").bind(t.id).run();
  if(!r.merged||!t.branch.startsWith('starling/')||r.base.ref===t.branch)return;
  if(await env.DB.prepare("SELECT 1 FROM turns WHERE worktree_id=? AND status IN ('running','queued','saving')").bind(t.id).first())return;
  if((await env.DB.prepare("SELECT status FROM turns WHERE worktree_id=? ORDER BY rowid DESC LIMIT 1").bind(t.id).first<string>('status'))!=='done')return;
  try{const {data:ref}=await api.rest.git.getRef({...repo,ref:'heads/'+t.branch});if(ref.object.sha!==r.head.sha)return;await api.rest.git.deleteRef({...repo,ref:'heads/'+t.branch})}catch(e){if((e as {status:number}).status!==404&& (e as {status:number}).status!==422)throw e}
  if(await env.WORKTREES.getByName(t.id).cleanup())await env.DB.prepare('UPDATE worktrees SET reconciled=-1 WHERE id=?').bind(t.id).run();
  return
 }
 if(t.state==='closed'){await env.DB.prepare("UPDATE worktrees SET state='open',revision=revision+1 WHERE id=?").bind(t.id).run();t.state='open'}
 if(!full)return;
 // Overlap the last successful scan with webhook deliveries. Stable provider IDs
 // and the saved execution make redelivery and overlapping pages idempotent.
 const since=new Date(Math.max(t.created,(t.reconciled??0)-60)*1000).toISOString();
 const [comments,inline,reviews,checks,states]=await Promise.all([
 api.paginate(api.rest.issues.listComments,{...repo,issue_number:t.pr,since,per_page:100}),
 api.paginate(api.rest.pulls.listReviewComments,{...q,since,per_page:100}),
 api.paginate(api.rest.pulls.listReviews,{...q,per_page:100}),
 api.paginate(api.rest.checks.listForRef,{...repo,ref:r.head.sha,per_page:100}),
 api.rest.repos.getCombinedStatusForRef({...repo,ref:r.head.sha})
 ]);
 await recordNotes(env,t,p,api,[...comments.map(note=>({source:'issue_comment' as const,note})),...inline.map(note=>({source:'pull_request_review_comment' as const,note})),...reviews.filter(v=>(v.submitted_at??'')>=since).map(note=>({source:'pull_request_review' as const,note}))]);
 await recordFailure(env,t,r.head.sha,[...checks.filter(v=>failing(v.conclusion)).map(v=>v.name),...states.data.statuses.filter(v=>failing(v.state)).map(v=>v.context)]);
 await dispatchFeedback(env,t)
}
