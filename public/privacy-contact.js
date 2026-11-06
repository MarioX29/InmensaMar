(async()=>{
 try{
  const response=await fetch('/api/business-contact',{cache:'no-store'});if(!response.ok)return;
  const data=await response.json(),links=[];
  if(typeof data.email==='string'&&data.email.length<=254&&/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(data.email)){
   const link=document.createElement('a');link.href='mailto:'+encodeURIComponent(data.email);link.textContent=data.email;links.push(link);
  }
  if(typeof data.whatsapp==='string'&&/^[0-9]{8,15}$/.test(data.whatsapp)){
   const link=document.createElement('a');link.href='https://wa.me/'+data.whatsapp;link.target='_blank';link.rel='noopener noreferrer';link.textContent='Contactar por WhatsApp';links.push(link);
  }
  const container=document.getElementById('privacy-contact');if(container)for(const link of links)container.appendChild(link);
 }catch{/* The published notice retains its contact instructions when offline. */}
})();
