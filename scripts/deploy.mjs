import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
const config=JSON.parse(readFileSync('wrangler.jsonc','utf8')),local='.wrangler/deploy';
mkdirSync(local,{recursive:true});
const wrangler=resolve('node_modules/.bin/wrangler');
function wr(args,input){return execFileSync(wrangler,args,{input,encoding:'utf8',stdio:[input?'pipe':'ignore','pipe','inherit']})}
const db=config.d1_databases[0],bucket=config.r2_buckets[0];
function database(){return JSON.parse(wr(['d1','list','--json'])).find(r=>r.name===db.database_name)}
if(!database())wr(['d1','create',db.database_name,'--location','wnam']);
db.database_id=database().uuid;
try{wr(['r2','bucket','info',bucket.bucket_name])}catch{wr(['r2','bucket','create',bucket.bucket_name,'--location','wnam'])}
wr(['r2','bucket','lifecycle','set',bucket.bucket_name,'--file','infra/storage.json','--force']);
config.main=resolve(config.main);config.assets.directory=resolve(config.assets.directory);
for(const c of config.containers)for(const i of Object.values(c.images)){i.build_context=resolve(i.build_context??dirname(i.dockerfile));i.dockerfile=resolve(i.dockerfile)}
if(process.env.STARLING_ORIGIN)config.vars.ORIGIN=new URL(process.env.STARLING_ORIGIN).origin;
const path=resolve(local,'wrangler.json');writeFileSync(path,JSON.stringify(config));
if(process.env.HEROUI_AUTH_TOKEN)execFileSync(process.execPath,['node_modules/@heroui-pro/react/dist/postinstall/index.js'],{stdio:'inherit'});
execFileSync('npm',['run','build'],{stdio:'inherit'});
execFileSync(process.execPath,['scripts/schema.mjs','--remote'],{env:{...process.env,STARLING_WRANGLER_CONFIG:path},stdio:'inherit'});
execFileSync(wrangler,['deploy','--config',path],{stdio:'inherit'});
const secrets=JSON.parse(wr(['secret','list','--config',path]));
if(!secrets.some(s=>s.name==='KEY'))wr(['secret','put','KEY','--config',path],randomBytes(32).toString('base64url'));
