const timeZone='America/Guatemala';
export function businessDate(value:string){
 const date=new Date(`${value}T12:00:00-06:00`);
 return Number.isNaN(date.getTime())?'Fecha no disponible':new Intl.DateTimeFormat('es-GT',{timeZone,day:'numeric',month:'short',year:'numeric'}).format(date);
}
