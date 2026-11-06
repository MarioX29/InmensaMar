// Public contact only: do not return environment objects or credentials.
export function onRequest({request,env}){
 const headers={'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'};
 if(request.method!=='GET')return new Response(JSON.stringify({code:'METHOD_NOT_ALLOWED'}),{status:405,headers});
 const email=typeof env.PUBLIC_CONTACT_EMAIL==='string'?env.PUBLIC_CONTACT_EMAIL.trim():'';
 const phone=typeof env.PUBLIC_CONTACT_WHATSAPP==='string'?env.PUBLIC_CONTACT_WHATSAPP.replace(/[+ ()-]/g,''):'';
 const contact={email:/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)&&email.length<=254?email:null,whatsapp:/^[0-9]{8,15}$/.test(phone)?phone:null};
 return new Response(JSON.stringify(contact),{status:200,headers});
}
