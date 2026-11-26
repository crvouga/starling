import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {expect,it} from 'vitest';
const schema=readFileSync(new URL('../db/schema.sql',import.meta.url),'utf8');
it('serializes worktree changes across sessions and enforces tenant quotas atomically',()=>{
 const db=new DatabaseSync(':memory:');try{db.exec(schema);db.exec("INSERT INTO users VALUES(1,'user','ciphertext',0); INSERT INTO projects VALUES(1,'aviary/notes',2,'main');");
 const tree=db.prepare("INSERT INTO worktrees(id,user_id,project_id,branch,base,title,created) VALUES(?,1,1,?,'main','Change',unixepoch())");for(let i=0;i<8;i++)tree.run('t'+i,'starling/'+i);expect(()=>tree.run('another','starling/another')).toThrow(/quota/);
 const add=db.prepare("INSERT INTO turns(id,worktree_id,session_id,kind,input,status,created) VALUES(?,'t0',?,'prompt','change','queued',unixepoch())");db.exec("INSERT INTO sessions VALUES('s1','t0','codex',NULL,1),('s2','t0','claude',NULL,2)");
 add.run('a','s1');expect(()=>add.run('b','s2')).toThrow(/UNIQUE/i);db.exec("UPDATE turns SET status='saving' WHERE id='a'");expect(()=>add.run('b','s2')).toThrow(/UNIQUE/i);db.exec("UPDATE turns SET status='done' WHERE id='a'");add.run('b','s2');expect(()=>db.exec("UPDATE turns SET status='invalid'")).toThrow()
 }finally{db.close()}
});
