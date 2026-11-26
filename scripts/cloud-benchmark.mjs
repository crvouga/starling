import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
const dir=mkdtempSync(resolve('.wrangler/benchmark-')),path=join(dir,'wrangler.json');
const prod=JSON.parse(readFileSync('wrangler.jsonc','utf8')),auth=randomBytes(32).toString('hex'),name='starling-probe-'+randomBytes(4).toString('hex'),COMMIT=execFileSync('git',['ls-remote','origin','refs/heads/build/starling'],{encoding:'utf8'}).split(/\s/)[0];
const cfg={name,main:resolve('tests/live/cloud.ts'),compatibility_date:prod.compatibility_date,compatibility_flags:prod.compatibility_flags,workers_dev:true,preview_urls:false,vars:{INSTANCE:"standard-1",COMMIT,TOKEN_HASH:createHash('sha256').update(auth).digest('hex')},r2_buckets:prod.r2_buckets,durable_objects:{bindings:[{name:'PROBE',class_name:'Probe'}]},migrations:[{tag:'v1',new_sqlite_classes:['Probe']}],containers:[{class_name:'Probe',scheduling_policy:'durable_object',images:{agent:{dockerfile:resolve('container/Dockerfile'),build_context:resolve('.')}}}]};writeFileSync(path,JSON.stringify(cfg));
const cli=resolve('node_modules/.bin/wrangler');const token=process.env.CLOUDFLARE_API_TOKEN;
if(!token)throw Error('CLOUDFLARE_API_TOKEN is required for probe deployment and cleanup');
async function cloud(path,method='GET'){
 const r=await fetch('https://api.cloudflare.com/client/v4'+path,{method,headers:{authorization:'Bearer '+token}});
 if(r.status===404&&method==='DELETE')return;
 if(!r.ok)throw Error('Cloudflare '+method+' '+path+' returned '+r.status);
 return (await r.json()).result
}
const account=process.env.CLOUDFLARE_ACCOUNT_ID??(await cloud('/accounts'))[0]?.id;
if(!account)throw Error('Set CLOUDFLARE_ACCOUNT_ID');
const env={...process.env,CLOUDFLARE_ACCOUNT_ID:account,CI:'true'};

try{const output=execFileSync(cli,['deploy','--config',path],{env,encoding:'utf8',maxBuffer:8*1024*1024});const url=output.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i)?.[0];if(!url)throw Error('Missing probe URL');
 const request=async(method)=>{const r=await fetch(url,{method,headers:{authorization:auth}});if(!r.ok)throw Error('Cloud probe returned '+r.status);return r.json()};
 let result;for(let i=0;i<18;i++){try{result=await request('POST');break}catch(e){if(i===17)throw e;await new Promise(r=>setTimeout(r,3000))}}
 for(let i=0;i<150&&!['failed','done'].includes(result.phase);i++){await new Promise(r=>setTimeout(r,4000));result=await request('GET')}
 writeFileSync('docs/evidence/cloud-benchmark.json',JSON.stringify({timestamp:new Date().toISOString(),...result},null,2)+'\n');console.log('Cloud benchmark:',result.phase,result.error??'');if(result.phase!=='done')process.exitCode=1
 }finally{
 // Wrangler's noninteractive Worker deletion leaves associated Container apps running.
 const applications=()=>JSON.parse(execFileSync(cli,['containers','list','--json'],{env,encoding:'utf8'})).filter(c=>c.name===name+'-probe');
 try{await cloud('/accounts/'+account+'/workers/scripts/'+name+'?force=true','DELETE')}
 finally{for(const c of applications())execFileSync(cli,['containers','delete',c.id],{env,stdio:'inherit'});}
 if(applications().length)throw Error('Probe container cleanup incomplete: '+name);
 rmSync(dir,{recursive:true,force:true})
}
