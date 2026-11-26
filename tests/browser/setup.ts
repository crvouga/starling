import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';

export default async function setup(){
 fs.mkdirSync('.wrangler',{recursive:true});
 const local=fs.mkdtempSync(resolve('.wrangler/browser-'));
 process.env.STARLING_LOCAL_DIR=local;
 const child=spawn(process.execPath,['scripts/localhost.mjs'],{stdio:'inherit'});
 const stopped=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
 const close=async()=>{
  if(child.exitCode===null)child.kill('SIGTERM');
  await stopped;
  fs.rmSync(local,{recursive:true,force:true})
 };
 try{
  for(let i=0;i<900;i++){
   if(child.exitCode!==null)throw Error('Localhost exited '+child.exitCode);
   try{
    const {port,instance}=JSON.parse(fs.readFileSync(local+'/owner.json','utf8'));
    if(instance){const r=await fetch('http://127.0.0.1:'+port+'/api/health',{signal:AbortSignal.timeout(600)});
    if(r.ok&&(await r.json() as {instance:string}).instance===instance)return close}
   }catch{}
   await new Promise(r=>setTimeout(r,500))
  }
  throw Error('Localhost startup timed out')
 }catch(e){await close();throw e}
}
