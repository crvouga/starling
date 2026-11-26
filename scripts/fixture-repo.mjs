import {spawnSync,execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {mkdirSync,existsSync,writeFileSync} from 'node:fs';
// GitHub's emulator covers the REST surface. Git's standard CGI backend serves
// actual packfiles from this checkout-specific bare repository.
export function fixtureRepo(dir){
 const path=join(dir,'field-notes.git'),source=join(dir,'seed');mkdirSync(dir,{recursive:true});
 const env={...process.env,GIT_AUTHOR_NAME:'Fixture',GIT_COMMITTER_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_EMAIL:'fixture@example.test',GIT_AUTHOR_DATE:'2025-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2025-01-01T00:00:00Z'};
 const git=(...a)=>execFileSync('git',['--git-dir',path,...a],{encoding:'utf8',env}).trim();
 if(!existsSync(path)){mkdirSync(source,{recursive:true});const cmd=(...a)=>execFileSync('git',['-C',source,...a],{env});
 cmd('init','-b','main');writeFileSync(join(source,'README.md'),'# Field notes\n\nA deterministic Starling development fixture.\n');writeFileSync(join(source,'package.json'),JSON.stringify({name:'field-notes',private:true,scripts:{check:'node --check index.js',test:'node --test',build:'node --check index.js'}}));writeFileSync(join(source,'index.js'),'console.log("Field notes");\n');cmd('add','.');cmd('commit','-m','Initialize field notes');execFileSync('git',['clone','--bare',source,path],{env});git('config','http.receivepack','true')}
 const base=git('rev-parse','main'),tree=git('rev-parse',base+'^{tree}'),head=git('commit-tree',tree,'-p',base,'-m','Start worktree');
 async function transport(request,url){const route=url.pathname.slice('/aviary'.length);
 if(!['/field-notes.git/info/refs','/field-notes.git/git-receive-pack','/field-notes.git/git-upload-pack'].includes(route))return new Response(null,{status:404});
 const out=spawnSync('git',['http-backend'],{input:Buffer.from(await request.arrayBuffer()),maxBuffer:20*1024*1024,env:{...env,GIT_PROJECT_ROOT:resolve(dir),GIT_HTTP_EXPORT_ALL:'1',REQUEST_METHOD:request.method,PATH_INFO:route,QUERY_STRING:url.search.slice(1),CONTENT_TYPE:request.headers.get('content-type')??'',REMOTE_USER:'fixture'}});
 if(out.status!==0)return new Response('Fixture git failed',{status:500});const end=out.stdout.indexOf('\r\n\r\n'),headers=new Headers();let status=200;for(const line of out.stdout.subarray(0,end).toString().split('\r\n')){const i=line.indexOf(':');if(i<0)continue;const k=line.slice(0,i),v=line.slice(i+1).trim();if(k.toLowerCase()==='status')status=parseInt(v);else headers.set(k,v)}return new Response(out.stdout.subarray(end+4),{status,headers})
 }
 return {base,head,transport,git}
}
