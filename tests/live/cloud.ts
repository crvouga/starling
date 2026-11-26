import {DurableObject} from 'cloudflare:workers';
import {DirectoryBackup,Files} from '@cloudflare/sandbox';
export {DirectoryBackupGateway} from '@cloudflare/sandbox';
interface Bindings{PROBE:DurableObjectNamespace<Probe>;PRIVATE:R2Bucket;TOKEN_HASH:string;COMMIT:string;INSTANCE:"standard-1"}
export class Probe extends DurableObject<Bindings>{
 async begin(){if(!await this.ctx.storage.get('status')){await this.ctx.storage.put('status',{phase:'queued'});await this.ctx.storage.setAlarm(Date.now()+1)}}
 status(){return this.ctx.storage.get('status')}
 async alarm(){
  const c=this.ctx.container!,start=Date.now(),timings:Record<string,number>={},details:Record<string,string>={};
  const backup=new DirectoryBackup(c,(this.ctx.exports as unknown as {DirectoryBackupGateway:ConstructorParameters<typeof DirectoryBackup>[1]}).DirectoryBackupGateway,{binding:'PRIVATE',prefix:'benchmarks/'+this.ctx.id.toString()+'/'});
  let record:Awaited<ReturnType<typeof backup.backup>>|undefined;
  const run=async(name:string,argv:string[],cwd='/tmp')=>{await this.ctx.storage.put('status',{phase:name,timings});const t=Date.now();const r=await(await c.exec(argv,{cwd,user:'1000:1000',env:{HOME:'/workspace/home',CI:'true',NPM_CONFIG_FETCH_RETRIES:'1',NPM_CONFIG_FETCH_TIMEOUT:'25000'},signal:AbortSignal.timeout(180000)})).output();timings[name]=Date.now()-t;if(r.exitCode)throw Error(name+' failed ('+r.exitCode+'): '+new TextDecoder().decode(r.stderr).slice(-1600));return new TextDecoder().decode(r.stdout).trim()};
  try{
   c.start({image:c.images.agent,instance:this.env.INSTANCE,enableInternet:true});await c.setInactivityTimeout(300000);
   details.versions=await run('startup',['sh','-c','node --version && git --version && codex --version && claude --version']);
   await run('clone',['git','clone','--depth=1','--branch','build/starling','https://github.com/crvouga/starling.git','/workspace/repo']);
   details.commit=await run('revision',['git','rev-parse','HEAD'],'/workspace/repo');
   if(details.commit!==this.env.COMMIT)throw Error('Branch moved during benchmark');
   await run('install',['npm','ci','--no-audit','--no-fund','--maxsockets=12'],'/workspace/repo');
   details.tests=await run('test',['npm','test'],'/workspace/repo');
   await run('build',['npm','run','build'],'/workspace/repo');
   details.mockingbird=await run('mockingbird',['node','--input-type=module','-e',`import {createRuntime} from '@crvouga/mockingbird-service-github';const before=process.memoryUsage().rss;const r=createRuntime({seed:42});await r.fetch(new Request('http://fixture/repos/example/test'));console.log(JSON.stringify({rss:process.memoryUsage().rss,delta:process.memoryUsage().rss-before,resources:Object.keys(r.resources())}));`],'/workspace/repo');
   details.resources=await run('resources',['sh','-c','du -sb /workspace/repo; cat /sys/fs/cgroup/memory.peak /sys/fs/cgroup/cpu.stat; df -B1 /workspace']);
   await run('write',['sh','-c','mkdir -p /tmp/checkpoint && echo preserved > /tmp/checkpoint/note']);
   let t=Date.now();record=await backup.backup({dir:'/tmp/checkpoint'});timings.backup=Date.now()-t;
   await c.destroy();t=Date.now();c.start({image:c.images.agent,instance:this.env.INSTANCE,enableInternet:false});await c.setInactivityTimeout(120000);await backup.restore(record);details.recovered=await(await new Files(c).readFile('/tmp/checkpoint/note')).text();timings.coldRestore=Date.now()-t;
   await this.ctx.storage.put('status',{phase:'done',instance:this.env.INSTANCE,totalMs:Date.now()-start,timings,details,backupBytes:record.size})
  }catch(e){await this.ctx.storage.put('status',{phase:'failed',totalMs:Date.now()-start,timings,details,error:e instanceof Error?e.message:String(e)})}
  finally{if(record)await backup.delete(record).catch(()=>{});if(c.running)await c.destroy()}
 }
}
export default {async fetch(r:Request,e:Bindings){const supplied=r.headers.get('authorization')??'';const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(supplied))),n=>n.toString(16).padStart(2,'0')).join('');if(hash!==e.TOKEN_HASH)return new Response(null,{status:404});const p=e.PROBE.getByName('single-use');if(r.method==='POST')await p.begin();return Response.json(await p.status())}} satisfies ExportedHandler<Bindings>;
