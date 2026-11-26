import {createRoot} from 'react-dom/client';
import {useEffect,useState} from 'react';
import {Spinner,Button} from '@heroui/react';
import {ApiError,api} from './api';
import {Login} from './Login';
import {Workspace} from './Workspace';
import type {Overview} from '../shared';
import './style.css';
const initialTheme=localStorage.getItem('theme')??(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');
function applyTheme(t:string){document.documentElement.classList.toggle('dark',t==='dark');document.documentElement.dataset.theme=t;localStorage.setItem('theme',t)}
applyTheme(initialTheme);
const errors:Record<string,string>={configuration:'GitHub sign-in is awaiting app registration on this deployment.',authorization:'GitHub authorization expired or was declined. Try again.',expiration:'GitHub did not issue an expiring user token. Check the app settings.'};
function App(){const [data,setData]=useState<Overview|null>(),[error,setError]=useState('');const theme=()=>applyTheme(document.documentElement.classList.contains('dark')?'light':'dark');useEffect(()=>{api<Overview>('overview').then(setData).catch(e=>{if(e instanceof ApiError&&e.status===401)setData(null);else setError(e.message)})},[]);if(error)return <div role="alert" className="grid min-h-dvh place-content-center gap-4">{error}<Button onPress={()=>location.reload()}>Retry</Button></div>;if(data===undefined)return <div className="grid min-h-dvh place-items-center"><Spinner aria-label="Loading workspace"/></div>;return data?<Workspace initial={data} theme={theme}/>:<Login theme={theme} error={errors[new URLSearchParams(location.search).get('error')??'']}/>}
createRoot(document.getElementById('root')!).render(<App/>);
