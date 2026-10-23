// Cloudflare Pages Function: authenticated, self-only Web Push QA.
// Secrets are read from context.env; never exposed to the browser.
const enc = new TextEncoder();
const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') .padEnd(Math.ceil(s.length / 4) * 4, '=')), c => c.charCodeAt(0));
const concat = (...arrays) => { const out = new Uint8Array(arrays.reduce((n,a)=>n+a.length,0)); let i=0; for (const a of arrays) {out.set(a,i);i+=a.length;} return out; };
const u32 = (n) => new Uint8Array([(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255]);
function json(body, status=200) { return new Response(JSON.stringify(body), {status, headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}}); }
async function hkdf(ikm, salt, info, length) {
  const key=await crypto.subtle.importKey('raw',ikm,'HKDF',false,['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt,info},key,length*8));
}
async function encrypt(subscription, payload) {
  const receiver=unb64u(subscription.p256dh), auth=unb64u(subscription.auth_key);
  if (receiver.length!==65 || auth.length!==16) throw Error('Invalid subscription keys');
  const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const serverPublic=new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey));
  const clientPublic=await crypto.subtle.importKey('raw',receiver,{name:'ECDH',namedCurve:'P-256'},false,[]);
  const shared=new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:clientPublic},pair.privateKey,256));
  const ikm=await hkdf(shared,auth,concat(enc.encode('WebPush: info'),new Uint8Array([0]),receiver,serverPublic),32);
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const key=await hkdf(ikm,salt,enc.encode('Content-Encoding: aes128gcm\0'),16);
  const nonce=await hkdf(ikm,salt,enc.encode('Content-Encoding: nonce\0'),12);
  const aes=await crypto.subtle.importKey('raw',key,'AES-GCM',false,['encrypt']);
  const message=concat(enc.encode(JSON.stringify(payload)),new Uint8Array([2]));
  const ciphertext=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce},aes,message));
  return concat(salt,u32(4096),new Uint8Array([serverPublic.length]),serverPublic,ciphertext);
}
async function vapidHeaders(endpoint, publicKey, privateKey) {
  const pub=unb64u(publicKey),priv=unb64u(privateKey);
  if (pub.length!==65 || priv.length!==32) throw Error('Invalid VAPID key configuration');
  const key=await crypto.subtle.importKey('jwk',{kty:'EC',crv:'P-256',x:b64u(pub.slice(1,33)),y:b64u(pub.slice(33)),d:b64u(priv),ext:false,key_ops:['sign']},{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  const aud=new URL(endpoint).origin;
  const head=b64u(enc.encode(JSON.stringify({typ:'JWT',alg:'ES256'})));
  const body=b64u(enc.encode(JSON.stringify({aud,exp:Math.floor(Date.now()/1000)+3600,sub:'https://inmensamar.pages.dev'})));
  const input=`${head}.${body}`;
  const signature=new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,enc.encode(input)));
  return `vapid t=${input}.${b64u(signature)}, k=${publicKey}`;
}
function permittedEndpoint(endpoint) {
  try {
    const u=new URL(endpoint);
    if (u.protocol!=='https:' || u.username || u.password || u.port && u.port!=='443') return false;
    const h=u.hostname.toLowerCase();
    return h==='fcm.googleapis.com' || h==='updates.push.services.mozilla.com' || h==='push.services.mozilla.com' || h==='web.push.apple.com' || h.endsWith('.push.apple.com') || h.endsWith('.notify.windows.com') || h==='wns2-pn1p.notify.windows.com';
  } catch { return false; }
}
export async function onRequestPost({request,env}) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return json({error:'Server push secrets not available in this deployment'},503);
  const bearer=request.headers.get('authorization')||'';
  if (!/^Bearer\s+\S+$/.test(bearer)) return json({error:'Authentication required'},401);
  const token=bearer.replace(/^Bearer\s+/,'');
  const base=env.SUPABASE_URL.replace(/\/$/,'');
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(base)) return json({error:'Invalid server configuration'},503);
  const adminHeaders={'apikey':env.SUPABASE_SERVICE_ROLE_KEY,'authorization':`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`};
  const authResponse=await fetch(`${base}/auth/v1/user`,{headers:{...adminHeaders,authorization:`Bearer ${token}`}});
  if (!authResponse.ok) return json({error:'Invalid session'},401);
  const user=await authResponse.json();
  if (!user?.id) return json({error:'Invalid session'},401);
  const query=new URL(`${base}/rest/v1/push_subscriptions`);
  query.searchParams.set('select','endpoint,p256dh,auth_key');
  query.searchParams.set('user_id',`eq.${user.id}`);
  query.searchParams.set('limit','5');
  const response=await fetch(query,{headers:adminHeaders});
  if (!response.ok) return json({error:'Unable to read subscriptions'},502);
  const subs=await response.json();
  if (!Array.isArray(subs)||subs.length===0) return json({error:'No registered devices'},404);
  let sent=0,failed=0;
  for (const sub of subs) {
    if (!permittedEndpoint(sub.endpoint)) {failed++;continue;}
    try {
      const payload=await encrypt(sub,{title:'Inmensa Mar · Push remota',body:'Prueba enviada desde Cloudflare.',url:'/'});
      const auth=await vapidHeaders(sub.endpoint,env.VAPID_PUBLIC_KEY,env.VAPID_PRIVATE_KEY);
      const r=await fetch(sub.endpoint,{method:'POST',headers:{'authorization':auth,'content-encoding':'aes128gcm','content-type':'application/octet-stream','ttl':'60','urgency':'normal'},body:payload});
      if (r.status===201||r.status===202||r.status===200) sent++;else failed++;
    } catch { failed++; }
  }
  return json({sent,failed, note:'Accepted by push service; device delivery must be verified.'},sent?200:502);
}
export function onRequestGet() { return json({error:'Method not allowed'},405); }
