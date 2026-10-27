# Inmensa Mar — dirección visual

## Producto y trabajo

Marisquería familiar en Guatemala. El sistema se usa en teléfonos durante ventas, preparación, entregas y control de efectivo. Cinco personas con distintas edades y experiencia digital comparten el trabajo. Diseñar por tarea y rol, con botones escritos, sin atribuir capacidades a una edad.

La referencia aportada es «Square — Style Reference». Adoptar su claridad, superficies blancas, jerarquía de acciones, radios contenidos y ausencia de sombras decorativas. Conservar identidad y funciones propias de Inmensa Mar. No copiar el logotipo, tipografías privadas, azul comercial ni textos de Square.

## Tokens

| Rol | Color |
| --- | --- |
| Superficie de trabajo | #FFFFFF |
| Fondo entre áreas | #F3F5F5 |
| Texto y marca | #142F43 |
| Acción, selección y navegación | #247B87 |
| Apoyo de marca, sin texto pequeño encima | #85C7C1 |
| Acento cálido reservado al logotipo | #D89B62 |

Bordes neutros #D7DFE1. Texto secundario #52636C. Advertencia #80571F y error #A33429 acompañados siempre de palabras. No usar el color como único indicador. Conservar colores semánticos aunque la referencia de marketing los omita: dinero, estados e inventario necesitan señales inequívocas.

## Tipografía

Una familia local: Segoe UI Variable / Segoe UI, con alternativas del sistema. Evitar fuentes remotas y tipografías privadas: el personal necesita abrir la app con rapidez y legibilidad, no esperar una descarga. La identidad la aportan el logotipo, la jerarquía, el ritmo y el uso del turquesa.

- Texto 16 px / 1.5; texto secundario nunca menos de 13 px, salvo la etiqueta de entorno.
- Acciones principales 16–18 px, peso 500–600, altura mínima 48 px; 52 px para cobrar.
- Títulos de tarea 30–36 px, peso 400–500; en móvil 28 px.
- Nombre del cliente 20–22 px; cantidades y precios legibles junto al producto.
- Total y vuelto 28–36 px con números tabulares; encabezado público 40–54 px.
- No titulares en mayúsculas, etiquetas ornamentales, monospace para metadatos ni palabras resaltadas solo por estilo.

## Distribución y alineación

Alinear textos a la izquierda, dinero a la derecha. Los pares etiqueta/valor comparten fila y se apilan en pantallas estrechas. Contener textos explicativos a unas 70–80 letras por línea.

- Sistema: cabecera blanca con el logotipo real; menú lateral en escritorio y navegación inferior en teléfono. El contexto de sesión es discreto. El contenido activo manda sobre la navegación.
- Vender: lista de productos a la izquierda y venta actual a la derecha. En teléfono, lista de ancho completo y acceso persistente a revisar/cobrar. «Agregar» siempre escrito.
- Pedidos: En tienda / En reparto, más Historial. Nuevos, preparación y listos comparten vista; una acción principal por pedido. Cancelar queda en Más opciones.
- Reparto: entregas actuales primero; selección de pedidos después. Compras es una sección del repartidor. Mantener el sencillo separado.
- Caja: conservar las tareas y comprobaciones existentes. Cambiar únicamente presentación: saldo sobre blanco, acciones explícitas, detalles desplegables y advertencias identificables.
- Inventario: filas comparables, unidades visibles, filtros breves y sin sumar cantidades de unidades distintas.
- Administración: Mi negocio / Operaciones / Finanzas. Formularios tras elegir una tarea; cifras sin mosaicos decorativos.
- Cliente: catálogo y pedido, sin acceso al sistema interno. El logotipo identifica la tienda; encabezado breve y productos reales, sin fotos genéricas ni promesas sobre frescura, cobertura u horarios que no estén confirmadas.
- Acceso y notificaciones: mismas superficies, tipografía y acciones que el resto del sistema.

## Forma y movimiento

Radios de 4 px en controles, 8 px en paneles funcionales, 12 px solo en diálogos o cajones móviles. No darle una tarjeta a cada párrafo. Espaciado 4, 8, 12, 16, 24, 32 y 48 px. No sombras en fichas ni secciones; solo diálogos superpuestos requieren separación del fondo.

No animaciones de entrada automáticas ni gradientes. Respetar movimiento reducido. Foco visible; casillas de 22 px independientes de los campos de dinero. Los modales y cajones mantienen sus mecanismos de foco y teclado existentes.

## Revisión del plan antes de construir

Se descartó convertir toda la interfaz en una landing con titulares gigantes, fotografías de relleno y botones repetidos. También se descartó el aspecto de libro contable con bordes por todas partes que había surgido al quitar tarjetas. Una superficie blanca separa áreas de trabajo; las líneas interiores se reservan para listas comparables. El acento principal sigue siendo turquesa, no azul de Square. Esta adaptación mantiene el negocio reconocible y reduce ruido sin esconder acciones frecuentes.

## Límites de esta entrega

Rediseño visual y textos de presentación. Conservar RPC, argumentos, reservas, cobros, idempotencia, permisos y confirmaciones. SQL y API de pedidos públicos permanecen iguales al paquete pendiente. Un cambio de apariencia no equivale a QA de Supabase ni a validación visual en un dispositivo real.
