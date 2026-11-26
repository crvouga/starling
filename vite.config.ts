import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const require=createRequire(import.meta.url);
let licensed=false;
try{require.resolve('@heroui-pro/react/chat-conversation');licensed=true}catch{}
export default defineConfig({plugins:[react(),tailwind()],resolve:{alias:{'#conversation':resolve('src/web/'+(licensed?'Conversation.jsx':'ChatUnavailable.tsx'))}},define:{__CHATUI__:JSON.stringify(licensed)},server:{host:'127.0.0.1'},build:{chunkSizeWarningLimit:800}});
