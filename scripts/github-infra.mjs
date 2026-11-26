import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const {repository,environment,ruleset}=JSON.parse(readFileSync('infra/github-repository.json','utf8'));
function api(path,method='GET',value){
 const raw=execFileSync('gh',['api','--method',method,'repos/'+repository+'/'+path,...(value?['--input','-']:[])],{input:value?JSON.stringify(value):undefined,encoding:'utf8'});
 return raw?JSON.parse(raw):null
}
const existing=api('rulesets?per_page=100').find(r=>r.name===ruleset.name);
api('rulesets'+(existing?'/'+existing.id:''),existing?'PUT':'POST',ruleset);
const {name,...policy}=environment;
api('environments/'+encodeURIComponent(name),'PUT',policy);
console.log('Reconciled '+repository+' default-branch rules and '+name+' deployment environment.');
