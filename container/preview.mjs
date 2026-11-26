import { spawn } from 'node:child_process';
import { chromium } from '/opt/starling/node_modules/playwright-core/index.mjs';
import { existsSync, readFileSync, mkdirSync, lstatSync } from 'node:fs';

const script=existsSync('scripts/preview') || (existsSync('package.json') && JSON.parse(readFileSync('package.json','utf8')).scripts?.preview);
if(!script){
 console.log('No preview script in this repository.');
 process.exit(process.argv.includes('--if-present')?0:2)
}
const origin='http://127.0.0.1:4173', delay=ms=>new Promise(r=>setTimeout(r,ms));
const server=spawn(process.execPath,['/usr/local/lib/starling-script.mjs','preview'],{
 detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PORT:'4173',HOST:'127.0.0.1'}
});
let tail='',browser;
for(const pipe of [server.stdout,server.stderr])pipe.on('data',chunk=>{tail=(tail+chunk.toString()).slice(-1500)});
try{
 let ready=false;
 for(let i=0;i<80;i++){
  if(server.exitCode!==null)throw Error('Preview script exited: '+tail);
  try{const r=await fetch(origin,{signal:AbortSignal.timeout(400),redirect:'manual'});await r.body?.cancel();if(r.status<500){ready=true;break}}catch{}
  await delay(250)
 }
 if(!ready)throw Error('Preview script did not serve HTTP on '+origin+'. '+tail);
 const state='.starling/preview-state.json';
 browser=await chromium.launch();
 const context=await browser.newContext({viewport:{width:1280,height:800},serviceWorkers:'block',...(existsSync(state)?{storageState:state}:{})});
 await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 const page=await context.newPage();
 const response=await page.goto(origin,{timeout:15000,waitUntil:'load'});
 if(!response?.ok())throw Error('Preview returned HTTP '+response?.status());
 await page.evaluate(()=>document.fonts.ready);
 const dir='.starling/evidence';
 for(const path of ['.starling',dir]){
  if(!existsSync(path))mkdirSync(path);
  if(!lstatSync(path).isDirectory())throw Error('Preview output must be a directory');
 }
 await page.screenshot({path:dir+'/preview.png',animations:'disabled',timeout:10000});
 console.log('Captured application preview at 1280 × 800.');
}finally{
 try{process.kill(-server.pid,'SIGKILL')}catch{}
 await browser?.close()
}
