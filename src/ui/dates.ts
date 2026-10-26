const timeZone='America/Guatemala';

// SQL report days can arrive as YYYY-MM-DD or as a midnight timestamp.
// They represent a business calendar date, so retain that day rather than
// shifting it backwards by applying Guatemala's offset to UTC midnight.
export function businessDate(value:string,options:{year?:boolean}={}){
 if(typeof value!=='string')return 'Fecha no disponible';
 const match=/^(\d{4}-\d{2}-\d{2})(?:$|T|\s)/.exec(value.trim());
 if(!match)return 'Fecha no disponible';
 const day=match[1];
 const date=new Date(`${day}T12:00:00-06:00`);
 if(Number.isNaN(date.getTime())||date.toISOString().slice(0,10)!==day)return 'Fecha no disponible';
 return new Intl.DateTimeFormat('es-GT',{timeZone,day:'numeric',month:'short',year:options.year===false?undefined:'numeric'}).format(date);
}
