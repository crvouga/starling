import {spawn,execFileSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
import {readFileSync,writeFileSync,mkdirSync,realpathSync,existsSync,rmSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
process.chdir(resolve(dirname(fileURLToPath(import.meta.url)),'..'));
const root=realpathSync('.'),hash=createHash('sha256').update(root).digest('hex').slice(0,8);
const local=resolve('.wrangler/localhost');mkdirSync(local,{recursive:true,mode:0o700});
const run=(cmd,args,opts={})=>execFileSync(cmd,args,{stdio:'inherit',...opts});
async function available(port){const s=createServer();return new Promise(resolve=>{s.once('error',()=>resolve(false));s.listen(port,'127.0.0.1',()=>s.close(()=>resolve(true)))})}
const lock=local+'/owner.json',sleep=ms=>new Promise(r=>setTimeout(r,ms));
function owner(){try{return JSON.parse(readFileSync(lock,'utf8'))}catch{return null}}
function alive(pid){try{process.kill(pid,0);return true}catch{return false}}
for(let i=0;;i++){
 try{writeFileSync(lock,JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600});break}catch(e){if(e.code!=='EEXIST')throw e}
 const prev=owner();if(prev&&alive(prev.pid)){if(prev.origin){try{if((await (await fetch('http://127.0.0.1:'+prev.port+'/api/health',{signal:AbortSignal.timeout(1800)})).json()).service==='starling'){console.log('Starling already running at '+prev.origin);process.exit(0)}}catch{}}if(i>240)throw Error('Existing Localhost is still starting.');await sleep(500);continue}
 if(!prev&&i<4){await sleep(80);continue}rmSync(lock,{force:true})
}
process.on('exit',()=>{if(owner()?.pid===process.pid)rmSync(lock,{force:true})});
let child,mock;
try{
 const stamp=createHash('sha256').update(readFileSync('package-lock.json')).update(process.versions.modules).digest('hex'),stampFile='node_modules/.starling-install';
 if(!existsSync(stampFile)||readFileSync(stampFile,'utf8')!==stamp||!existsSync('node_modules/.bin/wrangler')){run('npm',['ci','--no-audit','--no-fund']);writeFileSync(stampFile,stamp)}
 if(process.env.HEROUI_AUTH_TOKEN)run(process.execPath,['node_modules/@heroui-pro/react/dist/postinstall/index.js']);
 run('docker',['info','--format','Docker {{.ServerVersion}}']);
 run('npm',['run','build']);run(process.execPath,['scripts/schema.mjs']);
 let port=Number(process.env.STARLING_PORT)||18000+(parseInt(hash,16)%10000)*3;
 for(let i=0;;i++){if(i>=300||port+2>65535)throw Error('Unable to allocate isolated ports');if((await Promise.all([port,port+1,port+2].map(available))).every(Boolean))break;if(process.env.STARLING_PORT)throw Error('Requested port block is occupied');port+=3}
 const origin='http://s-'+hash+'.localhost:'+port;
 const config=JSON.parse(readFileSync('wrangler.jsonc','utf8'));
 mock=await (await import('./mock-github.mjs')).startGithub({origin,port:port+2});
 const keyPath=local+'/key';if(!existsSync(keyPath))writeFileSync(keyPath,randomBytes(32).toString('base64url'),{mode:0o600});
 config.name='starling-local-'+hash;config.main=resolve(config.main);config.assets.directory=resolve(config.assets.directory);config.vars={ORIGIN:origin,...mock.vars,KEY:readFileSync(keyPath,'utf8')};
 for(const c of config.containers){for(const img of Object.values(c.images)){img.build_context=resolve(img.build_context??dirname(img.dockerfile));img.dockerfile=resolve(img.dockerfile)}}
 const path=local+'/wrangler.json';writeFileSync(path,JSON.stringify(config),{mode:0o600});writeFileSync(lock,JSON.stringify({pid:process.pid,origin,port}),{mode:0o600});
 console.log('Localhost uses Mockingbird GitHub. Open '+origin);
 child=spawn(resolve('node_modules/.bin/wrangler'),['dev','--config',path,'--local','--ip','127.0.0.1','--port',String(port),'--inspector-port',String(port+1),'--persist-to',local+'/state','--show-interactive-dev-session=false'],{stdio:'inherit',detached:process.platform!=='win32',env:{...process.env,WRANGLER_SEND_METRICS:'false',MINIFLARE_CONTAINER_EGRESS_IMAGE:'cloudflare/proxy-everything:ecf39de@sha256:cb0e17040faf711f98b56e0f993a5509abeb64c2aa2503db5c0b17e7afbb7b2f'}});
 const stop=()=>{try{process.kill(-child.pid,'SIGTERM')}catch{child.kill('SIGTERM')}};
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
 process.exitCode=await new Promise((resolve,reject)=>child.once('error',reject).once('exit',(code,signal)=>resolve(code??(signal==='SIGTERM'?0:1))));
}finally{mock?.close()}
