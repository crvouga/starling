import {existsSync, readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
const [name, optional] = process.argv.slice(2);
if (!['setup','preview','check','test','build'].includes(name)) process.exit(2);
const scripts = existsSync('package.json') ? JSON.parse(readFileSync('package.json','utf8')).scripts ?? {} : {};
let argv;
if (Object.hasOwn(scripts,name)) argv = ['npm','run',name];
else if (existsSync('scripts/'+name)) argv = ['./scripts/'+name];
else if (name==='setup' && existsSync('package-lock.json')) argv = ['npm','ci','--no-audit','--no-fund'];
else { console.log('No '+name+' script in this repository.'); process.exit(optional==='--if-present'?0:2); }
const child=spawn(argv[0],argv.slice(1),{stdio:'inherit'}); child.on('error',()=>process.exit(1)); child.on('exit',(code)=>process.exit(code??1));
