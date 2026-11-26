import {DurableObject} from 'cloudflare:workers';
import {DirectoryBackup,Files,SandboxFileError,type DirectoryBackupRecord} from '@cloudflare/sandbox';
import {authorized,branchAndPull,client,gh,split,tokenFor} from './github';
import {now,type Env,type User} from './core';
import {decodeNative,nativeCommand,scrub} from './native';
import {scriptName,type Project,type Tree,type Turn,type Session,type Activity} from '../shared';
import type {Outbound} from './outbound';
export {DirectoryBackupGateway} from '@cloudflare/sandbox';
type Gateway=ConstructorParameters<typeof DirectoryBackup>[1];
const repoDir='/workspace/repo',ca='/etc/cloudflare/certs/cloudflare-containers-ca.crt';
const runtimeEnv={HOME:'/workspace/home',CODEX_HOME:'/workspace/home/.codex',CLAUDE_CONFIG_DIR:'/workspace/home/.claude',GIT_SSL_CAINFO:ca,SSL_CERT_FILE:ca,NODE_EXTRA_CA_CERTS:ca,NPM_CONFIG_CAFILE:ca,GIT_TERMINAL_PROMPT:'0',GIT_AUTHOR_NAME:'Starling',GIT_AUTHOR_EMAIL:'starling@users.noreply.github.com',GIT_COMMITTER_NAME:'Starling',GIT_COMMITTER_EMAIL:'starling@users.noreply.github.com',ANTHROPIC_BASE_URL:'https://model.starling.internal',ANTHROPIC_API_KEY:'sandbox-placeholder',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1'};
export class Workspace extends DurableObject<Env>{
 private listeners=new Set<ReadableStreamDefaultController<Uint8Array>>();
 notify(kind:'pr'|'state'|'activity'){const data=new TextEncoder().encode('data: '+kind+'\n\n');for(const sub of this.listeners){try{sub.enqueue(data)}catch{this.listeners.delete(sub)}}}
 subscribe(){
  let controller:ReadableStreamDefaultController<Uint8Array>,timer:ReturnType<typeof setTimeout>;
  const body=new ReadableStream<Uint8Array>({start:ctrl=>{controller=ctrl;this.listeners.add(ctrl);ctrl.enqueue(new TextEncoder().encode('retry: 2000\ndata: state\n\n'));timer=setTimeout(()=>{this.listeners.delete(ctrl);ctrl.close()},55000)},cancel:()=>{clearTimeout(timer);this.listeners.delete(controller)}});
  return new Response(body,{headers:{'content-type':'text/event-stream','cache-control':'no-store'}})
 }
 private running=false;
 private signal?:AbortController;
 private c(){if(!this.ctx.container)throw new Error('Missing container binding');return this.ctx.container}
 async wake(tree:string){await this.ctx.storage.put('tree',tree);if(await this.ctx.storage.getAlarm()===null)await this.ctx.storage.setAlarm(Date.now()+1)}
 async cancel(){this.signal?.abort();if(this.c().running){await (await this.c().exec(['pkill','-KILL','-u','node'])).output()}}
 private backup(tree:string){return new DirectoryBackup(this.c(),this.ctx.exports.DirectoryBackupGateway as Gateway,{binding:'PRIVATE',prefix:'backups/'+tree+'/'})}
 async alarm(){
  if(this.running)return;this.running=true;
  try{await this.execute()}finally{this.running=false;this.notify('state')}
 }
 private async execute(){
  const env=this.env,treeId=await this.ctx.storage.get<string>('tree');
  if(!treeId)return;
  const turn=await env.DB.prepare("SELECT * FROM turns WHERE worktree_id=? AND status IN ('queued','running','saving')").bind(treeId).first<Turn>();
  if(!turn)return;
  const t=(await env.DB.prepare('SELECT * FROM worktrees WHERE id=?').bind(treeId).first<Tree>())!;
  const s=(await env.DB.prepare('SELECT * FROM sessions WHERE id=?').bind(turn.session_id).first<Session>())!;
  const p=(await env.DB.prepare('SELECT * FROM projects WHERE id=?').bind(t.project_id).first<Project>())!;
  let failure:string|undefined,checkpoint=false,report='';
  const event=async(kind:Activity['kind'],value:string)=>{await env.DB.prepare('INSERT INTO events(session_id,turn_id,kind,body,created) VALUES(?,?,?,?,?)').bind(s.id,turn.id,kind,scrub(value),now()).run();this.notify('activity')};
  const old=await this.ctx.storage.get<DirectoryBackupRecord>('backup');
  const c=this.c(),files=new Files(c),backup=this.backup(t.id);
  if(turn.status==='saving'){await this.finishSave(t,turn,backup);return}
  try{
   if(turn.status==='running')throw new Error('Execution was interrupted. Inspect the last checkpoint before continuing.');
   if(t.state!=='open'||turn.cancel)throw new Error('Execution cancelled.');
   await env.DB.prepare("UPDATE turns SET status='running' WHERE id=? AND status='queued'").bind(turn.id).run();
   const user=(await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(t.user_id).first<User>())!,userApi=await client(env,user);
   await authorized(userApi,p,true);
   const api=gh(await tokenFor(env,p,true),env),repo=split(p.name);
   if(!t.pr){t.pr=await branchAndPull(api,p,t);await env.DB.prepare('UPDATE worktrees SET pr=?,revision=revision+1 WHERE id=?').bind(t.pr,t.id).run();this.notify('pr')}
   const {data:pr}=await api.rest.pulls.get({...repo,pull_number:t.pr});
   if(pr.state!=='open'||pr.head.ref!==t.branch||pr.head.repo?.id!==p.id)throw new Error('The pull request is closed or its head changed.');
   const gate=this.ctx.exports.Outbound({props:{tree:t.id,turn:turn.id,provider:s.provider}}) as Fetcher<Outbound>;
   const cold=!c.running;
   if(cold)c.start({image:c.images.agent,instance:'standard-1',enableInternet:false});
   await event('status',cold?'Starting isolated sandbox':'Preparing existing sandbox');
   for(const host of ['github.com','registry.npmjs.org','model.starling.internal'])await c.interceptOutboundHttps(host,gate);
   await c.setInactivityTimeout(25*60000);
   this.signal=new AbortController();
   const signal=AbortSignal.any([AbortSignal.timeout(15*60000),this.signal.signal]);
   const command=async(argv:string[],cwd=repoDir,handle?:(line:string)=>Promise<void>)=>{
    const started=Date.now(),proc=await c.exec(argv,{cwd,user:'1000:1000',env:runtimeEnv,stderr:'combined',signal});
    const reader=proc.stdout!.pipeThrough(new TextDecoderStream()).getReader();let buffer='',tail='',size=0;
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;
     if(size>8_000_000){proc.kill();throw new Error('Command output limit exceeded.')}
     tail=(tail+value).slice(-16000);if(handle){buffer+=value;const lines=buffer.split('\n');buffer=lines.pop()!;for(const l of lines)if(l)await handle(l)}
    }
    if(handle&&buffer)await handle(buffer);
    const code=await proc.exitCode;console.log(JSON.stringify({event:'command',worktree:t.id,program:argv[0],ms:Date.now()-started,exit:code}));
    if(code!==0)throw new Error(scrub(tail).slice(-1300)||'Command exited '+code);
    return tail.trim()
   };
   if(cold&&old){await event('status','Restoring worktree and native sessions');await files.remove('/workspace',{recursive:true,force:true});await backup.restore(old)}
   if(!old && !(await exists(files,repoDir+'/.git'))){
    await event('status','Cloning '+p.name);await command(['git','clone','--single-branch','--branch',t.branch,'--','https://github.com/'+p.name+'.git',repoDir],'/workspace');
   }
   checkpoint=true;
   await command(['mkdir','-p',runtimeEnv.CODEX_HOME,runtimeEnv.CLAUDE_CONFIG_DIR]);
   if(!old){await event('status','Running repository setup');const output=await command(['node','/usr/local/lib/starling-script.mjs','setup','--if-present']);if(output)await event('tool',output)}
   const branch=await command(['git','symbolic-ref','--short','HEAD']);if(branch!==t.branch)throw new Error('Unexpected checkout branch. Workspace preserved for recovery.');
   await command(['git','fetch','origin',t.branch]);await command(['git','merge','--ff-only','FETCH_HEAD']);
   if(turn.kind==='prompt'){
    let image:string|undefined;if(turn.image){const obj=await env.PRIVATE.get('inputs/'+t.user_id+'/'+turn.image);if(!obj)throw new Error('Attachment expired.');image='/tmp/starling-'+crypto.randomUUID()+'.'+(obj.httpMetadata?.contentType==='image/jpeg'?'jpg':'png');await files.writeFile(image,obj.body)}
    let count=0,failed=false;
    await command(nativeCommand(s.provider,s.native_id,s.id,turn.input,image),repoDir,async line=>{
     if(++count>4000)throw new Error('Native event limit reached.');
     const update=decodeNative(line);if(update.native && update.native!==s.native_id){s.native_id=update.native;await env.DB.prepare('UPDATE sessions SET native_id=? WHERE id=?').bind(s.native_id,s.id).run()}
     for(const u of update.updates){await event(u.kind,u.body);if(u.kind==='assistant')report=u.body}
     if(update.failed)failed=true
    });
    if(failed)throw new Error('Agent reported a failed turn.');
    const outcomes:string[]=[];let checkFailure=false;
    for(const name of ['check','test']){try{const output=await command(['node','/usr/local/lib/starling-script.mjs',name,'--if-present']);outcomes.push(name+': '+(output.startsWith('No '+name+' script')?'unavailable':'passed'));await event('tool',name+'\n'+output)}catch(e){checkFailure=true;outcomes.push(name+': failed');await event('tool',name+'\n'+String(e))}}
    await command(['git','add','--all','--','.']);
    if(await command(['git','status','--porcelain']))await command(['git','commit','-m',t.title]);
    await command(['git','push','origin','HEAD:refs/heads/'+t.branch]);
    const evidence=await publishEvidence(files,env,t,turn);
    const body=scrub(report||'Agent completed the requested change.').slice(0,9000)+'\n\n### Checks\n'+outcomes.join('\n')+(evidence.length?'\n\n### Evidence\n'+evidence.join('\n'):'');
    await api.rest.pulls.update({...repo,pull_number:t.pr,body});
    await api.rest.issues.createComment({...repo,issue_number:t.pr,body:body+'\n\n<!-- starling:'+turn.id+' -->'});
    if(checkFailure)throw new Error('Repository checks failed. Results were posted to the pull request.')
   }else{
    const name=scriptName.parse(turn.kind);await event('status','Running '+name);
    const output=await command(['timeout',name==='preview'?'60':'600','node','/usr/local/lib/starling-script.mjs',name]);await event('tool',output||name+' completed')
   }
  }catch(e){failure=scrub(e instanceof Error?e.message:'Execution failed').slice(-1600);await event('status',failure)}
  finally{this.signal=undefined}
  if(c.running){await (await c.exec(['pkill','-KILL','-u','node'])).output();if(checkpoint || turn.status==='running'){
    await this.ctx.storage.put('outcome',failure??'');await env.DB.prepare("UPDATE turns SET status='saving' WHERE id=?").bind(turn.id).run();await this.finishSave(t,turn,backup);return
   }await c.destroy()}
  await this.end(t,turn,failure)
 }
 private async finishSave(t:Tree,turn:Turn,backup:DirectoryBackup){
  const old=await this.ctx.storage.get<DirectoryBackupRecord>('backup');
  let failure=await this.ctx.storage.get<string>('outcome');
  if(this.c().running){
   try{const fresh=await backup.backup({dir:'/workspace'});await this.ctx.storage.put('backup',fresh);if(old)await backup.delete(old).catch(()=>{});await this.c().destroy()}
   catch{await this.env.DB.prepare("UPDATE turns SET error='Checkpoint failed. Retrying before shutdown.' WHERE id=?").bind(turn.id).run();await this.ctx.storage.setAlarm(Date.now()+30000);return}
  }else failure='Sandbox stopped during checkpoint. Only the last verified checkpoint and pushed commits are recoverable.';
  await this.end(t,turn,failure)
 }
 private async end(t:Tree,turn:Turn,failure?:string){
  await this.env.DB.batch([this.env.DB.prepare("UPDATE turns SET status=CASE WHEN cancel=1 THEN 'cancelled' ELSE ? END,error=?,ended=? WHERE id=?").bind(failure?'failed':'done',failure||null,now(),turn.id),this.env.DB.prepare('UPDATE worktrees SET revision=revision+1 WHERE id=?').bind(t.id)]);
 }
 async cleanup(){if(this.running)return false;const old=await this.ctx.storage.get<DirectoryBackupRecord>('backup'),id=await this.ctx.storage.get<string>('tree');if(old&&id)await this.backup(id).delete(old);if(this.c().running)await this.c().destroy();await this.ctx.storage.deleteAll();return true}
}
async function publishEvidence(files:Files,env:Env,t:Tree,turn:Turn){
 const dir=repoDir+'/.starling/evidence',links:string[]=[];
 if(!(await exists(files,dir)))return links;
 const list=await files.readDirectory(dir);
 for(const file of list.slice(0,6)){
  const name=file.name;if(!/^[\w.-]{1,100}\.(png|jpe?g|webm)$/i.test(name))continue;
  const entry=await files.lstat(dir+'/'+name);if(entry.type!=='file'||entry.size>12*1024*1024)continue;
  const key=t.id+'/'+turn.id+'/'+name,content=await files.readFile(dir+'/'+name);
  const type=name.endsWith('.webm')?'video/webm':name.endsWith('.png')?'image/png':'image/jpeg';
  await env.PRIVATE.put('evidence/'+key,content.body,{httpMetadata:{contentType:type}});links.push('['+name+']('+env.ORIGIN+'/api/evidence/'+key+')')
 }
 return links
}

async function exists(files:Files,path:string){try{await files.lstat(path);return true}catch(e){if(SandboxFileError.is(e)&&e.code==='ENOENT')return false;throw e}}
