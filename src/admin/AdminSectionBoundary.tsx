import {Component,type ReactNode} from 'react';

type Props={children:ReactNode};
type State={failed:boolean};
export class AdminSectionBoundary extends Component<Props,State>{
 state:State={failed:false};
 static getDerivedStateFromError():State{return {failed:true};}
 componentDidCatch(error:Error){console.error('Error al mostrar un apartado de Administración:',error);}
 render(){
  if(this.state.failed)return <section className="admin-view-error" role="alert">
   <h2>No pudimos mostrar este apartado</h2>
   <p>Podés volver a cargarlo o abrir otro apartado desde el menú de Administración.</p>
   <button type="button" onClick={()=>this.setState({failed:false})}>Volver a cargar</button>
  </section>;
  return this.props.children;
 }
}
