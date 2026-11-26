import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const origin=process.env.STARLING_ORIGIN??JSON.parse(readFileSync('wrangler.jsonc','utf8')).vars.ORIGIN;
const nonce=randomBytes(32).toString('hex');const manifest=JSON.parse(readFileSync('infra/github-app.json','utf8'));
const server=createServer(async(req,res)=>{const base='http://127.0.0.1:'+server.address().port,url=new URL(req.url,base);res.setHeader('cache-control','no-store');res.setHeader('referrer-policy','no-referrer');
 if(req.headers.host!==new URL(base).host){res.writeHead(403).end();return}
 if(url.pathname==='/'+nonce){const config={...manifest,name:'Starling '+new URL(origin).hostname.split('.')[1]+' '+nonce.slice(0,4),url:origin,redirect_url:base+'/callback',callback_urls:[origin+'/auth/callback'],hook_attributes:{url:origin+'/webhooks/github',active:true}};
 res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><title>Register Starling</title><form method="post" action="https://github.com/settings/apps/new?state='+nonce+'"><input type="hidden" name="manifest" value="'+JSON.stringify(config).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;')+'"><button>Register the Starling GitHub App</button></form>');return}
 if(url.pathname!=='/callback'||url.searchParams.get('state')!==nonce||!url.searchParams.get('code')){res.writeHead(404).end();return}
 try{const code=encodeURIComponent(url.searchParams.get('code')),r=await fetch('https://api.github.com/app-manifests/'+code+'/conversions',{method:'POST',headers:{'user-agent':'Starling provisioning',accept:'application/vnd.github+json'}});if(!r.ok)throw Error('GitHub conversion returned '+r.status);
 const a=await r.json(),secrets={GH_APP_ID:String(a.id),GH_SLUG:a.slug,GH_CLIENT_ID:a.client_id,GH_CLIENT_SECRET:a.client_secret,GH_PRIVATE_KEY:a.pem,GH_WEBHOOK_SECRET:a.webhook_secret};
 if(Object.values(secrets).some(x=>!x))throw Error('GitHub returned incomplete credentials');
 execFileSync('node_modules/.bin/wrangler',['secret','bulk'],{input:JSON.stringify(secrets),stdio:['pipe','inherit','inherit']});
 res.writeHead(302,{location:'https://github.com/apps/'+encodeURIComponent(a.slug)+'/installations/new'}).end();server.close();console.log('GitHub App stored in Worker Secrets. Select the repositories on GitHub.')}
 catch(e){res.writeHead(502).end('Registration failed. Check the operator console.');console.error(e.message)}
});
server.listen(0,'127.0.0.1',()=>console.log('Open on this machine: http://127.0.0.1:'+server.address().port+'/'+nonce));
