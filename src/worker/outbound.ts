import {DurableObject,WorkerEntrypoint} from 'cloudflare:workers';
import {safePush} from './native';
import {open,random,type Env} from './core';
import type {Project,Provider,Tree} from '../shared';
import {tokenFor,localGithub} from './github';
type Grant={tree:string;turn:string;provider:Provider};
const deny=()=>new Response('Access denied',{status:403});
export class Outbound extends WorkerEntrypoint<Env,Grant>{
 async fetch(request:Request){
  const url=new URL(request.url),g=this.ctx.props;
  const t=await this.env.DB.prepare("SELECT w.* FROM worktrees w JOIN turns r ON r.worktree_id=w.id WHERE w.id=? AND r.id=? AND r.status='running' AND r.cancel=0 AND w.state='open' AND r.created>unixepoch()-1800").bind(g.tree,g.turn).first<Tree>();
  if(!t || url.protocol!=='https:' || url.port)return deny();
  if(url.hostname==='model.starling.internal'){
    const path=g.provider==='claude'?'/v1/messages':'/v1/responses';
    if(request.method!=='POST'||url.pathname!==path)return deny();
    const quota=await this.env.DB.prepare("UPDATE turns SET model_requests=model_requests+1 WHERE id=? AND status='running' AND cancel=0 AND model_requests<64").bind(g.turn).run();
    if(!quota.meta.changes)return new Response('Model request limit reached',{status:429});
    const payload=await limited(request,2*1024*1024);if(!payload)return new Response('Model request too large',{status:413});
    return this.env.PROXIES.getByName(t.user_id+'-'+g.provider).forward(t.user_id,g.provider,new Request('http://proxy'+path,{method:'POST',body:payload.buffer as ArrayBuffer,headers:{'content-type':'application/json','anthropic-version':'2023-06-01'}}))
  }
  if(url.hostname==='registry.npmjs.org' && ['GET','HEAD'].includes(request.method))return fetch(url,{method:request.method,redirect:'manual'});
  const p=await this.env.DB.prepare('SELECT * FROM projects WHERE id=?').bind(t.project_id).first<Project>();
  if(!p || url.hostname!=='github.com')return deny();
  const prefix='/'+p.name+'.git/',path=url.pathname.slice(prefix.length);
  if(!url.pathname.startsWith(prefix))return deny();
  const service=url.searchParams.get('service');
  const read=(path==='info/refs' && service==='git-upload-pack' && request.method==='GET')||(path==='git-upload-pack' && request.method==='POST'&&!url.search);
  const advertise=path==='info/refs' && service==='git-receive-pack' && request.method==='GET';
  const push=path==='git-receive-pack' && !url.search && request.method==='POST';
  if(!read&&!advertise&&!push)return deny();
  let body:BodyInit|null=request.body;
  if(push){const packet=await limited(request,16*1024*1024);if(!packet||!safePush(packet,t.branch))return deny();body=packet.buffer as ArrayBuffer}
  const token=await tokenFor(this.env,p,!read),headers=new Headers({authorization:'Basic '+btoa('x-access-token:'+token),'user-agent':'Starling'});
  if(request.method==='POST')headers.set('content-type','application/x-'+path+'-request');
  return fetch(localGithub(this.env)?localGithub(this.env)+url.pathname+url.search:url,{method:request.method,headers,body,redirect:'manual'})
 }
}
export async function limited(request:Request,limit:number){const reader=request.body?.getReader();if(!reader)return null;const chunks:Uint8Array[]=[];let length=0;while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>limit){await reader.cancel();return null}chunks.push(value)}const out=new Uint8Array(length);let offset=0;for(const chunk of chunks){out.set(chunk,offset);offset+=chunk.length}return out}
export class FixtureModel extends WorkerEntrypoint<Env>{
 async fetch(request:Request){const local=localGithub(this.env),path=new URL(request.url).pathname;if(!local||request.method!=='POST'||path!=='/v1/chat/completions')return deny();return fetch(local+path,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer fixture-openai-token'},body:request.body})}
}
export class ProviderProxy extends DurableObject<Env>{
 private config?:Promise<string>;private credential?:string;
 async reset(){this.config=undefined;this.credential=undefined;if(this.ctx.container?.running)await this.ctx.container.destroy()}
 async forward(user:number,provider:Provider,request:Request){
  const record=await this.env.DB.prepare('SELECT credential FROM accounts WHERE user_id=? AND provider=?').bind(user,provider).first<{credential:string}>();
  if(!record)return deny();const c=this.ctx.container!;
  if(!c.running || this.credential!==record.credential || !this.config){
   if(this.credential!==record.credential && this.config)await this.reset();
   this.credential=record.credential;
   this.config=this.start(c,user,provider,record.credential);
  }
  let key:string;try{key=await this.config}catch{await this.reset();return new Response('Provider proxy unavailable',{status:503})}
  await c.setInactivityTimeout(90000);
  const headers=new Headers(request.headers);headers.set('authorization','Bearer '+key);headers.set('x-api-key',key);
  return c.getTcpPort(8317).fetch(new Request(request,{headers}))
 }
 private async start(c:Container,user:number,provider:Provider,box:string){
  const upstream=await open(this.env,user+':'+provider,box),key=random();
  const config:Record<string,unknown>={'config-version':8,server:{host:'0.0.0.0',port:8317,'kv-store':{disabled:true}},management:{'disable-control-panel':true},access:{'api-keys':[key]},oauth:{'auth-dir':'/tmp/auth'},'api-keys':{[provider]:[{name:'owner',...(provider==='codex'?{'base-url':'https://api.openai.com/v1'}:{}),keys:[{'api-key':upstream}]}]}};
  const fixture=!!localGithub(this.env)&&upstream==='fixture-openai-token';
  if(fixture){config['api-keys']={'openai-compatibility':[{name:'Mockingbird','base-url':'http://fixture.starling.internal/v1',keys:[{'api-key':upstream}],models:[{name:'fixture-chat',alias:'gpt-5.4'},{name:'fixture-chat',alias:'claude-sonnet-4-6'}]}]}}
  if(!c.running)c.start({image:c.images.proxy,instance:'lite',enableInternet:!fixture});
  if(fixture)await c.interceptOutboundHttp('fixture.starling.internal',this.ctx.exports.FixtureModel);
  await c.setInactivityTimeout(90000);
  const proc=await c.exec(['sh','-c','umask 077; cat > /tmp/config.yaml && exec /usr/local/bin/proxy -config /tmp/config.yaml -local-model'],{stdin:new Response(JSON.stringify(config)).body!,stdout:'ignore',stderr:'ignore'});
  for(let i=0;i<35;i++){try{const r=await c.getTcpPort(8317).fetch('http://proxy/v1/models',{headers:{authorization:'Bearer '+key}});if(r.ok)return key}catch{}await new Promise(resolve=>setTimeout(resolve,200))}
  proc.kill();throw new Error('CLIProxyAPI failed to start')
 }
}
