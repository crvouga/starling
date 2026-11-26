import {Hono} from 'hono';
import {getCookie,setCookie,deleteCookie} from 'hono/cookie';
import {z} from 'zod';
import {digest,fail,now,random,seal,type Env,type User} from './core';
import {gh,localGithub} from './github';
export type App={Bindings:Env;Variables:{user:User}};
const options={secure:true,httpOnly:true,sameSite:'Lax' as const,path:'/'};
export const auth=new Hono<App>();
auth.get('/github',async c=>{
  if(!c.env.GH_CLIENT_ID || !c.env.GH_CLIENT_SECRET || !c.env.KEY)return c.redirect('/?error=configuration');
  const state=random(),verifier=random();
  const destination=c.req.query('next')??'';
  const safe=/^\/api\/evidence\/[a-f0-9-]{36}\/[\w-]{1,150}\/[\w.-]{1,100}$/.test(destination)?destination:'/';
  await c.env.DB.prepare('INSERT INTO oauth_states(state,verifier,expires,destination) VALUES (?,?,?,?)').bind(await digest(state),verifier,now()+600,safe).run();
  setCookie(c,'__Host-starling-oauth',state,{...options,maxAge:600});
  const q=new URLSearchParams({client_id:c.env.GH_CLIENT_ID,redirect_uri:c.env.ORIGIN+'/auth/callback',state,code_challenge:await digest(verifier),code_challenge_method:'S256'});
  return c.redirect((localGithub(c.env)??'https://github.com')+'/login/oauth/authorize?'+q)
});
auth.get('/callback',async c=>{
  const state=c.req.query('state'),code=c.req.query('code');
  if(!state || !code || state!==getCookie(c,'__Host-starling-oauth'))return c.redirect('/?error=authorization');
  const row=await c.env.DB.prepare('DELETE FROM oauth_states WHERE state=? AND expires>? RETURNING verifier,destination').bind(await digest(state),now()).first<{verifier:string;destination:string|null}>();
  deleteCookie(c,'__Host-starling-oauth',options);if(!row)return c.redirect('/?error=authorization');
  const res=await fetch((localGithub(c.env)??'https://github.com')+'/login/oauth/access_token',{method:'POST',headers:{accept:'application/json','content-type':'application/json'},body:JSON.stringify({client_id:c.env.GH_CLIENT_ID,client_secret:c.env.GH_CLIENT_SECRET,code,code_verifier:row.verifier,redirect_uri:c.env.ORIGIN+'/auth/callback'})});
  const payload=await res.json();
  const result=z.object({access_token:z.string(),expires_in:z.number(),refresh_token:z.string()}).safeParse(localGithub(c.env)?{expires_in:3600,refresh_token:'fixture-relogin',...payload as object}:payload);
  if(!result.success)return c.redirect('/?error=expiration');
  const a=result.data,{data:u}=await gh(a.access_token,c.env).rest.users.getAuthenticated(),sid=random();
  await c.env.DB.batch([c.env.DB.prepare('INSERT INTO users VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET login=excluded.login,credential=excluded.credential,expires=excluded.expires').bind(u.id,u.login,await seal(c.env,'github:'+u.id,JSON.stringify({token:a.access_token,refresh:a.refresh_token})),now()+a.expires_in),c.env.DB.prepare('INSERT INTO logins VALUES (?,?,?)').bind(await digest(sid),u.id,now()+7*86400)]);
  if(localGithub(c.env)){for(const p of ['codex','claude'])await c.env.DB.prepare('INSERT OR IGNORE INTO accounts VALUES (?,?,?)').bind(u.id,p,await seal(c.env,u.id+':'+p,'fixture-openai-token')).run()}
  setCookie(c,'__Host-starling',sid,{...options,maxAge:7*86400});return c.redirect(row.destination??'/')
});
export async function identify(env:Env,cookie:string|undefined){if(!cookie)fail(401,'Sign in with GitHub.');const u=await env.DB.prepare('SELECT users.* FROM users JOIN logins ON users.id=logins.user_id WHERE logins.id=? AND logins.expires>?').bind(await digest(cookie),now()).first<User>();if(!u)fail(401,'Sign in with GitHub.');return u}
