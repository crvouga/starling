import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync,renameSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const version='3.11.30', platform=process.platform+'-'+process.arch;
const checksums={'linux-x64':'a9666e444df101ce438bb8e263db5c7528371305b0f5ecd2fbb3985bde35d73d','linux-arm64':'7ec377819554a7eb9093f1aa8ed45a2a4100b5ac09a8e6c63b0f53b2eaa39554','darwin-x64':'3ed3f034a5edcf82badd34df33b7fdb14ac89d47169ed74a7049a28c36bc9777','darwin-arm64':'8352518a5b4925d80bd2dfac9b569145aa6d08c24058b660a219210e3839bd32'};
const dir=mkdtempSync(join(tmpdir(),'starling-schema-'));
const bin=resolve('.wrangler/tools/'+version+'/sqlite3def');
try{
 if(!existsSync(bin)){
  if(!checksums[platform])throw Error('Unsupported sqlite3def platform '+platform);
  const archive=process.platform==='darwin'?'sqlite.zip':'sqlite.tar.gz';
  const asset='sqlite3def_'+process.platform+'_'+(process.arch==='x64'?'amd64':'arm64')+(process.platform==='darwin'?'.zip':'.tar.gz');
  const res=await fetch('https://github.com/sqldef/sqldef/releases/download/v'+version+'/'+asset);
  if(!res.ok)throw Error('sqlite3def download returned '+res.status);
  const bytes=Buffer.from(await res.arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==checksums[platform])throw Error('sqlite3def checksum mismatch');
  writeFileSync(join(dir,archive),bytes);
  execFileSync(process.platform==='darwin'?'unzip':'tar',process.platform==='darwin'?['-oq',archive]:['-xzf',archive],{cwd:dir});
  mkdirSync(resolve('.wrangler/tools/'+version),{recursive:true});const {copyFileSync,chmodSync}=await import('node:fs');copyFileSync(join(dir,'sqlite3def'),bin+'.'+process.pid);chmodSync(bin+'.'+process.pid,0o755);renameSync(bin+'.'+process.pid,bin);
 }
 const remote=process.argv.includes('--remote'),args=['d1','execute','starling',remote?'--remote':'--local','--json'];
 if(process.env.STARLING_WRANGLER_CONFIG)args.push('--config',process.env.STARLING_WRANGLER_CONFIG);
 if(!remote)args.push('--persist-to',resolve(process.env.STARLING_LOCAL_DIR??'.wrangler/localhost','state'));
 const wrangler=resolve('node_modules/.bin/wrangler');
 function current(){
  const raw=execFileSync(wrangler,[...args,'--command',"SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name NOT IN ('d1_migrations','_cf_METADATA') ORDER BY rowid"],{encoding:'utf8'});
  return JSON.parse(raw)[0].results.map(r=>r.sql.replace(/\binput(?=\s+TEXT\b)/gi,'"input"')+';').join('\n')
 }
 function plan(){
  writeFileSync(join(dir,'current.sql'),current());
  const diff=execFileSync(bin,[join(dir,'current.sql'),'--file',resolve('db/schema.sql')],{encoding:'utf8'});
  return diff.split('\n').filter(s=>!s.startsWith('--')&&!['BEGIN;','COMMIT;'].includes(s)).join('\n').trim()
 }
 const sql=plan();
 if(sql&&process.argv.includes('--check')){console.error(sql);process.exitCode=2}
 else if(sql){writeFileSync(join(dir,'apply.sql'),sql);execFileSync(wrangler,[...args,'--file',join(dir,'apply.sql'),'--yes'],{stdio:['ignore','pipe','inherit']});if(plan())throw Error('Schema still differs after reconciliation');console.log('D1 schema applied.')}
 else console.log('D1 schema is current.');
}finally{rmSync(dir,{recursive:true,force:true})}
