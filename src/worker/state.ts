import {fail,now,type Env,type User} from './core';
import {authorized,client} from './github';
import type {Project,Tree,Session,Provider} from '../shared';
export async function context(env:Env,u:User,id:string,write=false,member=false){
 const t=await env.DB.prepare('SELECT * FROM worktrees WHERE id=?').bind(id).first<Tree>();
 if(!t||(!member&&t.user_id!==u.id))fail(404,'Worktree not found.');
 const p=(await env.DB.prepare('SELECT * FROM projects WHERE id=?').bind(t.project_id).first<Project>())!;
 const api=await client(env,u);await authorized(api,p,write);if(write&&t.state!=='open')fail(409,'Worktree closed.');return {t,p,api}
}
export async function connected(env:Env,uid:number,p:Provider){if(!await env.DB.prepare('SELECT 1 FROM accounts WHERE user_id=? AND provider=?').bind(uid,p).first())fail(409,'Connect your provider API key first.')}
export function turnStatements(env:Env,t:string,s:string,id:string,kind:string,input:string,image?:string){
 return [env.DB.prepare("INSERT INTO turns(id,worktree_id,session_id,kind,input,image,status,created) VALUES(?,?,?,?,?,?,'queued',?)").bind(id,t,s,kind,input,image??null,now()),
 env.DB.prepare("INSERT INTO events(session_id,turn_id,kind,body,created) VALUES(?,?,'user',?,?)").bind(s,id,input,now())]
}
export async function dispatchFeedback(env:Env,t:Tree){
 if(t.state!=='open')return;
 const f=await env.DB.prepare('SELECT * FROM feedback WHERE worktree_id=? ORDER BY created,id LIMIT 1').bind(t.id).first<{id:string;body:string}>();
 if(!f)return;const s=await env.DB.prepare('SELECT * FROM sessions WHERE worktree_id=? ORDER BY created DESC,rowid DESC LIMIT 1').bind(t.id).first<Session>();if(!s)return;
 try{await env.DB.batch([...turnStatements(env,t.id,s.id,'feedback-'+f.id,'prompt',f.body),env.DB.prepare('DELETE FROM feedback WHERE id=?').bind(f.id)]);await env.WORKTREES.getByName(t.id).wake(t.id)}catch(e){if(!/UNIQUE|quota/.test(String(e)))throw e}
}
