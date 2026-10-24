import { Fragment, useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { 
  ShoppingBag, Package, PlusCircle, Search, Trash2, 
  Eye, EyeOff, Edit2, Check, X, Camera, Image, Sparkles, RefreshCw,
  Receipt, BarChart3, Banknote, CreditCard, Smartphone, Printer, ChevronDown, ChevronUp,
  Tag, TrendingUp, AlertTriangle, Layers, Calendar, ClipboardList, Wifi, WifiOff, CloudUpload
} from 'lucide-react'

const CATEGORIAS = ['TODAS', 'CADENAS-COLLARES', 'ARETES', 'PULSERAS', 'ANILLOS', 'LLAVEROS', 'PINES']
const METODOS_PAGO = [
  { id: 'Efectivo', label: 'Efectivo', icon: Banknote },
  { id: 'Transferencia', label: 'Transferencia', icon: Smartphone },
  { id: 'Tarjeta', label: 'Tarjeta', icon: CreditCard }
]

// Claves de almacenamiento interno en la tablet/teléfono
const STORAGE_KEYS = {
  PRODUCTOS: 'destellos_cache_productos',
  VENTAS: 'destellos_cache_ventas',
  PROMOS: 'destellos_cache_promos',
  PEDIDOS: 'destellos_cache_pedidos',
  COLA_SYNC: 'destellos_cola_offline'
}

function leerCacheLocal(key, valorPorDefecto = []) {
  try {
    const guardado = localStorage.getItem(key)
    return guardado ? JSON.parse(guardado) : valorPorDefecto
  } catch {
    return valorPorDefecto
  }
}

function guardarCacheLocal(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data))
  } catch (e) {
    console.error('Error guardando en memoria local:', e)
  }
}

async function subirImagenASupabase(file) {
  const bitmap = await createImageBitmap(file)
  const canvas = document.createElement('canvas')
  const maxWidth = 600
  const scale = maxWidth / bitmap.width
  canvas.width = bitmap.width > maxWidth ? maxWidth : bitmap.width
  canvas.height = bitmap.width > maxWidth ? bitmap.height * scale : bitmap.height

  const ctx = canvas.getContext('2d')
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)

  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.75))
  const fileName = `prod_${crypto.randomUUID()}.jpg`

  const { error: uploadError } = await supabase.storage
    .from('productos')
    .upload(fileName, blob, { contentType: 'image/jpeg' })

  if (uploadError) throw uploadError

  const { data } = supabase.storage.from('productos').getPublicUrl(fileName)
  return data.publicUrl
}

function calcularMejorPrecioPromo(cantidadTotal, precioBase, reglas) {
  const reglasOrdenadas = [...(reglas || [])]
    .filter(r => Number(r.cantidad) > 0 && Number(r.precio_total) > 0)
    .sort((a, b) => Number(b.cantidad) - Number(a.cantidad))

  let restante = cantidadTotal
  let totalConPromo = 0
  const paquetesAplicados = []

  for (const regla of reglasOrdenadas) {
    const cantRegla = Number(regla.cantidad)
    const precioRegla = Number(regla.precio_total)
    if (restante >= cantRegla) {
      const numCombos = Math.floor(restante / cantRegla)
      totalConPromo += numCombos * precioRegla
      restante = restante % cantRegla
      paquetesAplicados.push(`${numCombos > 1 ? `${numCombos}x ` : ''}(${cantRegla}x$${precioRegla})`)
    }
  }

  if (restante > 0) {
    totalConPromo += restante * precioBase
  }

  return { totalConPromo, paquetesAplicados }
}

// Procesador de la cola de operaciones guardadas sin internet
async function procesarColaOfflineEnServidor(colaActual) {
  const pendientesRestantes = []

  for (const accion of colaActual) {
    try {
      if (accion.tipo === 'REGISTRAR_VENTA') {
        const { error: errVenta } = await supabase.from('ventas').insert([accion.payload.venta])
        if (errVenta) throw errVenta

        for (const desc of (accion.payload.descuentosStock || [])) {
          const { data: prodDb } = await supabase
            .from('productos')
            .select('cantidad')
            .eq('id', desc.id)
            .single()

          if (prodDb) {
            const nuevoStock = Math.max(0, Number(prodDb.cantidad) - Number(desc.qtyVendida))
            await supabase.from('productos').update({ cantidad: nuevoStock }).eq('id', desc.id)
          }
        }
      } else if (accion.tipo === 'EDITAR_PRODUCTO') {
        const { error } = await supabase.from('productos').update(accion.payload.cambios).eq('id', accion.payload.id)
        if (error) throw error
      } else if (accion.tipo === 'CREAR_PRODUCTO') {
        const { error } = await supabase.from('productos').insert([accion.payload])
        if (error) throw error
      } else if (accion.tipo === 'CREAR_PEDIDO') {
        const { error } = await supabase.from('pedidos').insert([accion.payload])
        if (error) throw error
      } else if (accion.tipo === 'COMPLETAR_PEDIDO') {
        const { error: errPed } = await supabase
          .from('pedidos')
          .update({ estado: 'ENTREGADO' })
          .eq('id', accion.payload.pedidoId)
        if (errPed) throw errPed

        const { error: errVenta } = await supabase.from('ventas').insert([accion.payload.venta])
        if (errVenta) throw errVenta
      } else if (accion.tipo === 'CAMBIAR_ESTADO_PEDIDO') {
        const { error } = await supabase
          .from('pedidos')
          .update({ estado: accion.payload.estado })
          .eq('id', accion.payload.id)
        if (error) throw error
      }
    } catch (err) {
      console.error('Operación aún pendiente por sincronizar:', accion.tipo, err)
      pendientesRestantes.push(accion)
    }
  }

  return pendientesRestantes
}

export default function App() {
  // 'ventas' | 'inventario' | 'agregar' | 'promociones' | 'pedidos' | 'calendario' | 'tickets' | 'cortes' | 'analiticas'
  const [vistaActiva, setVistaActiva] = useState('ventas')
  
  // Inicialización inmediata desde caché local para que funcione en el malecón sin internet
  const [productos, setProductos] = useState(() => leerCacheLocal(STORAGE_KEYS.PRODUCTOS, []))
  const [ventas, setVentas] = useState(() => leerCacheLocal(STORAGE_KEYS.VENTAS, []))
  const [promociones, setPromociones] = useState(() => leerCacheLocal(STORAGE_KEYS.PROMOS, []))
  const [pedidos, setPedidos] = useState(() => leerCacheLocal(STORAGE_KEYS.PEDIDOS, []))
  const [colaOffline, setColaOffline] = useState(() => leerCacheLocal(STORAGE_KEYS.COLA_SYNC, []))
  
  const [esOnline, setEsOnline] = useState(() => navigator.onLine)
  const [cargando, setCargando] = useState(true)
  const [sincronizando, setSincronizando] = useState(false)
  
  // Estados para Ventas (POS) y Filtros
  const [categoriaFiltro, setCategoriaFiltro] = useState('TODAS')
  const [tematicaFiltro, setTematicaFiltro] = useState('TODAS')
  const [busqueda, setBusqueda] = useState('')
  const [ocultarAgotados, setOcultarAgotados] = useState(false)
  const [carrito, setCarrito] = useState([])
  const [descuentoManual, setDescuentoManual] = useState(0)
  const [metodoPago, setMetodoPago] = useState('Efectivo')
  const [montoRecibido, setMontoRecibido] = useState('')
  const [procesandoVenta, setProcesandoVenta] = useState(false)

  // Selector de método de pago para cada pedido al entregarlo en el calendario
  const [metodoPagoPedidos, setMetodoPagoPedidos] = useState({})

  // Estado para el Modal de Recibo (Ticket Digital)
  const [ticketSeleccionado, setTicketSeleccionado] = useState(null)

  // Estado para expandir días en la sección Cortes
  const [diaCorteExpandido, setDiaCorteExpandido] = useState(null)

  // Estados para Inventario
  const [imagenExpandidaId, setImagenExpandidaId] = useState(null)
  const [editandoId, setEditandoId] = useState(null)
  const [formEdicion, setFormEdicion] = useState({})

  // Estados para Agregar Producto
  const [nuevoProd, setNuevoProd] = useState({
    codigo: '',
    nombre_producto: '',
    categoria: 'CADENAS-COLLARES',
    tematica: '',
    cantidad: 1,
    costo_produccion: '',
    precio_publico: '',
    imagen_url: ''
  })
  const [subiendoImagen, setSubiendoImagen] = useState(false)

  // Estados para Crear Promoción
  const [nuevaPromo, setNuevaPromo] = useState({
    nombre: '',
    tipo_aplicacion: 'PRODUCTO',
    producto_id: '',
    categoria: 'PINES',
    reglas: [
      { cantidad: 2, precio_total: 40 },
      { cantidad: 3, precio_total: 50 }
    ]
  })

  // Estados para Nuevo Pedido por Encargo
  const [nuevoPedido, setNuevoPedido] = useState({
    cliente: '',
    telefono: '',
    descripcion_pedido: '',
    fecha_entrega: '',
    costo_produccion: '',
    precio_acordado: '',
    anticipo: ''
  })

  // Función auxiliar para guardar operaciones en la cola local cuando no hay internet
  function encolarAccionOffline(nuevaAccion) {
    setColaOffline(prev => {
      const actualizada = [...prev, { ...nuevaAccion, timestamp: new Date().toISOString() }]
      guardarCacheLocal(STORAGE_KEYS.COLA_SYNC, actualizada)
      return actualizada
    })
  }

  // Detector de conexión y sincronización automática cuando regresa el internet
  useEffect(() => {
    let cancelado = false

    async function sincronizarYDescargar() {
      if (!navigator.onLine) {
        if (!cancelado) setCargando(false)
        return
      }

      // 1. Si hay operaciones guardadas en la tablet sin internet, subirlas primero
      const colaGuardada = leerCacheLocal(STORAGE_KEYS.COLA_SYNC, [])
      if (colaGuardada.length > 0) {
        if (!cancelado) setSincronizando(true)
        const restantes = await procesarColaOfflineEnServidor(colaGuardada)
        guardarCacheLocal(STORAGE_KEYS.COLA_SYNC, restantes)
        if (!cancelado) {
          setColaOffline(restantes)
          setSincronizando(false)
        }
      }

      // 2. Descargar datos frescos de Supabase y actualizar el caché local
      try {
        const [resProductos, resVentas, resPromos, resPedidos] = await Promise.all([
          supabase.from('productos').select('*').order('nombre_producto', { ascending: true }),
          supabase.from('ventas').select('*').order('created_at', { ascending: false }),
          supabase.from('promociones').select('*').order('created_at', { ascending: false }),
          supabase.from('pedidos').select('*').order('fecha_entrega', { ascending: true })
        ])

        if (cancelado) return

        if (!resProductos.error && resProductos.data) {
          setProductos(resProductos.data)
          guardarCacheLocal(STORAGE_KEYS.PRODUCTOS, resProductos.data)
        }
        if (!resVentas.error && resVentas.data) {
          setVentas(resVentas.data)
          guardarCacheLocal(STORAGE_KEYS.VENTAS, resVentas.data)
        }
        if (!resPromos.error && resPromos.data) {
          setPromociones(resPromos.data)
          guardarCacheLocal(STORAGE_KEYS.PROMOS, resPromos.data)
        }
        if (!resPedidos.error && resPedidos.data) {
          setPedidos(resPedidos.data)
          guardarCacheLocal(STORAGE_KEYS.PEDIDOS, resPedidos.data)
        }
      } catch (err) {
        console.warn('Trabajando con datos en caché local:', err)
      } finally {
        if (!cancelado) setCargando(false)
      }
    }

    sincronizarYDescargar()

    function manejarOnline() {
      setEsOnline(true)
      sincronizarYDescargar()
    }

    function manejarOffline() {
      setEsOnline(false)
    }

    window.addEventListener('online', manejarOnline)
    window.addEventListener('offline', manejarOffline)

    return () => {
      cancelado = true
      window.removeEventListener('online', manejarOnline)
      window.removeEventListener('offline', manejarOffline)
    }
  }, [])

  // Botón manual de sincronización
  async function recargarDatos() {
    if (!navigator.onLine) {
      return alert('Estás en Modo Offline (sin internet). Todas tus ventas y cambios están seguros en la memoria de la tablet y se subirán en cuanto tengas conexión.')
    }

    setCargando(true)
    const colaGuardada = leerCacheLocal(STORAGE_KEYS.COLA_SYNC, [])
    if (colaGuardada.length > 0) {
      setSincronizando(true)
      const restantes = await procesarColaOfflineEnServidor(colaGuardada)
      guardarCacheLocal(STORAGE_KEYS.COLA_SYNC, restantes)
      setColaOffline(restantes)
      setSincronizando(false)
    }

    const [resProductos, resVentas, resPromos, resPedidos] = await Promise.all([
      supabase.from('productos').select('*').order('nombre_producto', { ascending: true }),
      supabase.from('ventas').select('*').order('created_at', { ascending: false }),
      supabase.from('promociones').select('*').order('created_at', { ascending: false }),
      supabase.from('pedidos').select('*').order('fecha_entrega', { ascending: true })
    ])

    if (!resProductos.error && resProductos.data) {
      setProductos(resProductos.data)
      guardarCacheLocal(STORAGE_KEYS.PRODUCTOS, resProductos.data)
    }
    if (!resVentas.error && resVentas.data) {
      setVentas(resVentas.data)
      guardarCacheLocal(STORAGE_KEYS.VENTAS, resVentas.data)
    }
    if (!resPromos.error && resPromos.data) {
      setPromociones(resPromos.data)
      guardarCacheLocal(STORAGE_KEYS.PROMOS, resPromos.data)
    }
    if (!resPedidos.error && resPedidos.data) {
      setPedidos(resPedidos.data)
      guardarCacheLocal(STORAGE_KEYS.PEDIDOS, resPedidos.data)
    }
    setCargando(false)
  }

  const tematicasPines = Array.from(
    new Set(
      productos
        .filter(p => p.categoria === 'PINES' && p.tematica && p.tematica.trim() !== '')
        .map(p => p.tematica.trim().toUpperCase())
    )
  ).sort()

  async function comprimirYSubirImagen(file) {
    if (!file) return null
    if (!navigator.onLine) {
      alert('Para subir fotografías nuevas a la nube necesitas conexión a internet.')
      return null
    }
    setSubiendoImagen(true)
    try {
      return await subirImagenASupabase(file)
    } catch (err) {
      alert('Error al subir imagen: Verifica tu conexión o el bucket "productos".')
      console.error(err)
      return null
    } finally {
      setSubiendoImagen(false)
    }
  }

  function agregarAlCarrito(producto) {
    if (producto.cantidad <= 0) return alert('Este producto está agotado en el inventario.')
    
    setCarrito(prev => {
      const existe = prev.find(item => item.id === producto.id)
      if (existe) {
        if (existe.qty >= producto.cantidad) {
          alert(`Solo hay ${producto.cantidad} unidades disponibles en stock.`)
          return prev
        }
        return prev.map(item => item.id === producto.id ? { ...item, qty: item.qty + 1 } : item)
      }
      return [...prev, { ...producto, qty: 1 }]
    })
  }

  function cambiarCantidadCarrito(id, delta, maxStock) {
    setCarrito(prev => prev.map(item => {
      if (item.id === id) {
        const nuevaQty = item.qty + delta
        if (nuevaQty > maxStock) {
          alert(`Stock máximo alcanzado (${maxStock})`)
          return item
        }
        return nuevaQty > 0 ? { ...item, qty: nuevaQty } : null
      }
      return item
    }).filter(Boolean))
  }

  const calculoCarrito = (() => {
    const subtotalSinPromo = carrito.reduce((acc, item) => acc + (Number(item.precio_publico) * item.qty), 0)
    const costoTotal = carrito.reduce((acc, item) => acc + (Number(item.costo_produccion || 0) * item.qty), 0)
    
    let descuentoPromociones = 0
    const detallePromosAplicadas = []
    const itemsYaProcesados = new Set()

    const promosActivas = promociones.filter(p => p.activa)

    for (const item of carrito) {
      const promoProd = promosActivas.find(p => p.tipo_aplicacion === 'PRODUCTO' && p.producto_id === item.id)
      if (promoProd) {
        const precioNormal = Number(item.precio_publico) * item.qty
        const { totalConPromo, paquetesAplicados } = calcularMejorPrecioPromo(
          item.qty,
          Number(item.precio_publico),
          promoProd.reglas
        )
        const ahorro = Math.max(0, precioNormal - totalConPromo)
        if (ahorro > 0) {
          descuentoPromociones += ahorro
          detallePromosAplicadas.push({
            nombre: `${promoProd.nombre}: ${paquetesAplicados.join(' + ')}`,
            ahorro
          })
        }
        itemsYaProcesados.add(item.id)
      }
    }

    const promosCategoria = promosActivas.filter(p => p.tipo_aplicacion === 'CATEGORIA')
    for (const promoCat of promosCategoria) {
      const itemsCat = carrito.filter(i => i.categoria === promoCat.categoria && !itemsYaProcesados.has(i.id))
      if (itemsCat.length > 0) {
        const cantTotalCat = itemsCat.reduce((sum, i) => sum + i.qty, 0)
        const precioNormalCat = itemsCat.reduce((sum, i) => sum + (Number(i.precio_publico) * i.qty), 0)
        const precioPromedioUnitario = precioNormalCat / cantTotalCat

        const { totalConPromo, paquetesAplicados } = calcularMejorPrecioPromo(
          cantTotalCat,
          precioPromedioUnitario,
          promoCat.reglas
        )
        const ahorro = Math.max(0, precioNormalCat - totalConPromo)
        if (ahorro > 0) {
          descuentoPromociones += ahorro
          detallePromosAplicadas.push({
            nombre: `${promoCat.nombre} (${promoCat.categoria}): ${paquetesAplicados.join(' + ')}`,
            ahorro
          })
        }
        itemsCat.forEach(i => itemsYaProcesados.add(i.id))
      }
    }

    const descuentoTotal = descuentoPromociones + Number(descuentoManual || 0)
    const totalFinal = Math.max(0, subtotalSinPromo - descuentoTotal)
    const gananciaNeta = totalFinal - costoTotal

    return {
      subtotalSinPromo,
      descuentoPromociones,
      detallePromosAplicadas,
      descuentoTotal,
      totalFinal,
      gananciaNeta
    }
  })()

  const cambioCliente = metodoPago === 'Efectivo' && Number(montoRecibido) >= calculoCarrito.totalFinal
    ? Number(montoRecibido) - calculoCarrito.totalFinal
    : 0

  // --- COBRAR VENTA (SOPORTA MODO ONLINE Y OFFLINE EN EL MALECÓN) ---
  async function cobrarVenta() {
    if (carrito.length === 0) return
    setProcesandoVenta(true)

    const itemsVendidos = carrito.map(item => ({
      id: item.id,
      codigo: item.codigo,
      nombre_producto: item.nombre_producto,
      categoria: item.categoria,
      tematica: item.tematica || '',
      precio_unitario: Number(item.precio_publico),
      costo_unitario: Number(item.costo_produccion || 0),
      qty: item.qty,
      subtotal: Number(item.precio_publico) * item.qty
    }))

    const payloadVenta = {
      id: crypto.randomUUID(),
      items: itemsVendidos,
      subtotal: calculoCarrito.subtotalSinPromo,
      descuento: calculoCarrito.descuentoTotal,
      total: calculoCarrito.totalFinal,
      ganancia_neta: calculoCarrito.gananciaNeta,
      metodo_pago: metodoPago,
      created_at: new Date().toISOString()
    }

    const descuentosStock = carrito.map(item => ({
      id: item.id,
      qtyVendida: item.qty
    }))

    // Función para guardar la venta localmente si no hay internet o si falla la señal
    function guardarVentaModoOffline() {
      const productosActualizados = productos.map(p => {
        const vendido = carrito.find(c => c.id === p.id)
        if (vendido) {
          return { ...p, cantidad: Math.max(0, Number(p.cantidad) - Number(vendido.qty)) }
        }
        return p
      })
      setProductos(productosActualizados)
      guardarCacheLocal(STORAGE_KEYS.PRODUCTOS, productosActualizados)

      const ventaLocal = {
        ...payloadVenta,
        folio: `OFF-${String(ventas.length + 1).padStart(3, '0')}`,
        pendienteSync: true
      }

      const nuevasVentas = [ventaLocal, ...ventas]
      setVentas(nuevasVentas)
      guardarCacheLocal(STORAGE_KEYS.VENTAS, nuevasVentas)

      encolarAccionOffline({
        tipo: 'REGISTRAR_VENTA',
        payload: { venta: payloadVenta, descuentosStock }
      })

      const ventaConDetalles = {
        ...ventaLocal,
        promosAplicadas: calculoCarrito.detallePromosAplicadas,
        recibido: metodoPago === 'Efectivo' && Number(montoRecibido) > 0 ? Number(montoRecibido) : null,
        cambio: cambioCliente
      }

      setCarrito([])
      setDescuentoManual(0)
      setMontoRecibido('')
      setMetodoPago('Efectivo')
      setTicketSeleccionado(ventaConDetalles)
    }

    try {
      if (!navigator.onLine) {
        guardarVentaModoOffline()
        return
      }

      const { data: nuevaVenta, error: ventaError } = await supabase
        .from('ventas')
        .insert([payloadVenta])
        .select()
        .single()

      if (ventaError) throw ventaError

      for (const item of carrito) {
        const nuevoStock = Math.max(0, item.cantidad - item.qty)
        await supabase
          .from('productos')
          .update({ cantidad: nuevoStock })
          .eq('id', item.id)
      }

      const ventaConDetalles = {
        ...nuevaVenta,
        promosAplicadas: calculoCarrito.detallePromosAplicadas,
        recibido: metodoPago === 'Efectivo' && Number(montoRecibido) > 0 ? Number(montoRecibido) : null,
        cambio: cambioCliente
      }

      setCarrito([])
      setDescuentoManual(0)
      setMontoRecibido('')
      setMetodoPago('Efectivo')
      await recargarDatos()
      setTicketSeleccionado(ventaConDetalles)
    } catch (error) {
      console.warn('Señal inestable, guardando venta en memoria interna de la tablet:', error)
      guardarVentaModoOffline()
    } finally {
      setProcesandoVenta(false)
    }
  }

  async function anularTicket(ticket) {
    if (!navigator.onLine) {
      return alert('Para anular un ticket necesitas estar conectado a internet.')
    }

    const confirmar = window.confirm(
      `¿Seguro que deseas ANULAR el Ticket #${ticket.folio || ticket.id.slice(0, 5)} por $${ticket.total}?\n\nLas piezas vendidas se sumarán de vuelta al inventario.`
    )
    if (!confirmar) return

    try {
      for (const item of (ticket.items || [])) {
        if (!item.es_pedido) {
          const prodActual = productos.find(p => p.id === item.id)
          if (prodActual) {
            await supabase
              .from('productos')
              .update({ cantidad: Number(prodActual.cantidad) + Number(item.qty) })
              .eq('id', item.id)
          }
        }
      }

      const { error } = await supabase.from('ventas').delete().eq('id', ticket.id)
      if (error) throw error

      if (ticketSeleccionado?.id === ticket.id) setTicketSeleccionado(null)
      await recargarDatos()
      alert('Ticket anulado correctamente.')
    } catch (err) {
      alert('Error al anular el ticket: ' + err.message)
    }
  }

  // --- GESTIÓN DE PEDIDOS POR ENCARGO Y CONTABILIZACIÓN EN TICKETS/CORTES ---
  async function crearPedido(e) {
    e.preventDefault()
    if (!nuevoPedido.cliente || !nuevoPedido.descripcion_pedido || !nuevoPedido.fecha_entrega || !nuevoPedido.precio_acordado) {
      return alert('Por favor llena los campos obligatorios del pedido.')
    }

    const payloadPedido = {
      id: crypto.randomUUID(),
      cliente: nuevoPedido.cliente,
      telefono: nuevoPedido.telefono || '',
      descripcion_pedido: nuevoPedido.descripcion_pedido,
      fecha_entrega: nuevoPedido.fecha_entrega,
      costo_produccion: Number(nuevoPedido.costo_produccion) || 0,
      precio_acordado: Number(nuevoPedido.precio_acordado),
      anticipo: Number(nuevoPedido.anticipo) || 0,
      estado: 'PENDIENTE',
      created_at: new Date().toISOString()
    }

    function guardarPedidoOffline() {
      const actualizados = [...pedidos, payloadPedido].sort((a, b) => a.fecha_entrega.localeCompare(b.fecha_entrega))
      setPedidos(actualizados)
      guardarCacheLocal(STORAGE_KEYS.PEDIDOS, actualizados)
      encolarAccionOffline({ tipo: 'CREAR_PEDIDO', payload: payloadPedido })
      alert('¡Pedido guardado en memoria interna (Modo Offline)! Se sincronizará al tener internet.')
      setNuevoPedido({
        cliente: '', telefono: '', descripcion_pedido: '', fecha_entrega: '',
        costo_produccion: '', precio_acordado: '', anticipo: ''
      })
      setVistaActiva('calendario')
    }

    if (!navigator.onLine) {
      guardarPedidoOffline()
      return
    }

    const { error } = await supabase.from('pedidos').insert([payloadPedido])

    if (error) {
      guardarPedidoOffline()
    } else {
      alert('¡Pedido por encargo registrado con éxito!')
      setNuevoPedido({
        cliente: '', telefono: '', descripcion_pedido: '', fecha_entrega: '',
        costo_produccion: '', precio_acordado: '', anticipo: ''
      })
      recargarDatos()
      setVistaActiva('calendario')
    }
  }

  // Entregar Pedido -> Pasa a ENTREGADO y genera automáticamente su Ticket en Ventas y Finanzas
  async function completarYContabilizarPedido(pedido) {
    const metodoElegido = metodoPagoPedidos[pedido.id] || 'Efectivo'
    const precioTotal = Number(pedido.precio_acordado || 0)
    const costoTotal = Number(pedido.costo_produccion || 0)
    const gananciaNeta = precioTotal - costoTotal

    const confirmar = window.confirm(
      `¿Marcar como ENTREGADO el pedido de ${pedido.cliente} y contabilizar $${precioTotal.toFixed(2)} (${metodoElegido}) en Tickets y Corte de Caja?`
    )
    if (!confirmar) return

    const itemPedido = [{
      id: pedido.id,
      codigo: 'PEDIDO',
      nombre_producto: `Pedido: ${pedido.descripcion_pedido} (${pedido.cliente})`,
      categoria: 'PEDIDOS ESPECIALES',
      tematica: '',
      precio_unitario: precioTotal,
      costo_unitario: costoTotal,
      qty: 1,
      subtotal: precioTotal,
      es_pedido: true
    }]

    const payloadVenta = {
      id: crypto.randomUUID(),
      items: itemPedido,
      subtotal: precioTotal,
      descuento: 0,
      total: precioTotal,
      ganancia_neta: gananciaNeta,
      metodo_pago: metodoElegido,
      created_at: new Date().toISOString()
    }

    function completarEnModoOffline() {
      const pedidosActualizados = pedidos.map(p => p.id === pedido.id ? { ...p, estado: 'ENTREGADO' } : p)
      setPedidos(pedidosActualizados)
      guardarCacheLocal(STORAGE_KEYS.PEDIDOS, pedidosActualizados)

      const ventaLocal = {
        ...payloadVenta,
        folio: `PED-${String(ventas.length + 1).padStart(3, '0')}`,
        pendienteSync: true
      }
      const nuevasVentas = [ventaLocal, ...ventas]
      setVentas(nuevasVentas)
      guardarCacheLocal(STORAGE_KEYS.VENTAS, nuevasVentas)

      encolarAccionOffline({
        tipo: 'COMPLETAR_PEDIDO',
        payload: { pedidoId: pedido.id, venta: payloadVenta }
      })

      setTicketSeleccionado(ventaLocal)
    }

    if (!navigator.onLine) {
      completarEnModoOffline()
      return
    }

    try {
      const { error: errPed } = await supabase
        .from('pedidos')
        .update({ estado: 'ENTREGADO' })
        .eq('id', pedido.id)
      if (errPed) throw errPed

      const { data: nuevaVenta, error: errVenta } = await supabase
        .from('ventas')
        .insert([payloadVenta])
        .select()
        .single()
      if (errVenta) throw errVenta

      await recargarDatos()
      setTicketSeleccionado(nuevaVenta)
    } catch (err) {
      console.warn('Fallo de red al completar pedido, guardando en cola offline:', err)
      completarEnModoOffline()
    }
  }

  async function cambiarEstadoPedido(pedido, nuevoEstado) {
    if (!navigator.onLine) {
      const actualizados = pedidos.map(p => p.id === pedido.id ? { ...p, estado: nuevoEstado } : p)
      setPedidos(actualizados)
      guardarCacheLocal(STORAGE_KEYS.PEDIDOS, actualizados)
      encolarAccionOffline({ tipo: 'CAMBIAR_ESTADO_PEDIDO', payload: { id: pedido.id, estado: nuevoEstado } })
      return
    }

    const { error } = await supabase
      .from('pedidos')
      .update({ estado: nuevoEstado })
      .eq('id', pedido.id)

    if (error) alert('Error al actualizar estado: ' + error.message)
    else recargarDatos()
  }

  async function eliminarPedido(id) {
    if (!navigator.onLine) return alert('Para eliminar un pedido necesitas conexión a internet.')
    if (!window.confirm('¿Eliminar este pedido permanentemente?')) return
    const { error } = await supabase.from('pedidos').delete().eq('id', id)
    if (error) alert('Error al eliminar: ' + error.message)
    else recargarDatos()
  }

  // --- EDICIÓN Y CREACIÓN DE PRODUCTOS (CON SOPORTE OFFLINE) ---
  function iniciarEdicion(prod) {
    setEditandoId(prod.id)
    setFormEdicion({ ...prod, tematica: prod.tematica || '' })
  }

  async function guardarEdicion() {
    const cambios = {
      codigo: formEdicion.codigo,
      nombre_producto: formEdicion.nombre_producto,
      categoria: formEdicion.categoria,
      tematica: formEdicion.categoria === 'PINES' ? (formEdicion.tematica || '').trim().toUpperCase() : '',
      cantidad: Number(formEdicion.cantidad),
      costo_produccion: Number(formEdicion.costo_produccion),
      precio_publico: Number(formEdicion.precio_publico),
      imagen_url: formEdicion.imagen_url
    }

    function editarEnModoOffline() {
      const actualizados = productos.map(p => p.id === editandoId ? { ...p, ...cambios } : p)
      setProductos(actualizados)
      guardarCacheLocal(STORAGE_KEYS.PRODUCTOS, actualizados)
      encolarAccionOffline({ tipo: 'EDITAR_PRODUCTO', payload: { id: editandoId, cambios } })
      setEditandoId(null)
    }

    if (!navigator.onLine) {
      editarEnModoOffline()
      return
    }

    const { error } = await supabase
      .from('productos')
      .update(cambios)
      .eq('id', editandoId)

    if (error) {
      editarEnModoOffline()
    } else {
      setEditandoId(null)
      recargarDatos()
    }
  }

  async function eliminarProducto(prod) {
    if (!navigator.onLine) return alert('Para eliminar productos permanentemente necesitas conexión a internet.')
    const confirmar = window.confirm(`¿Eliminar "${prod.nombre_producto}" del catálogo permanentemente?`)
    if (!confirmar) return

    const { error } = await supabase.from('productos').delete().eq('id', prod.id)
    if (error) alert('Error al eliminar: ' + error.message)
    else recargarDatos()
  }

  async function crearProducto(e) {
    e.preventDefault()
    if (!nuevoProd.nombre_producto || !nuevoProd.precio_publico) {
      return alert('Por favor completa el nombre y el precio al público.')
    }

    const payloadProd = {
      id: crypto.randomUUID(),
      codigo: nuevoProd.codigo,
      nombre_producto: nuevoProd.nombre_producto,
      categoria: nuevoProd.categoria,
      tematica: nuevoProd.categoria === 'PINES' ? (nuevoProd.tematica || '').trim().toUpperCase() : '',
      cantidad: Number(nuevoProd.cantidad) || 0,
      costo_produccion: Number(nuevoProd.costo_produccion) || 0,
      precio_publico: Number(nuevoProd.precio_publico) || 0,
      imagen_url: nuevoProd.imagen_url,
      created_at: new Date().toISOString()
    }

    function crearProdModoOffline() {
      const actualizados = [...productos, payloadProd].sort((a, b) => a.nombre_producto.localeCompare(b.nombre_producto))
      setProductos(actualizados)
      guardarCacheLocal(STORAGE_KEYS.PRODUCTOS, actualizados)
      encolarAccionOffline({ tipo: 'CREAR_PRODUCTO', payload: payloadProd })
      alert('¡Producto guardado en la tablet (Modo Offline)! Se subirá a la nube al conectar a internet.')
      setNuevoProd({
        codigo: '', nombre_producto: '', categoria: 'CADENAS-COLLARES', tematica: '',
        cantidad: 1, costo_produccion: '', precio_publico: '', imagen_url: ''
      })
      setVistaActiva('inventario')
    }

    if (!navigator.onLine) {
      crearProdModoOffline()
      return
    }

    const { error } = await supabase.from('productos').insert([payloadProd])

    if (error) {
      crearProdModoOffline()
    } else {
      alert('¡Producto agregado al catálogo!')
      setNuevoProd({
        codigo: '', nombre_producto: '', categoria: 'CADENAS-COLLARES', tematica: '',
        cantidad: 1, costo_produccion: '', precio_publico: '', imagen_url: ''
      })
      recargarDatos()
      setVistaActiva('inventario')
    }
  }

  function agregarReglaPromo() {
    setNuevaPromo(prev => ({
      ...prev,
      reglas: [...prev.reglas, { cantidad: '', precio_total: '' }]
    }))
  }

  function actualizarReglaPromo(index, campo, valor) {
    setNuevaPromo(prev => ({
      ...prev,
      reglas: prev.reglas.map((r, i) => i === index ? { ...r, [campo]: valor } : r)
    }))
  }

  function quitarReglaPromo(index) {
    setNuevaPromo(prev => ({
      ...prev,
      reglas: prev.reglas.filter((_, i) => i !== index)
    }))
  }

  async function guardarPromocion(e) {
    e.preventDefault()
    if (!nuevaPromo.nombre) return alert('Escribe un nombre para la promoción.')
    if (nuevaPromo.tipo_aplicacion === 'PRODUCTO' && !nuevaPromo.producto_id) {
      return alert('Selecciona el producto al que aplica la promoción.')
    }

    const reglasLimpias = nuevaPromo.reglas
      .filter(r => Number(r.cantidad) > 0 && Number(r.precio_total) > 0)
      .map(r => ({ cantidad: Number(r.cantidad), precio_total: Number(r.precio_total) }))

    if (reglasLimpias.length === 0) {
      return alert('Agrega al menos una regla válida (ej. Cantidad: 2, Precio Total: 40).')
    }

    const { error } = await supabase.from('promociones').insert([{
      nombre: nuevaPromo.nombre,
      tipo_aplicacion: nuevaPromo.tipo_aplicacion,
      producto_id: nuevaPromo.tipo_aplicacion === 'PRODUCTO' ? nuevaPromo.producto_id : null,
      categoria: nuevaPromo.tipo_aplicacion === 'CATEGORIA' ? nuevaPromo.categoria : null,
      reglas: reglasLimpias,
      activa: true
    }])

    if (error) {
      alert('Error al guardar promoción: ' + error.message)
    } else {
      setNuevaPromo({
        nombre: '',
        tipo_aplicacion: 'PRODUCTO',
        producto_id: '',
        categoria: 'PINES',
        reglas: [{ cantidad: 2, precio_total: 40 }, { cantidad: 3, precio_total: 50 }]
      })
      recargarDatos()
    }
  }

  async function alternarEstadoPromo(promo) {
    await supabase.from('promociones').update({ activa: !promo.activa }).eq('id', promo.id)
    recargarDatos()
  }

  async function eliminarPromo(id) {
    if (!window.confirm('¿Eliminar esta promoción?')) return
    await supabase.from('promociones').delete().eq('id', id)
    recargarDatos()
  }

  const productosFiltrados = productos.filter(p => {
    const coincideCat = categoriaFiltro === 'TODAS' || p.categoria === categoriaFiltro
    const coincideTematica = categoriaFiltro !== 'PINES' || tematicaFiltro === 'TODAS' || 
                             (p.tematica && p.tematica.toUpperCase() === tematicaFiltro)
    const coincideTexto = p.nombre_producto.toLowerCase().includes(busqueda.toLowerCase()) ||
                          (p.codigo && p.codigo.toLowerCase().includes(busqueda.toLowerCase())) ||
                          (p.tematica && p.tematica.toLowerCase().includes(busqueda.toLowerCase()))
    const pasaFiltroStock = vistaActiva === 'ventas' && ocultarAgotados ? p.cantidad > 0 : true
    return coincideCat && coincideTematica && coincideTexto && pasaFiltroStock
  })

  const cortesPorDia = ventas.reduce((acc, venta) => {
    const fechaObj = new Date(venta.created_at)
    const fechaKey = fechaObj.toLocaleDateString('es-MX', {
      year: 'numeric', month: '2-digit', day: '2-digit'
    })
    const fechaLegible = fechaObj.toLocaleDateString('es-MX', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    })

    if (!acc[fechaKey]) {
      acc[fechaKey] = {
        fechaKey,
        fechaLegible,
        totalVendido: 0,
        gananciaTotal: 0,
        efectivo: 0,
        transferencia: 0,
        tarjeta: 0,
        tickets: []
      }
    }

    const monto = Number(venta.total || 0)
    acc[fechaKey].totalVendido += monto
    acc[fechaKey].gananciaTotal += Number(venta.ganancia_neta || 0)
    if (venta.metodo_pago === 'Efectivo') acc[fechaKey].efectivo += monto
    if (venta.metodo_pago === 'Transferencia') acc[fechaKey].transferencia += monto
    if (venta.metodo_pago === 'Tarjeta') acc[fechaKey].tarjeta += monto
    acc[fechaKey].tickets.push(venta)

    return acc
  }, {})

  const listaCortes = Object.values(cortesPorDia)

  const analiticas = (() => {
    const mapaProductos = {}
    const mapaCategorias = {}

    productos.forEach(p => {
      mapaProductos[p.id] = {
        id: p.id,
        nombre: p.nombre_producto,
        categoria: p.categoria,
        tematica: p.tematica || '',
        stockActual: Number(p.cantidad || 0),
        costoUnitario: Number(p.costo_produccion || 0),
        precioPublico: Number(p.precio_publico || 0),
        unidadesVendidas: 0,
        ingresosBrutos: 0,
        gananciaEstimada: 0
      }
    })

    ventas.forEach(v => {
      ;(v.items || []).forEach(item => {
        const cant = Number(item.qty || 0)
        const sub = Number(item.subtotal || 0)
        const costo = Number(item.costo_unitario || 0) * cant
        const util = sub - costo

        if (!mapaProductos[item.id]) {
          mapaProductos[item.id] = {
            id: item.id,
            nombre: item.nombre_producto,
            categoria: item.categoria || 'PEDIDOS ESPECIALES',
            tematica: item.tematica || '',
            stockActual: 0,
            costoUnitario: Number(item.costo_unitario || 0),
            precioPublico: Number(item.precio_unitario || 0),
            unidadesVendidas: 0,
            ingresosBrutos: 0,
            gananciaEstimada: 0,
            esPedido: Boolean(item.es_pedido)
          }
        }

        mapaProductos[item.id].unidadesVendidas += cant
        mapaProductos[item.id].ingresosBrutos += sub
        mapaProductos[item.id].gananciaEstimada += util

        const catKey = mapaProductos[item.id].categoria || 'SIN CATEGORÍA'
        if (!mapaCategorias[catKey]) {
          mapaCategorias[catKey] = { categoria: catKey, unidades: 0, ingresos: 0, ganancia: 0 }
        }
        mapaCategorias[catKey].unidades += cant
        mapaCategorias[catKey].ingresos += sub
        mapaCategorias[catKey].ganancia += util
      })
    })

    const listaProds = Object.values(mapaProductos)
    const topMasVendidos = [...listaProds]
      .filter(p => p.unidadesVendidas > 0 && !p.esPedido)
      .sort((a, b) => b.unidadesVendidas - a.unidadesVendidas)
      .slice(0, 10)

    const urgenteResurtir = [...listaProds]
      .filter(p => p.unidadesVendidas > 0 && p.stockActual <= 1 && !p.esPedido)
      .sort((a, b) => b.unidadesVendidas - a.unidadesVendidas)

    const huesoSinRotacion = [...listaProds]
      .filter(p => p.unidadesVendidas === 0 && p.stockActual >= 2 && !p.esPedido)
      .sort((a, b) => b.stockActual - a.stockActual)

    const resumenCategorias = Object.values(mapaCategorias).sort((a, b) => b.ganancia - a.ganancia)

    const valorInventarioCosto = productos.reduce((sum, p) => sum + (Number(p.costo_produccion || 0) * Math.max(0, Number(p.cantidad || 0))), 0)
    const valorInventarioVenta = productos.reduce((sum, p) => sum + (Number(p.precio_publico || 0) * Math.max(0, Number(p.cantidad || 0))), 0)

    return {
      topMasVendidos,
      urgenteResurtir,
      huesoSinRotacion,
      resumenCategorias,
      valorInventarioCosto,
      valorInventarioVenta
    }
  })()

  function obtenerEtiquetaPromo(prod) {
    const promo = promociones.find(
      pr => pr.activa && (
        (pr.tipo_aplicacion === 'PRODUCTO' && pr.producto_id === prod.id) ||
        (pr.tipo_aplicacion === 'CATEGORIA' && pr.categoria === prod.categoria)
      )
    )
    if (!promo || !promo.reglas || promo.reglas.length === 0) return null
    return promo.reglas.map(r => `${r.cantidad}x$${r.precio_total}`).join(' • ')
  }

  return (
    <div className="flex h-screen overflow-hidden bg-destellos-pink">
      
      {/* SIDEBAR DE NAVEGACIÓN */}
      <aside className="w-20 md:w-56 bg-white border-r border-pink-100 flex flex-col justify-between shadow-sm z-10">
        <div className="overflow-y-auto">
          <div className="p-4 flex items-center justify-center md:justify-start gap-2 border-b border-pink-100">
            <div className="w-10 h-10 rounded-full bg-destellos-lilac flex items-center justify-center text-white font-bold shadow-inner shrink-0">
              <Sparkles size={20} />
            </div>
            <div className="hidden md:block">
              <h1 className="font-bold text-base leading-tight text-destellos-dark">Destellos de Oro</h1>
              <span className="text-xs text-destellos-gold font-medium">Punto de Venta</span>
            </div>
          </div>

          <nav className="p-2 space-y-1 mt-2">
            <button
              onClick={() => setVistaActiva('ventas')}
              className={`w-full flex items-center justify-center md:justify-start gap-3 p-2.5 rounded-xl font-medium transition-all cursor-pointer ${
                vistaActiva === 'ventas' 
                  ? 'bg-destellos-lilac text-purple-950 shadow-sm font-semibold' 
                  : 'text-gray-600 hover:bg-pink-50'
              }`}
            >
              <ShoppingBag size={19} />
              <span className="hidden md:inline text-sm">Ventas (POS)</span>
            </button>

            <button
              onClick={() => setVistaActiva('inventario')}
              className={`w-full flex items-center justify-center md:justify-start gap-3 p-2.5 rounded-xl font-medium transition-all cursor-pointer ${
                vistaActiva === 'inventario' 
                  ? 'bg-destellos-lilac text-purple-950 shadow-sm font-semibold' 
                  : 'text-gray-600 hover:bg-pink-50'
              }`}
            >
              <Package size={19} />
              <span className="hidden md:inline text-sm">Inventario</span>
            </button>

            <button
              onClick={() => setVistaActiva('agregar')}
              className={`w-full flex items-center justify-center md:justify-start gap-3 p-2.5 rounded-xl font-medium transition-all cursor-pointer ${
                vistaActiva === 'agregar' 
                  ? 'bg-destellos-lilac text-purple-950 shadow-sm font-semibold' 
                  : 'text-gray-600 hover:bg-pink-50'
              }`}
            >
              <PlusCircle size={19} />
              <span className="hidden md:inline text-sm">Agregar Prod.</span>
            </button>

            <button
              onClick={() => setVistaActiva('promociones')}
              className={`w-full flex items-center justify-center md:justify-start gap-3 p-2.5 rounded-xl font-medium transition-all cursor-pointer ${
                vistaActiva === 'promociones' 
                  ? 'bg-destellos-lilac text-purple-950 shadow-sm font-semibold' 
                  : 'text-gray-600 hover:bg-pink-50'
              }`}
            >
              <Tag size={19} />
              <span className="hidden md:inline text-sm">Promociones</span>
            </button>

            <div className="pt-2 my-2 border-t border-pink-100 space-y-1">
              <button
                onClick={() => setVistaActiva('calendario')}
                className={`w-full flex items-center justify-center md:justify-start gap-3 p-2.5 rounded-xl font-medium transition-all cursor-pointer ${
                  vistaActiva === 'calendario' 
                    ? 'bg-destellos-lilac text-purple-950 shadow-sm font-semibold' 
                    : 'text-gray-600 hover:bg-pink-50'
                }`}
              >
                <Calendar size={19} />
                <span className="hidden md:inline text-sm">Calendario Entregas</span>
              </button>

              <button
                onClick={() => setVistaActiva('pedidos')}
                className={`w-full flex items-center justify-center md:justify-start gap-3 p-2.5 rounded-xl font-medium transition-all cursor-pointer ${
                  vistaActiva === 'pedidos' 
                    ? 'bg-destellos-lilac text-purple-950 shadow-sm font-semibold' 
                    : 'text-gray-600 hover:bg-pink-50'
                }`}
              >
                <ClipboardList size={19} />
                <span className="hidden md:inline text-sm">Registrar Pedido</span>
              </button>

              <button
                onClick={() => setVistaActiva('tickets')}
                className={`w-full flex items-center justify-center md:justify-start gap-3 p-2.5 rounded-xl font-medium transition-all cursor-pointer ${
                  vistaActiva === 'tickets' 
                    ? 'bg-destellos-lilac text-purple-950 shadow-sm font-semibold' 
                    : 'text-gray-600 hover:bg-pink-50'
                }`}
              >
                <Receipt size={19} />
                <span className="hidden md:inline text-sm">Tickets</span>
              </button>

              <button
                onClick={() => setVistaActiva('cortes')}
                className={`w-full flex items-center justify-center md:justify-start gap-3 p-2.5 rounded-xl font-medium transition-all cursor-pointer ${
                  vistaActiva === 'cortes' 
                    ? 'bg-destellos-lilac text-purple-950 shadow-sm font-semibold' 
                    : 'text-gray-600 hover:bg-pink-50'
                }`}
              >
                <BarChart3 size={19} />
                <span className="hidden md:inline text-sm">Cortes de Caja</span>
              </button>

              <button
                onClick={() => setVistaActiva('analiticas')}
                className={`w-full flex items-center justify-center md:justify-start gap-3 p-2.5 rounded-xl font-medium transition-all cursor-pointer ${
                  vistaActiva === 'analiticas' 
                    ? 'bg-destellos-lilac text-purple-950 shadow-sm font-semibold' 
                    : 'text-gray-600 hover:bg-pink-50'
                }`}
              >
                <TrendingUp size={19} />
                <span className="hidden md:inline text-sm">Analíticas / Surtir</span>
              </button>
            </div>
          </nav>
        </div>

        {/* ESTADO DE CONEXIÓN Y COLA OFFLINE EN EL MALECÓN */}
        <div className="p-2.5 border-t border-pink-100 space-y-2">
          <div className={`p-2 rounded-xl text-xs font-bold flex items-center justify-center md:justify-start gap-2 ${
            esOnline ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-amber-50 text-amber-900 border border-amber-200'
          }`}>
            {esOnline ? <Wifi size={15} className="shrink-0" /> : <WifiOff size={15} className="shrink-0" />}
            <div className="hidden md:block leading-tight">
              <span>{esOnline ? 'En línea' : 'Modo Offline'}</span>
              {colaOffline.length > 0 && (
                <span className="block text-[10px] font-normal">
                  {colaOffline.length} {colaOffline.length === 1 ? 'cambio pendiente' : 'cambios pendientes'}
                </span>
              )}
            </div>
          </div>

          <button 
            onClick={recargarDatos}
            className="w-full flex items-center justify-center gap-2 p-2 text-xs font-semibold text-gray-600 hover:text-destellos-dark hover:bg-pink-50 rounded-lg cursor-pointer"
          >
            {colaOffline.length > 0 ? (
              <CloudUpload size={15} className={sincronizando ? 'animate-bounce text-purple-700' : 'text-purple-700'} />
            ) : (
              <RefreshCw size={15} className={cargando || sincronizando ? 'animate-spin' : ''} />
            )}
            <span className="hidden md:inline">
              {sincronizando ? 'Subiendo datos...' : colaOffline.length > 0 ? `Subir Pendientes (${colaOffline.length})` : 'Sincronizar Datos'}
            </span>
          </button>
        </div>
      </aside>

      {/* CONTENIDO PRINCIPAL */}
      <main className="flex-1 flex overflow-hidden">
        
        {/* ==================== MÓDULO 1: VENTAS (POS) ==================== */}
        {vistaActiva === 'ventas' && (
          <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
            
            {/* IZQUIERDA: CARRITO / TICKET EN CURSO */}
            <div className="w-full md:w-5/12 lg:w-4/12 bg-white border-r border-pink-100 flex flex-col h-full shadow-sm">
              <div className="p-3.5 border-b border-pink-100 flex justify-between items-center bg-pink-50/40">
                <h2 className="font-bold text-base text-gray-800">Ticket en Curso</h2>
                {carrito.length > 0 && (
                  <button 
                    onClick={() => setCarrito([])}
                    className="text-xs text-red-500 hover:underline flex items-center gap-1 cursor-pointer"
                  >
                    <Trash2 size={14} /> Vaciar
                  </button>
                )}
              </div>

              <div className="flex-1 overflow-y-auto p-3 space-y-2">
                {carrito.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-gray-400 text-center p-4">
                    <ShoppingBag size={40} className="mb-2 opacity-30" />
                    <p className="text-sm">Toca cualquier producto del catálogo para agregarlo a la cuenta</p>
                  </div>
                ) : (
                  carrito.map(item => (
                    <div key={item.id} className="flex items-center justify-between p-2.5 bg-destellos-pink/60 rounded-xl border border-pink-100">
                      <div className="flex-1 pr-2">
                        <p className="font-semibold text-sm text-gray-800 leading-snug">{item.nombre_producto}</p>
                        <p className="text-xs text-gray-500">
                          ${item.precio_publico} c/u
                          {item.tematica ? ` • ${item.tematica}` : ''}
                        </p>
                      </div>
                      
                      <div className="flex items-center gap-2">
                        <button 
                          onClick={() => cambiarCantidadCarrito(item.id, -1, item.cantidad)}
                          className="w-7 h-7 rounded-lg bg-white border border-pink-200 font-bold text-gray-700 active:scale-95"
                        >-</button>
                        <span className="w-6 text-center font-bold text-sm">{item.qty}</span>
                        <button 
                          onClick={() => cambiarCantidadCarrito(item.id, 1, item.cantidad)}
                          className="w-7 h-7 rounded-lg bg-white border border-pink-200 font-bold text-gray-700 active:scale-95"
                        >+</button>
                      </div>

                      <div className="w-16 text-right font-bold text-sm text-gray-900">
                        ${(item.precio_publico * item.qty).toFixed(0)}
                      </div>
                    </div>
                  ))
                )}

                {calculoCarrito.detallePromosAplicadas.length > 0 && (
                  <div className="p-2.5 rounded-xl bg-emerald-50 border border-emerald-200 space-y-1">
                    <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-800">
                      <Tag size={13} /> Promociones aplicadas automáticamente:
                    </div>
                    {calculoCarrito.detallePromosAplicadas.map((p, idx) => (
                      <div key={idx} className="flex justify-between text-xs text-emerald-700">
                        <span>{p.nombre}</span>
                        <span className="font-bold">-${p.ahorro.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="p-3.5 border-t border-pink-200 bg-white space-y-2">
                <div>
                  <span className="block text-[11px] font-bold text-gray-500 mb-1">Método de Pago:</span>
                  <div className="grid grid-cols-3 gap-1.5">
                    {METODOS_PAGO.map(m => {
                      const Icono = m.icon
                      const activo = metodoPago === m.id
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => setMetodoPago(m.id)}
                          className={`flex flex-col items-center justify-center py-1.5 px-1 rounded-xl border text-xs font-bold transition-all cursor-pointer ${
                            activo 
                              ? 'bg-purple-50 border-purple-600 text-purple-900' 
                              : 'border-pink-100 text-gray-500 hover:bg-pink-50/50'
                          }`}
                        >
                          <Icono size={15} className="mb-0.5" />
                          {m.label}
                        </button>
                      )
                    })}
                  </div>
                </div>

                {calculoCarrito.descuentoPromociones > 0 && (
                  <div className="flex justify-between items-center text-xs text-emerald-700 font-semibold">
                    <span>Ahorro por Promoción:</span>
                    <span>-${calculoCarrito.descuentoPromociones.toFixed(2)}</span>
                  </div>
                )}

                <div className="flex justify-between items-center text-xs">
                  <span className="text-gray-500">Descuento Extra ($):</span>
                  <input 
                    type="number" 
                    min="0"
                    value={descuentoManual}
                    onChange={e => setDescuentoManual(e.target.value)}
                    className="w-24 border border-pink-200 rounded-lg px-2 py-1 text-right font-medium"
                  />
                </div>

                {metodoPago === 'Efectivo' && carrito.length > 0 && (
                  <div className="p-2.5 rounded-xl bg-pink-50/60 border border-pink-100 space-y-1.5">
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-gray-600 font-medium">Pago con ($):</span>
                      <input
                        type="number"
                        placeholder={calculoCarrito.totalFinal.toString()}
                        value={montoRecibido}
                        onChange={e => setMontoRecibido(e.target.value)}
                        className="w-24 bg-white border border-pink-200 rounded-lg px-2 py-1 text-right font-bold text-gray-800"
                      />
                    </div>
                    <div className="flex gap-1 justify-end">
                      {[50, 100, 200, 500].map(billete => (
                        <button
                          key={billete}
                          type="button"
                          onClick={() => setMontoRecibido(billete.toString())}
                          className="px-2 py-0.5 bg-white border border-pink-200 rounded text-[11px] font-bold text-purple-800 hover:bg-purple-50 cursor-pointer"
                        >
                          ${billete}
                        </button>
                      ))}
                    </div>
                    {Number(montoRecibido) >= calculoCarrito.totalFinal && (
                      <div className="flex justify-between items-center text-xs pt-1 border-t border-pink-100">
                        <span className="font-bold text-emerald-800">Cambio a devolver:</span>
                        <span className="font-extrabold text-sm text-emerald-700">${cambioCliente.toFixed(2)}</span>
                      </div>
                    )}
                  </div>
                )}

                <div className="flex justify-between items-baseline border-t border-pink-100 pt-1.5">
                  <span className="text-sm font-bold text-gray-700">Total a Cobrar:</span>
                  <span className="text-2xl font-extrabold text-purple-900">${calculoCarrito.totalFinal.toFixed(2)}</span>
                </div>

                <button
                  onClick={cobrarVenta}
                  disabled={carrito.length === 0 || procesandoVenta}
                  className="w-full py-3 rounded-xl bg-purple-700 hover:bg-purple-800 disabled:bg-gray-300 text-white font-bold text-base shadow-md active:scale-[0.99] transition-all cursor-pointer"
                >
                  {procesandoVenta ? 'Guardando...' : `Cobrar (${metodoPago})`}
                </button>
              </div>
            </div>

            {/* DERECHA: CATÁLOGO DE PRODUCTOS */}
            <div className="flex-1 flex flex-col h-full overflow-hidden p-4">
              <div className="space-y-2.5 mb-3">
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Search className="absolute left-3.5 top-3 text-gray-400" size={18} />
                    <input
                      type="text"
                      placeholder="Buscar por nombre, código o temática (ej. gatitos, hora de aventura)..."
                      value={busqueda}
                      onChange={e => setBusqueda(e.target.value)}
                      className="w-full pl-10 pr-4 py-2 bg-white border border-pink-200 rounded-xl text-sm shadow-xs focus:outline-none focus:ring-2 focus:ring-purple-200"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setOcultarAgotados(!ocultarAgotados)}
                    className={`px-3 py-2 rounded-xl text-xs font-bold border whitespace-nowrap transition-all cursor-pointer ${
                      ocultarAgotados
                        ? 'bg-emerald-700 text-white border-emerald-700'
                        : 'bg-white text-gray-600 border-pink-200 hover:bg-pink-50'
                    }`}
                  >
                    {ocultarAgotados ? '✓ Solo disponibles' : 'Ocultar agotados'}
                  </button>
                </div>

                <div className="flex gap-2 overflow-x-auto pb-1">
                  {CATEGORIAS.map(cat => (
                    <button
                      key={cat}
                      onClick={() => {
                        setCategoriaFiltro(cat)
                        setTematicaFiltro('TODAS')
                      }}
                      className={`px-3.5 py-1.5 rounded-full text-xs font-bold whitespace-nowrap transition-all cursor-pointer ${
                        categoriaFiltro === cat
                          ? 'bg-purple-800 text-white shadow-xs'
                          : 'bg-white text-gray-600 border border-pink-200 hover:bg-pink-50'
                      }`}
                    >
                      {cat}
                    </button>
                  ))}
                </div>

                {categoriaFiltro === 'PINES' && (
                  <div className="flex items-center gap-1.5 overflow-x-auto py-1 px-2.5 bg-purple-50/70 rounded-xl border border-purple-100">
                    <span className="text-[11px] font-bold text-purple-800 flex items-center gap-1 mr-1 shrink-0">
                      <Layers size={13} /> Temática:
                    </span>
                    <button
                      onClick={() => setTematicaFiltro('TODAS')}
                      className={`px-2.5 py-1 rounded-lg text-[11px] font-bold cursor-pointer ${
                        tematicaFiltro === 'TODAS' ? 'bg-purple-700 text-white' : 'bg-white text-purple-800'
                      }`}
                    >
                      TODAS
                    </button>
                    {tematicasPines.length === 0 ? (
                      <span className="text-[11px] text-gray-400 italic">(Sin temáticas asignadas)</span>
                    ) : (
                      tematicasPines.map(tem => (
                        <button
                          key={tem}
                          onClick={() => setTematicaFiltro(tem)}
                          className={`px-2.5 py-1 rounded-lg text-[11px] font-bold whitespace-nowrap cursor-pointer ${
                            tematicaFiltro === tem ? 'bg-purple-700 text-white' : 'bg-white text-purple-800 hover:bg-purple-100'
                          }`}
                        >
                          {tem}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>

              <div className="flex-1 overflow-y-auto pr-1">
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                  {productosFiltrados.map(prod => {
                    const agotado = prod.cantidad <= 0
                    const etiquetaPromo = obtenerEtiquetaPromo(prod)
                    return (
                      <div
                        key={prod.id}
                        onClick={() => !agotado && agregarAlCarrito(prod)}
                        className={`bg-white p-3.5 rounded-2xl border flex flex-col justify-between transition-all select-none ${
                          agotado 
                            ? 'opacity-55 border-gray-200 cursor-not-allowed' 
                            : 'border-pink-100 hover:border-purple-300 shadow-xs active:scale-95 cursor-pointer'
                        }`}
                      >
                        <div>
                          <div className="flex justify-between items-start gap-1 mb-1">
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-pink-50 text-purple-800">
                              {prod.codigo || prod.categoria.slice(0, 6)}
                            </span>
                            {prod.imagen_url && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setImagenExpandidaId(imagenExpandidaId === prod.id ? null : prod.id)
                                }}
                                className="text-gray-400 hover:text-purple-700 p-0.5"
                                title="Ver foto de apoyo"
                              >
                                <Eye size={15} />
                              </button>
                            )}
                          </div>

                          <h3 className="font-semibold text-sm text-gray-800 line-clamp-2 my-1">
                            {prod.nombre_producto}
                          </h3>

                          {prod.tematica && (
                            <span className="inline-block text-[10px] font-bold px-2 py-0.5 rounded-full bg-purple-100 text-purple-800 mb-1">
                              ✨ {prod.tematica}
                            </span>
                          )}

                          {etiquetaPromo && (
                            <div className="text-[10px] font-extrabold px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200 inline-block mb-1">
                              🏷️ {etiquetaPromo}
                            </div>
                          )}

                          {imagenExpandidaId === prod.id && prod.imagen_url && (
                            <img 
                              src={prod.imagen_url} 
                              alt={prod.nombre_producto} 
                              className="w-full h-24 object-cover rounded-lg my-1.5 border border-pink-100"
                            />
                          )}
                        </div>

                        <div className="mt-2 pt-2 border-t border-pink-50 flex items-center justify-between">
                          <span className="font-extrabold text-base text-gray-900">
                            ${prod.precio_publico}
                          </span>
                          <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
                            agotado 
                              ? 'bg-red-100 text-red-700' 
                              : prod.cantidad <= 2 
                                ? 'bg-amber-100 text-amber-800' 
                                : 'bg-emerald-100 text-emerald-800'
                          }`}>
                            {agotado ? 'AGOTADO' : `${prod.cantidad} disp.`}
                          </span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ==================== MÓDULO 2: INVENTARIO ==================== */}
        {vistaActiva === 'inventario' && (
          <div className="flex-1 flex flex-col p-4 md:p-6 overflow-hidden">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-4">
              <div>
                <h2 className="text-2xl font-bold text-gray-800">Control de Inventario</h2>
                <p className="text-xs text-gray-500">Modifica precios, existencias, temáticas de pines o fotos para Jazmín</p>
              </div>

              <div className="flex flex-wrap gap-2">
                <input
                  type="text"
                  placeholder="Buscar producto o temática..."
                  value={busqueda}
                  onChange={e => setBusqueda(e.target.value)}
                  className="px-3 py-2 bg-white border border-pink-200 rounded-xl text-sm"
                />
                <select
                  value={categoriaFiltro}
                  onChange={e => {
                    setCategoriaFiltro(e.target.value)
                    setTematicaFiltro('TODAS')
                  }}
                  className="px-3 py-2 bg-white border border-pink-200 rounded-xl text-sm font-medium"
                >
                  {CATEGORIAS.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                {categoriaFiltro === 'PINES' && (
                  <select
                    value={tematicaFiltro}
                    onChange={e => setTematicaFiltro(e.target.value)}
                    className="px-3 py-2 bg-purple-50 border border-purple-200 text-purple-900 rounded-xl text-sm font-bold"
                  >
                    <option value="TODAS">Todas las temáticas</option>
                    {tematicasPines.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto bg-white rounded-2xl border border-pink-100 shadow-xs">
              <table className="w-full text-left border-collapse text-sm">
                <thead className="bg-pink-50/70 text-gray-600 text-xs uppercase sticky top-0">
                  <tr>
                    <th className="p-3">Código</th>
                    <th className="p-3">Producto</th>
                    <th className="p-3">Categoría / Temática</th>
                    <th className="p-3 text-center">Stock</th>
                    <th className="p-3 text-right">Costo</th>
                    <th className="p-3 text-right">Precio</th>
                    <th className="p-3 text-right">Ganancia</th>
                    <th className="p-3 text-center">Foto</th>
                    <th className="p-3 text-center">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-pink-50">
                  {productosFiltrados.map(prod => {
                    const enEdicion = editandoId === prod.id
                    const ganancia = Number(prod.precio_publico) - Number(prod.costo_produccion)
                    const mostrarFoto = imagenExpandidaId === prod.id

                    return (
                      <Fragment key={prod.id}>
                        <tr className="hover:bg-pink-50/30">
                          <td className="p-3 font-mono text-xs">
                            {enEdicion ? (
                              <input 
                                value={formEdicion.codigo || ''} 
                                onChange={e => setFormEdicion({...formEdicion, codigo: e.target.value})}
                                className="w-20 border rounded px-1.5 py-1"
                              />
                            ) : (prod.codigo || '-')}
                          </td>
                          <td className="p-3 font-medium text-gray-800">
                            {enEdicion ? (
                              <input 
                                value={formEdicion.nombre_producto} 
                                onChange={e => setFormEdicion({...formEdicion, nombre_producto: e.target.value})}
                                className="w-full border rounded px-2 py-1"
                              />
                            ) : prod.nombre_producto}
                          </td>
                          <td className="p-3 text-xs">
                            {enEdicion ? (
                              <div className="space-y-1">
                                <select
                                  value={formEdicion.categoria}
                                  onChange={e => setFormEdicion({...formEdicion, categoria: e.target.value})}
                                  className="border rounded px-1.5 py-1 w-full"
                                >
                                  {CATEGORIAS.filter(c => c !== 'TODAS').map(c => (
                                    <option key={c} value={c}>{c}</option>
                                  ))}
                                </select>
                                {formEdicion.categoria === 'PINES' && (
                                  <input
                                    type="text"
                                    list="lista-tematicas"
                                    placeholder="Temática (ej. GATITOS)"
                                    value={formEdicion.tematica || ''}
                                    onChange={e => setFormEdicion({...formEdicion, tematica: e.target.value})}
                                    className="border border-purple-300 rounded px-1.5 py-1 w-full text-purple-900 font-semibold"
                                  />
                                )}
                              </div>
                            ) : (
                              <div className="flex flex-wrap items-center gap-1">
                                <span className="px-2 py-0.5 rounded-full bg-purple-50 text-purple-800 font-semibold">
                                  {prod.categoria}
                                </span>
                                {prod.tematica && (
                                  <span className="px-2 py-0.5 rounded-full bg-pink-100 text-pink-900 font-bold text-[11px]">
                                    {prod.tematica}
                                  </span>
                                )}
                              </div>
                            )}
                          </td>
                          <td className="p-3 text-center">
                            {enEdicion ? (
                              <input 
                                type="number"
                                value={formEdicion.cantidad} 
                                onChange={e => setFormEdicion({...formEdicion, cantidad: e.target.value})}
                                className="w-16 border rounded px-1.5 py-1 text-center font-bold"
                              />
                            ) : (
                              <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${
                                prod.cantidad <= 0 ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-800'
                              }`}>
                                {prod.cantidad <= 0 ? 'AGOTADO' : prod.cantidad}
                              </span>
                            )}
                          </td>
                          <td className="p-3 text-right text-gray-500">
                            {enEdicion ? (
                              <input 
                                type="number"
                                value={formEdicion.costo_produccion} 
                                onChange={e => setFormEdicion({...formEdicion, costo_produccion: e.target.value})}
                                className="w-20 border rounded px-1.5 py-1 text-right"
                              />
                            ) : `$${prod.costo_produccion}`}
                          </td>
                          <td className="p-3 text-right font-bold text-gray-900">
                            {enEdicion ? (
                              <input 
                                type="number"
                                value={formEdicion.precio_publico} 
                                onChange={e => setFormEdicion({...formEdicion, precio_publico: e.target.value})}
                                className="w-20 border rounded px-1.5 py-1 text-right font-bold"
                              />
                            ) : `$${prod.precio_publico}`}
                          </td>
                          <td className="p-3 text-right font-semibold text-emerald-700">
                            ${ganancia.toFixed(0)}
                          </td>
                          <td className="p-3 text-center">
                            <button
                              onClick={() => setImagenExpandidaId(mostrarFoto ? null : prod.id)}
                              className={`p-1.5 rounded-lg border transition-colors cursor-pointer ${
                                prod.imagen_url 
                                  ? 'border-purple-200 text-purple-700 hover:bg-purple-50' 
                                  : 'border-gray-200 text-gray-400 hover:bg-gray-50'
                              }`}
                              title="Ver / Editar imagen de apoyo"
                            >
                              {mostrarFoto ? <EyeOff size={16} /> : <Eye size={16} />}
                            </button>
                          </td>
                          <td className="p-3 text-center">
                            {enEdicion ? (
                              <div className="flex items-center justify-center gap-1">
                                <button onClick={guardarEdicion} className="p-1.5 bg-emerald-600 text-white rounded-lg cursor-pointer">
                                  <Check size={16} />
                                </button>
                                <button onClick={() => setEditandoId(null)} className="p-1.5 bg-gray-200 text-gray-700 rounded-lg cursor-pointer">
                                  <X size={16} />
                                </button>
                              </div>
                            ) : (
                              <div className="flex items-center justify-center gap-1">
                                <button 
                                  onClick={() => iniciarEdicion(prod)}
                                  className="p-1.5 text-gray-500 hover:text-purple-800 hover:bg-purple-50 rounded-lg cursor-pointer"
                                  title="Editar producto"
                                >
                                  <Edit2 size={16} />
                                </button>
                                <button 
                                  onClick={() => eliminarProducto(prod)}
                                  className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg cursor-pointer"
                                  title="Eliminar producto"
                                >
                                  <Trash2 size={16} />
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>

                        {mostrarFoto && (
                          <tr className="bg-pink-50/40">
                            <td colSpan="9" className="p-4">
                              <div className="flex flex-col sm:flex-row items-center gap-4">
                                {prod.imagen_url ? (
                                  <img 
                                    src={prod.imagen_url} 
                                    alt={prod.nombre_producto} 
                                    className="w-36 h-36 object-cover rounded-xl border-2 border-white shadow-sm"
                                  />
                                ) : (
                                  <div className="w-36 h-36 rounded-xl bg-white border border-dashed border-pink-300 flex flex-col items-center justify-center text-xs text-gray-400 p-2 text-center">
                                    Sin foto asignada
                                  </div>
                                )}
                                <div className="space-y-2 flex-1">
                                  <p className="font-bold text-sm text-gray-800">Imagen de apoyo visual: {prod.nombre_producto}</p>
                                  <div className="flex flex-wrap items-center gap-2">
                                    <label className="px-3 py-1.5 bg-purple-700 hover:bg-purple-800 text-white rounded-lg text-xs font-semibold cursor-pointer flex items-center gap-1.5">
                                      <Camera size={14} />
                                      {subiendoImagen ? 'Subiendo...' : 'Cámara'}
                                      <input 
                                        type="file" 
                                        accept="image/*" 
                                        capture="environment"
                                        className="hidden"
                                        onChange={async (e) => {
                                          const url = await comprimirYSubirImagen(e.target.files[0])
                                          if (url) {
                                            await supabase.from('productos').update({ imagen_url: url }).eq('id', prod.id)
                                            recargarDatos()
                                          }
                                        }}
                                      />
                                    </label>

                                    <label className="px-3 py-1.5 bg-destellos-lilac hover:bg-purple-200 text-purple-950 rounded-lg text-xs font-semibold cursor-pointer flex items-center gap-1.5">
                                      <Image size={14} />
                                      {subiendoImagen ? 'Subiendo...' : 'Galería'}
                                      <input 
                                        type="file" 
                                        accept="image/*"
                                        className="hidden"
                                        onChange={async (e) => {
                                          const url = await comprimirYSubirImagen(e.target.files[0])
                                          if (url) {
                                            await supabase.from('productos').update({ imagen_url: url }).eq('id', prod.id)
                                            recargarDatos()
                                          }
                                        }}
                                      />
                                    </label>

                                    <input 
                                      type="text"
                                      placeholder="O pega el link de una imagen aquí..."
                                      defaultValue={prod.imagen_url || ''}
                                      onBlur={async (e) => {
                                        if (e.target.value !== prod.imagen_url) {
                                          await supabase.from('productos').update({ imagen_url: e.target.value }).eq('id', prod.id)
                                          recargarDatos()
                                        }
                                      }}
                                      className="px-3 py-1.5 bg-white border border-pink-200 rounded-lg text-xs flex-1 min-w-[200px]"
                                    />
                                  </div>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ==================== MÓDULO 3: AGREGAR PRODUCTO ==================== */}
        {vistaActiva === 'agregar' && (
          <div className="flex-1 overflow-y-auto p-6 flex justify-center items-start">
            <form onSubmit={crearProducto} className="w-full max-w-lg bg-white p-6 rounded-2xl border border-pink-100 shadow-sm space-y-4">
              <h2 className="text-xl font-bold text-gray-800 border-b border-pink-100 pb-3">
                Registrar Nuevo Producto
              </h2>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-gray-600 mb-1">Código / ID (Opcional)</label>
                  <input
                    type="text"
                    placeholder="Ej. PIN-01"
                    value={nuevoProd.codigo}
                    onChange={e => setNuevoProd({...nuevoProd, codigo: e.target.value})}
                    className="w-full px-3 py-2 border border-pink-200 rounded-xl text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-600 mb-1">Categoría</label>
                  <select
                    value={nuevoProd.categoria}
                    onChange={e => setNuevoProd({...nuevoProd, categoria: e.target.value})}
                    className="w-full px-3 py-2 border border-pink-200 rounded-xl text-sm bg-white font-medium"
                  >
                    {CATEGORIAS.filter(c => c !== 'TODAS').map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
              </div>

              {nuevoProd.categoria === 'PINES' && (
                <div className="p-3.5 rounded-xl bg-purple-50/70 border border-purple-200">
                  <label className="block text-xs font-bold text-purple-900 mb-1">
                    Temática del Pin (ej. Flores, Gatitos, Hora de Aventura)
                  </label>
                  <input
                    type="text"
                    list="lista-tematicas"
                    placeholder="Escribe o selecciona una temática..."
                    value={nuevoProd.tematica}
                    onChange={e => setNuevoProd({...nuevoProd, tematica: e.target.value})}
                    className="w-full px-3 py-2 bg-white border border-purple-200 rounded-xl text-sm font-semibold text-purple-950"
                  />
                  <datalist id="lista-tematicas">
                    <option value="FLORES" />
                    <option value="GATITOS" />
                    <option value="HORA DE AVENTURA" />
                    <option value="ANIME" />
                    <option value="CARICATURAS" />
                    {tematicasPines.map(t => <option key={t} value={t} />)}
                  </datalist>
                </div>
              )}

              <div>
                <label className="block text-xs font-bold text-gray-600 mb-1">Nombre o Descripción del Producto *</label>
                <input
                  type="text"
                  required
                  placeholder="Ej. Pin BMO Hora de Aventura / Cadenita mariposa"
                  value={nuevoProd.nombre_producto}
                  onChange={e => setNuevoProd({...nuevoProd, nombre_producto: e.target.value})}
                  className="w-full px-3 py-2 border border-pink-200 rounded-xl text-sm"
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-bold text-gray-600 mb-1">Cantidad Inicial</label>
                  <input
                    type="number"
                    min="0"
                    value={nuevoProd.cantidad}
                    onChange={e => setNuevoProd({...nuevoProd, cantidad: e.target.value})}
                    className="w-full px-3 py-2 border border-pink-200 rounded-xl text-sm font-bold"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-600 mb-1">Costo Prod. ($)</label>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    value={nuevoProd.costo_produccion}
                    onChange={e => setNuevoProd({...nuevoProd, costo_produccion: e.target.value})}
                    className="w-full px-3 py-2 border border-pink-200 rounded-xl text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-600 mb-1">Precio Público ($) *</label>
                  <input
                    type="number"
                    step="0.01"
                    required
                    placeholder="25.00"
                    value={nuevoProd.precio_publico}
                    onChange={e => setNuevoProd({...nuevoProd, precio_publico: e.target.value})}
                    className="w-full px-3 py-2 border border-pink-200 rounded-xl text-sm font-bold text-purple-900"
                  />
                </div>
              </div>

              <div className="p-3 bg-pink-50/60 rounded-xl flex justify-between items-center text-sm">
                <span className="text-gray-600 font-medium">Ganancia Estimada por Pieza:</span>
                <span className="font-extrabold text-emerald-700">
                  ${(Number(nuevoProd.precio_publico || 0) - Number(nuevoProd.costo_produccion || 0)).toFixed(2)}
                </span>
              </div>

              <div className="space-y-2 pt-2 border-t border-pink-100">
                <label className="block text-xs font-bold text-gray-600">Foto de Apoyo (Opcional)</label>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="px-3.5 py-2 bg-purple-700 text-white rounded-xl text-xs font-bold cursor-pointer flex items-center gap-1.5">
                    <Camera size={15} />
                    {subiendoImagen ? 'Subiendo...' : 'Cámara'}
                    <input 
                      type="file" 
                      accept="image/*" 
                      capture="environment" 
                      className="hidden"
                      onChange={async (e) => {
                        const url = await comprimirYSubirImagen(e.target.files[0])
                        if (url) setNuevoProd({...nuevoProd, imagen_url: url})
                      }}
                    />
                  </label>

                  <label className="px-3.5 py-2 bg-destellos-lilac text-purple-950 rounded-xl text-xs font-bold cursor-pointer flex items-center gap-1.5">
                    <Image size={15} />
                    {subiendoImagen ? 'Subiendo...' : 'Galería'}
                    <input 
                      type="file" 
                      accept="image/*" 
                      className="hidden"
                      onChange={async (e) => {
                        const url = await comprimirYSubirImagen(e.target.files[0])
                        if (url) setNuevoProd({...nuevoProd, imagen_url: url})
                      }}
                    />
                  </label>

                  <input
                    type="text"
                    placeholder="O pega URL de imagen..."
                    value={nuevoProd.imagen_url}
                    onChange={e => setNuevoProd({...nuevoProd, imagen_url: e.target.value})}
                    className="flex-1 min-w-[160px] px-3 py-2 border border-pink-200 rounded-xl text-xs"
                  />
                </div>
                {nuevoProd.imagen_url && (
                  <img src={nuevoProd.imagen_url} alt="Preview" className="w-24 h-24 object-cover rounded-xl mt-2 border" />
                )}
              </div>

              <button
                type="submit"
                className="w-full py-3 bg-purple-700 hover:bg-purple-800 text-white font-bold rounded-xl shadow-md transition-all cursor-pointer mt-4"
              >
                Guardar en el Catálogo
              </button>
            </form>
          </div>
        )}

        {/* ==================== MÓDULO 4: PROMOCIONES AUTOMÁTICAS ==================== */}
        {vistaActiva === 'promociones' && (
          <div className="flex-1 overflow-y-auto p-4 md:p-6">
            <div className="mb-4">
              <h2 className="text-2xl font-bold text-gray-800">Promociones Automáticas</h2>
              <p className="text-xs text-gray-500">
                Configura ofertas como 2x$40 o 3x$50. El carrito calculará el descuento automáticamente al agregar los artículos.
              </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              <form onSubmit={guardarPromocion} className="lg:col-span-5 bg-white p-5 rounded-2xl border border-pink-100 shadow-xs space-y-4">
                <h3 className="font-bold text-base text-gray-800 border-b border-pink-100 pb-2">
                  Crear Nueva Promoción
                </h3>

                <div>
                  <label className="block text-xs font-bold text-gray-600 mb-1">Nombre de la Promo *</label>
                  <input
                    type="text"
                    required
                    placeholder="Ej. Promo Pines 2x$40 y 3x$50"
                    value={nuevaPromo.nombre}
                    onChange={e => setNuevaPromo({...nuevaPromo, nombre: e.target.value})}
                    className="w-full px-3 py-2 border border-pink-200 rounded-xl text-sm"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-gray-600 mb-1">¿Dónde aplica?</label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setNuevaPromo({...nuevaPromo, tipo_aplicacion: 'PRODUCTO'})}
                      className={`py-2 px-3 rounded-xl text-xs font-bold border cursor-pointer ${
                        nuevaPromo.tipo_aplicacion === 'PRODUCTO'
                          ? 'bg-purple-800 text-white border-purple-800'
                          : 'bg-white text-gray-600 border-pink-200'
                      }`}
                    >
                      Un Producto Específico
                    </button>
                    <button
                      type="button"
                      onClick={() => setNuevaPromo({...nuevaPromo, tipo_aplicacion: 'CATEGORIA'})}
                      className={`py-2 px-3 rounded-xl text-xs font-bold border cursor-pointer ${
                        nuevaPromo.tipo_aplicacion === 'CATEGORIA'
                          ? 'bg-purple-800 text-white border-purple-800'
                          : 'bg-white text-gray-600 border-pink-200'
                      }`}
                    >
                      Toda una Categoría
                    </button>
                  </div>
                </div>

                {nuevaPromo.tipo_aplicacion === 'PRODUCTO' ? (
                  <div>
                    <label className="block text-xs font-bold text-gray-600 mb-1">Selecciona el Artículo *</label>
                    <select
                      value={nuevaPromo.producto_id}
                      onChange={e => setNuevaPromo({...nuevaPromo, producto_id: e.target.value})}
                      className="w-full px-3 py-2 border border-pink-200 rounded-xl text-sm bg-white"
                    >
                      <option value="">-- Elige un producto --</option>
                      {productos.map(p => (
                        <option key={p.id} value={p.id}>
                          {p.nombre_producto} (Precio normal: ${p.precio_publico})
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs font-bold text-gray-600 mb-1">Selecciona la Categoría *</label>
                    <select
                      value={nuevaPromo.categoria}
                      onChange={e => setNuevaPromo({...nuevaPromo, categoria: e.target.value})}
                      className="w-full px-3 py-2 border border-pink-200 rounded-xl text-sm bg-white font-semibold"
                    >
                      {CATEGORIAS.filter(c => c !== 'TODAS').map(c => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="space-y-2 pt-2 border-t border-pink-100">
                  <div className="flex justify-between items-center">
                    <label className="text-xs font-bold text-gray-700">Escalas de Precio (Ej. 2 x $40, 3 x $50)</label>
                    <button
                      type="button"
                      onClick={agregarReglaPromo}
                      className="text-xs font-bold text-purple-700 hover:underline cursor-pointer"
                    >
                      + Agregar escala
                    </button>
                  </div>

                  {nuevaPromo.reglas.map((regla, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <div className="flex items-center gap-1.5 flex-1 bg-pink-50/50 p-2 rounded-xl border border-pink-100">
                        <input
                          type="number"
                          min="2"
                          placeholder="Cant (ej. 2)"
                          value={regla.cantidad}
                          onChange={e => actualizarReglaPromo(idx, 'cantidad', e.target.value)}
                          className="w-20 bg-white border border-pink-200 rounded-lg px-2 py-1 text-center font-bold text-sm"
                        />
                        <span className="text-xs font-bold text-gray-500">piezas por $</span>
                        <input
                          type="number"
                          step="0.01"
                          placeholder="Total (ej. 40)"
                          value={regla.precio_total}
                          onChange={e => actualizarReglaPromo(idx, 'precio_total', e.target.value)}
                          className="flex-1 bg-white border border-pink-200 rounded-lg px-2 py-1 font-bold text-purple-900 text-sm"
                        />
                      </div>
                      {nuevaPromo.reglas.length > 1 && (
                        <button
                          type="button"
                          onClick={() => quitarReglaPromo(idx)}
                          className="p-2 text-red-400 hover:text-red-600 cursor-pointer"
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                <button
                  type="submit"
                  className="w-full py-3 bg-purple-700 hover:bg-purple-800 text-white font-bold rounded-xl shadow-sm cursor-pointer"
                >
                  Guardar Promoción
                </button>
              </form>

              <div className="lg:col-span-7 space-y-3">
                <h3 className="font-bold text-base text-gray-800">Promociones Configuradas</h3>
                {promociones.length === 0 ? (
                  <div className="bg-white p-8 rounded-2xl border border-pink-100 text-center text-gray-400">
                    <Tag size={40} className="mx-auto mb-2 opacity-30" />
                    <p className="text-sm">No hay promociones registradas todavía.</p>
                  </div>
                ) : (
                  promociones.map(promo => {
                    const prodObj = productos.find(p => p.id === promo.producto_id)
                    return (
                      <div
                        key={promo.id}
                        className={`bg-white p-4 rounded-2xl border flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                          promo.activa ? 'border-pink-100' : 'border-gray-200 opacity-60'
                        }`}
                      >
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold ${
                              promo.activa ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-200 text-gray-600'
                            }`}>
                              {promo.activa ? 'ACTIVA' : 'PAUSADA'}
                            </span>
                            <h4 className="font-bold text-gray-800">{promo.nombre}</h4>
                          </div>

                          <p className="text-xs text-gray-500">
                            {promo.tipo_aplicacion === 'PRODUCTO'
                              ? `Producto: ${prodObj ? `${prodObj.nombre_producto} ($${prodObj.precio_publico} c/u)` : 'Producto eliminado'}`
                              : `Categoría completa: ${promo.categoria}`}
                          </p>

                          <div className="flex flex-wrap gap-1.5 pt-1">
                            {(promo.reglas || []).map((r, i) => (
                              <span key={i} className="px-2.5 py-1 rounded-lg bg-purple-50 text-purple-900 font-extrabold text-xs border border-purple-200">
                                {r.cantidad} x ${r.precio_total}
                              </span>
                            ))}
                          </div>
                        </div>

                        <div className="flex items-center gap-2 self-end sm:self-center">
                          <button
                            onClick={() => alternarEstadoPromo(promo)}
                            className="px-3 py-1.5 rounded-xl border border-pink-200 text-xs font-bold text-gray-700 hover:bg-pink-50 cursor-pointer"
                          >
                            {promo.activa ? 'Pausar' : 'Activar'}
                          </button>
                          <button
                            onClick={() => eliminarPromo(promo.id)}
                            className="p-2 text-red-500 hover:bg-red-50 rounded-xl cursor-pointer"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </div>
          </div>
        )}

        {/* ==================== MÓDULO 5: CALENDARIO DE ENTREGAS ==================== */}
        {vistaActiva === 'calendario' && (
          <div className="flex-1 flex flex-col p-4 md:p-6 overflow-hidden">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-4">
              <div>
                <h2 className="text-2xl font-bold text-gray-800">Calendario de Entregas</h2>
                <p className="text-xs text-gray-500">
                  Al marcar un pedido como entregado, se generará su ticket automáticamente y se sumará a las finanzas del día.
                </p>
              </div>
              <button
                onClick={() => setVistaActiva('pedidos')}
                className="px-4 py-2 bg-purple-700 hover:bg-purple-800 text-white rounded-xl text-xs font-bold shadow-xs cursor-pointer"
              >
                + Registrar Nuevo Pedido
              </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-3 pr-1">
              {pedidos.length === 0 ? (
                <div className="bg-white rounded-2xl p-10 text-center text-gray-400 border border-pink-100">
                  <Calendar size={48} className="mx-auto mb-2 opacity-30" />
                  <p>No hay pedidos por encargo programados en el calendario.</p>
                </div>
              ) : (
                pedidos.map(ped => {
                  const fechaEntrega = new Date(ped.fecha_entrega + 'T00:00:00')
                  const fechaLegible = fechaEntrega.toLocaleDateString('es-MX', {
                    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
                  })
                  const costo = Number(ped.costo_produccion || 0)
                  const precio = Number(ped.precio_acordado || 0)
                  const anticipo = Number(ped.anticipo || 0)
                  const resta = Math.max(0, precio - anticipo)
                  const ganancia = precio - costo

                  return (
                    <div 
                      key={ped.id} 
                      className={`bg-white p-4 rounded-2xl border shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-4 ${
                        ped.estado === 'ENTREGADO' 
                          ? 'border-emerald-200 bg-emerald-50/20 opacity-80' 
                          : ped.estado === 'CANCELADO' 
                            ? 'border-red-200 bg-red-50/20 opacity-60 line-through' 
                            : 'border-pink-100 hover:border-purple-300'
                      }`}
                    >
                      <div className="space-y-1.5 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-extrabold text-xs px-2.5 py-1 rounded-lg bg-purple-100 text-purple-900 flex items-center gap-1">
                            <Calendar size={13} /> {fechaLegible}
                          </span>
                          <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
                            ped.estado === 'ENTREGADO' ? 'bg-emerald-100 text-emerald-800' :
                            ped.estado === 'CANCELADO' ? 'bg-red-100 text-red-800' :
                            'bg-amber-100 text-amber-800'
                          }`}>
                            {ped.estado === 'ENTREGADO' ? '✓ ENTREGADO Y CONTABILIZADO' : ped.estado}
                          </span>
                          {ped.telefono && (
                            <span className="text-xs text-gray-500">📞 {ped.telefono}</span>
                          )}
                        </div>

                        <div>
                          <h4 className="font-extrabold text-base text-gray-800">{ped.cliente}</h4>
                          <p className="text-xs text-gray-600 bg-gray-50 p-2 rounded-xl border border-gray-100 mt-1">
                            {ped.descripcion_pedido}
                          </p>
                        </div>

                        <div className="flex flex-wrap gap-4 text-xs pt-1 text-gray-600">
                          <span>Precio Total: <strong>${precio.toFixed(2)}</strong></span>
                          <span>Anticipo: <strong className="text-purple-800">${anticipo.toFixed(2)}</strong></span>
                          <span>Resta liquidar: <strong className="text-red-600">${resta.toFixed(2)}</strong></span>
                          <span>Ganancia neta: <strong className="text-emerald-700">${ganancia.toFixed(2)}</strong></span>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 self-end md:self-center border-t md:border-t-0 pt-2 md:pt-0 border-pink-50">
                        {ped.estado === 'PENDIENTE' && (
                          <>
                            <select
                              value={metodoPagoPedidos[ped.id] || 'Efectivo'}
                              onChange={e => setMetodoPagoPedidos({...metodoPagoPedidos, [ped.id]: e.target.value})}
                              className="px-2.5 py-2 bg-pink-50/70 border border-pink-200 rounded-xl text-xs font-bold text-purple-950"
                              title="Método de pago con el que liquida"
                            >
                              <option value="Efectivo">Efectivo</option>
                              <option value="Transferencia">Transferencia</option>
                              <option value="Tarjeta">Tarjeta</option>
                            </select>

                            <button
                              onClick={() => completarYContabilizarPedido(ped)}
                              className="px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold cursor-pointer shadow-2xs"
                            >
                              ✓ Entregar y Cobrar
                            </button>
                          </>
                        )}
                        {ped.estado === 'ENTREGADO' && (
                          <button
                            onClick={() => cambiarEstadoPedido(ped, 'PENDIENTE')}
                            className="px-3 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-xl text-xs font-bold cursor-pointer"
                          >
                            Reabrir
                          </button>
                        )}
                        <button
                          onClick={() => eliminarPedido(ped.id)}
                          className="p-2 text-red-500 hover:bg-red-50 rounded-xl border border-red-100 cursor-pointer"
                          title="Eliminar pedido"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        )}

        {/* ==================== MÓDULO 6: REGISTRAR PEDIDO POR ENCARGO ==================== */}
        {vistaActiva === 'pedidos' && (
          <div className="flex-1 overflow-y-auto p-6 flex justify-center items-start">
            <form onSubmit={crearPedido} className="w-full max-w-lg bg-white p-6 rounded-2xl border border-pink-100 shadow-sm space-y-4">
              <h2 className="text-xl font-bold text-gray-800 border-b border-pink-100 pb-3 flex items-center gap-2">
                <ClipboardList size={22} className="text-purple-700" />
                Registrar Pedido por Encargo
              </h2>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-gray-600 mb-1">Nombre del Cliente *</label>
                  <input
                    type="text"
                    required
                    placeholder="Ej. Sofía Martínez"
                    value={nuevoPedido.cliente}
                    onChange={e => setNuevoPedido({...nuevoPedido, cliente: e.target.value})}
                    className="w-full px-3 py-2 border border-pink-200 rounded-xl text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-600 mb-1">Teléfono (Opcional)</label>
                  <input
                    type="text"
                    placeholder="Ej. 6871234567"
                    value={nuevoPedido.telefono}
                    onChange={e => setNuevoPedido({...nuevoPedido, telefono: e.target.value})}
                    className="w-full px-3 py-2 border border-pink-200 rounded-xl text-sm"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-600 mb-1">Descripción del Pedido (Detalles, diseño, colores) *</label>
                <textarea
                  required
                  rows="3"
                  placeholder="Ej. Pulsera de perlas con dije de mariposa dorada y letra M..."
                  value={nuevoPedido.descripcion_pedido}
                  onChange={e => setNuevoPedido({...nuevoPedido, descripcion_pedido: e.target.value})}
                  className="w-full px-3 py-2 border border-pink-200 rounded-xl text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-purple-900 mb-1">Fecha de Entrega Programada *</label>
                <input
                  type="date"
                  required
                  value={nuevoPedido.fecha_entrega}
                  onChange={e => setNuevoPedido({...nuevoPedido, fecha_entrega: e.target.value})}
                  className="w-full px-3 py-2 bg-purple-50/50 border border-purple-200 rounded-xl text-sm font-bold text-purple-950"
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-bold text-gray-600 mb-1">Costo Prod. ($)</label>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    value={nuevoPedido.costo_produccion}
                    onChange={e => setNuevoPedido({...nuevoPedido, costo_produccion: e.target.value})}
                    className="w-full px-3 py-2 border border-pink-200 rounded-xl text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-600 mb-1">Precio Total ($) *</label>
                  <input
                    type="number"
                    step="0.01"
                    required
                    placeholder="150.00"
                    value={nuevoPedido.precio_acordado}
                    onChange={e => setNuevoPedido({...nuevoPedido, precio_acordado: e.target.value})}
                    className="w-full px-3 py-2 border border-pink-200 rounded-xl text-sm font-bold text-purple-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-600 mb-1">Anticipo ($)</label>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="50.00"
                    value={nuevoPedido.anticipo}
                    onChange={e => setNuevoPedido({...nuevoPedido, anticipo: e.target.value})}
                    className="w-full px-3 py-2 border border-pink-200 rounded-xl text-sm font-bold text-emerald-700"
                  />
                </div>
              </div>

              <div className="p-3 bg-pink-50/60 rounded-xl flex justify-between items-center text-sm">
                <span className="text-gray-600 font-medium">Ganancia Neta Estimada:</span>
                <span className="font-extrabold text-emerald-700">
                  ${(Number(nuevoPedido.precio_acordado || 0) - Number(nuevoPedido.costo_produccion || 0)).toFixed(2)}
                </span>
              </div>

              <button
                type="submit"
                className="w-full py-3 bg-purple-700 hover:bg-purple-800 text-white font-bold rounded-xl shadow-md transition-all cursor-pointer mt-4"
              >
                Guardar Pedido en Calendario
              </button>
            </form>
          </div>
        )}

        {/* ==================== MÓDULO 7: TICKETS ==================== */}
        {vistaActiva === 'tickets' && (
          <div className="flex-1 flex flex-col p-4 md:p-6 overflow-hidden">
            <div className="mb-4">
              <h2 className="text-2xl font-bold text-gray-800">Historial de Tickets</h2>
              <p className="text-xs text-gray-500">Consulta todos los recibos de piso y pedidos entregados</p>
            </div>

            <div className="flex-1 overflow-y-auto space-y-3 pr-1">
              {ventas.length === 0 ? (
                <div className="bg-white rounded-2xl p-10 text-center text-gray-400 border border-pink-100">
                  <Receipt size={48} className="mx-auto mb-2 opacity-30" />
                  <p>Aún no hay tickets registrados.</p>
                </div>
              ) : (
                ventas.map(ticket => {
                  const fecha = new Date(ticket.created_at)
                  const esDePedido = (ticket.items || []).some(it => it.es_pedido)
                  return (
                    <div 
                      key={ticket.id} 
                      className="bg-white p-4 rounded-2xl border border-pink-100 shadow-2xs flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:border-purple-200 transition-all"
                    >
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-extrabold text-sm px-2.5 py-0.5 rounded-lg bg-purple-100 text-purple-900">
                            Ticket #{ticket.folio || ticket.id.slice(0, 5)}
                          </span>
                          {esDePedido && (
                            <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-purple-800 text-white">
                              📦 PEDIDO ENTREGADO
                            </span>
                          )}
                          {ticket.pendienteSync && (
                            <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">
                              ⏳ Guardado en Tablet (Pendiente subir)
                            </span>
                          )}
                          <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-pink-50 text-gray-700 border border-pink-200">
                            {ticket.metodo_pago}
                          </span>
                          {Number(ticket.descuento) > 0 && (
                            <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">
                              Desc/Promo: -${Number(ticket.descuento).toFixed(0)}
                            </span>
                          )}
                          <span className="text-xs text-gray-400">
                            {fecha.toLocaleDateString('es-MX')} • {fecha.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>

                        <div className="text-xs text-gray-600 pt-1">
                          {(ticket.items || []).map((it, idx) => (
                            <span key={idx} className="inline-block mr-3 bg-gray-50 px-2 py-0.5 rounded border border-gray-100 mb-1">
                              <strong>{it.qty}x</strong> {it.nombre_producto} (${it.subtotal})
                            </span>
                          ))}
                        </div>
                      </div>

                      <div className="flex items-center justify-between sm:justify-end gap-3 border-t sm:border-t-0 pt-2 sm:pt-0 border-pink-50">
                        <div className="text-right mr-2">
                          <p className="text-xs text-gray-400">Total Cobrado</p>
                          <p className="text-xl font-extrabold text-purple-900">${Number(ticket.total).toFixed(2)}</p>
                        </div>

                        <button
                          onClick={() => setTicketSeleccionado(ticket)}
                          className="px-3.5 py-2 bg-destellos-lilac/60 hover:bg-destellos-lilac text-purple-950 rounded-xl text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                        >
                          <Receipt size={15} />
                          Ver Recibo
                        </button>

                        <button
                          onClick={() => anularTicket(ticket)}
                          className="p-2 text-red-500 hover:bg-red-50 rounded-xl border border-red-100 cursor-pointer"
                          title="Anular venta y restaurar stock"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        )}

        {/* ==================== MÓDULO 8: CORTES DE CAJA POR DÍA ==================== */}
        {vistaActiva === 'cortes' && (
          <div className="flex-1 flex flex-col p-4 md:p-6 overflow-hidden">
            <div className="mb-4">
              <h2 className="text-2xl font-bold text-gray-800">Cortes de Caja por Día</h2>
              <p className="text-xs text-gray-500">Resumen diario de ingresos por método de pago (incluye ventas de piso y pedidos entregados)</p>
            </div>

            <div className="flex-1 overflow-y-auto space-y-4 pr-1">
              {listaCortes.length === 0 ? (
                <div className="bg-white rounded-2xl p-10 text-center text-gray-400 border border-pink-100">
                  <BarChart3 size={48} className="mx-auto mb-2 opacity-30" />
                  <p>Todavía no hay ventas para generar cortes de caja.</p>
                </div>
              ) : (
                listaCortes.map(corte => {
                  const abierto = diaCorteExpandido === corte.fechaKey
                  return (
                    <div key={corte.fechaKey} className="bg-white rounded-2xl border border-pink-100 shadow-xs overflow-hidden">
                      <div 
                        onClick={() => setDiaCorteExpandido(abierto ? null : corte.fechaKey)}
                        className="p-4 bg-white hover:bg-pink-50/30 transition-colors cursor-pointer flex flex-col lg:flex-row lg:items-center justify-between gap-4"
                      >
                        <div>
                          <span className="text-xs font-bold uppercase tracking-wider text-purple-700 bg-purple-50 px-2.5 py-0.5 rounded-full">
                            {corte.tickets.length} {corte.tickets.length === 1 ? 'operación registrada' : 'operaciones registradas'}
                          </span>
                          <h3 className="text-lg font-extrabold text-gray-800 capitalize mt-1">
                            {corte.fechaLegible}
                          </h3>
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 flex-1 max-w-3xl">
                          <div className="p-2.5 rounded-xl bg-emerald-50/70 border border-emerald-100">
                            <span className="text-[11px] text-emerald-800 font-semibold block">Efectivo en Caja</span>
                            <span className="text-base font-extrabold text-emerald-900">${corte.efectivo.toFixed(2)}</span>
                          </div>

                          <div className="p-2.5 rounded-xl bg-blue-50/70 border border-blue-100">
                            <span className="text-[11px] text-blue-800 font-semibold block">Transferencias</span>
                            <span className="text-base font-extrabold text-blue-900">${corte.transferencia.toFixed(2)}</span>
                          </div>

                          <div className="p-2.5 rounded-xl bg-indigo-50/70 border border-indigo-100">
                            <span className="text-[11px] text-indigo-800 font-semibold block">Tarjeta</span>
                            <span className="text-base font-extrabold text-indigo-900">${corte.tarjeta.toFixed(2)}</span>
                          </div>

                          <div className="p-2.5 rounded-xl bg-amber-50/80 border border-amber-200">
                            <span className="text-[11px] text-amber-900 font-semibold block">Ganancia Neta</span>
                            <span className="text-base font-extrabold text-amber-900">${corte.gananciaTotal.toFixed(2)}</span>
                          </div>

                          <div className="p-2.5 rounded-xl bg-purple-900 text-white flex flex-col justify-center">
                            <span className="text-[11px] text-purple-200 font-semibold block">Venta Total Día</span>
                            <span className="text-lg font-extrabold">${corte.totalVendido.toFixed(2)}</span>
                          </div>
                        </div>

                        <div className="flex items-center justify-end text-gray-400">
                          {abierto ? <ChevronUp size={22} /> : <ChevronDown size={22} />}
                        </div>
                      </div>

                      {abierto && (
                        <div className="border-t border-pink-100 bg-pink-50/30 p-4 space-y-2">
                          <h4 className="text-xs font-bold uppercase text-gray-500 mb-2">
                            Tickets registrados el {corte.fechaKey}:
                          </h4>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                            {corte.tickets.map(t => {
                              const hora = new Date(t.created_at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })
                              return (
                                <div key={t.id} className="bg-white p-3 rounded-xl border border-pink-100 flex items-center justify-between">
                                  <div>
                                    <div className="flex items-center gap-2">
                                      <span className="font-bold text-xs text-purple-900">Ticket #{t.folio || t.id.slice(0, 4)}</span>
                                      <span className="text-xs text-gray-400">{hora}</span>
                                      <span className="text-[11px] px-2 py-0.5 rounded bg-gray-100 font-semibold text-gray-700">{t.metodo_pago}</span>
                                    </div>
                                    <p className="text-xs text-gray-600 mt-1">
                                      {(t.items || []).map(i => `${i.qty}x ${i.nombre_producto}`).join(', ')}
                                    </p>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <span className="font-extrabold text-sm text-gray-900">${Number(t.total).toFixed(2)}</span>
                                    <button
                                      onClick={() => setTicketSeleccionado(t)}
                                      className="p-1.5 bg-pink-50 hover:bg-pink-100 text-purple-800 rounded-lg cursor-pointer"
                                      title="Ver Recibo"
                                    >
                                      <Receipt size={15} />
                                    </button>
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </div>
        )}

        {/* ==================== MÓDULO 9: ANALÍTICAS Y GUÍA DE RESURTIDO ==================== */}
        {vistaActiva === 'analiticas' && (
          <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">
            <div>
              <h2 className="text-2xl font-bold text-gray-800">Analíticas y Guía de Resurtido</h2>
              <p className="text-xs text-gray-500">
                Descubre qué artículos se venden más, qué categorías dejan mayor ganancia y qué conviene comprar o no al surtir.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="bg-white p-4 rounded-2xl border border-pink-100 shadow-2xs">
                <span className="text-xs text-gray-500 font-semibold">Inversión Actual en Stock (Costo)</span>
                <p className="text-2xl font-extrabold text-gray-800 mt-1">${analiticas.valorInventarioCosto.toFixed(2)}</p>
                <span className="text-[11px] text-gray-400">Capital invertido en piezas disponibles</span>
              </div>

              <div className="bg-white p-4 rounded-2xl border border-pink-100 shadow-2xs">
                <span className="text-xs text-gray-500 font-semibold">Valor de Venta del Inventario</span>
                <p className="text-2xl font-extrabold text-purple-900 mt-1">${analiticas.valorInventarioVenta.toFixed(2)}</p>
                <span className="text-[11px] text-gray-400">Ingreso potencial si se vende todo el stock</span>
              </div>

              <div className="bg-white p-4 rounded-2xl border border-pink-100 shadow-2xs">
                <span className="text-xs text-emerald-700 font-semibold">Ganancia Potencial en Mesa</span>
                <p className="text-2xl font-extrabold text-emerald-700 mt-1">
                  ${(analiticas.valorInventarioVenta - analiticas.valorInventarioCosto).toFixed(2)}
                </p>
                <span className="text-[11px] text-gray-400">Utilidad neta estimada del stock actual</span>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="bg-white p-5 rounded-2xl border border-pink-100 shadow-2xs">
                <h3 className="font-bold text-base text-gray-800 mb-3 flex items-center gap-2">
                  <TrendingUp size={18} className="text-purple-700" />
                  Top 10 Artículos Más Vendidos
                </h3>
                {analiticas.topMasVendidos.length === 0 ? (
                  <p className="text-xs text-gray-400 py-6 text-center">Registra ventas para ver el ranking de productos estrella.</p>
                ) : (
                  <div className="space-y-2.5">
                    {analiticas.topMasVendidos.map((item, idx) => (
                      <div key={item.id} className="flex items-center justify-between p-2.5 rounded-xl bg-pink-50/40 border border-pink-100 text-xs">
                        <div className="flex items-center gap-2.5">
                          <span className="w-6 h-6 rounded-full bg-purple-800 text-white font-bold flex items-center justify-center">
                            {idx + 1}
                          </span>
                          <div>
                            <p className="font-bold text-gray-800">{item.nombre}</p>
                            <span className="text-[11px] text-gray-500">
                              {item.categoria} {item.tematica ? `• ${item.tematica}` : ''} • Stock actual: <strong>{item.stockActual}</strong>
                            </span>
                          </div>
                        </div>
                        <div className="text-right">
                          <span className="font-extrabold text-sm text-purple-900">{item.unidadesVendidas} vendidos</span>
                          <span className="block text-[11px] text-emerald-700 font-semibold">
                            Ganancia: ${item.gananciaEstimada.toFixed(0)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="bg-white p-5 rounded-2xl border border-pink-100 shadow-2xs">
                <h3 className="font-bold text-base text-gray-800 mb-3 flex items-center gap-2">
                  <BarChart3 size={18} className="text-purple-700" />
                  Rentabilidad por Categoría (Incluye Pedidos)
                </h3>
                {analiticas.resumenCategorias.length === 0 ? (
                  <p className="text-xs text-gray-400 py-6 text-center">Sin datos de categorías vendidas aún.</p>
                ) : (
                  <div className="space-y-2.5">
                    {analiticas.resumenCategorias.map(cat => (
                      <div key={cat.categoria} className="p-3 rounded-xl bg-gray-50 border border-gray-100 flex items-center justify-between text-xs">
                        <div>
                          <span className="font-extrabold text-gray-800 text-sm">{cat.categoria}</span>
                          <span className="block text-gray-500">{cat.unidades} piezas / encargos vendidos</span>
                        </div>
                        <div className="text-right">
                          <span className="font-bold text-gray-700 block">Ventas: ${cat.ingresos.toFixed(2)}</span>
                          <span className="font-extrabold text-emerald-700 text-sm">Utilidad: ${cat.ganancia.toFixed(2)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="bg-white p-5 rounded-2xl border border-emerald-200 shadow-2xs">
                <h3 className="font-bold text-base text-emerald-900 mb-1 flex items-center gap-2">
                  ✅ ¡Sí Comprar! (Urgente Resurtir)
                </h3>
                <p className="text-xs text-gray-500 mb-3">
                  Productos con ventas comprobadas que ya están agotados o con solo 1 pieza disponible.
                </p>
                {analiticas.urgenteResurtir.length === 0 ? (
                  <p className="text-xs text-gray-400 py-4 text-center">Todo tu stock estrella está bien abastecido.</p>
                ) : (
                  <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                    {analiticas.urgenteResurtir.map(p => (
                      <div key={p.id} className="p-2.5 rounded-xl bg-emerald-50/60 border border-emerald-100 flex justify-between items-center text-xs">
                        <div>
                          <p className="font-bold text-gray-800">{p.nombre}</p>
                          <span className="text-[11px] text-gray-500">
                            {p.categoria} • Costo reposición: ${p.costoUnitario}
                          </span>
                        </div>
                        <div className="text-right">
                          <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-bold text-[10px]">
                            Quedan: {p.stockActual}
                          </span>
                          <span className="block font-bold text-emerald-800 mt-0.5">
                            {p.unidadesVendidas} vendidos
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="bg-white p-5 rounded-2xl border border-amber-200 shadow-2xs">
                <h3 className="font-bold text-base text-amber-900 mb-1 flex items-center gap-2">
                  <AlertTriangle size={18} className="text-amber-600" />
                  No Surtir Todavía (Baja Rotación)
                </h3>
                <p className="text-xs text-gray-500 mb-3">
                  Artículos con 2 o más piezas acumuladas y 0 ventas registradas (sugerencia: ponlos en Promoción).
                </p>
                {analiticas.huesoSinRotacion.length === 0 ? (
                  <p className="text-xs text-gray-400 py-4 text-center">No tienes mercancía estancada.</p>
                ) : (
                  <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                    {analiticas.huesoSinRotacion.slice(0, 15).map(p => (
                      <div key={p.id} className="p-2.5 rounded-xl bg-amber-50/50 border border-amber-100 flex justify-between items-center text-xs">
                        <div>
                          <p className="font-bold text-gray-800">{p.nombre}</p>
                          <span className="text-[11px] text-gray-500">{p.categoria} • Precio: ${p.precioPublico}</span>
                        </div>
                        <div className="text-right">
                          <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 font-bold">
                            {p.stockActual} en stock sin vender
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ==================== MODAL DE RECIBO / TICKET DIGITAL ==================== */}
      {ticketSeleccionado && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-sm rounded-3xl shadow-xl overflow-hidden border border-pink-100">
            <div className="p-5 text-center border-b border-dashed border-gray-200 bg-destellos-pink/50">
              <div className="w-12 h-12 rounded-full bg-destellos-lilac mx-auto flex items-center justify-center text-white mb-2 shadow-xs">
                <Sparkles size={24} />
              </div>
              <h3 className="font-extrabold text-lg text-gray-800">Destellos de Oro</h3>
              <p className="text-xs text-gray-500">Joyería y Bisutería • Guasave, Sin.</p>
              <p className="text-xs font-bold text-purple-800 mt-1">
                Recibo de Venta #{ticketSeleccionado.folio || ticketSeleccionado.id.slice(0, 6)}
              </p>
              <p className="text-[11px] text-gray-400">
                {new Date(ticketSeleccionado.created_at).toLocaleString('es-MX')}
              </p>
            </div>

            <div className="p-5 space-y-3">
              <div className="space-y-2 max-h-56 overflow-y-auto text-sm">
                {(ticketSeleccionado.items || []).map((item, i) => (
                  <div key={i} className="flex justify-between items-start">
                    <div className="pr-2">
                      <span className="font-bold text-gray-800">{item.qty}x </span>
                      <span className="text-gray-700">{item.nombre_producto}</span>
                      <span className="block text-[11px] text-gray-400">${item.precio_unitario} c/u</span>
                    </div>
                    <span className="font-semibold text-gray-900">${Number(item.subtotal).toFixed(2)}</span>
                  </div>
                ))}
              </div>

              <div className="border-t border-dashed border-gray-200 pt-3 space-y-1 text-sm">
                <div className="flex justify-between text-gray-500">
                  <span>Subtotal:</span>
                  <span>${Number(ticketSeleccionado.subtotal).toFixed(2)}</span>
                </div>
                {Number(ticketSeleccionado.descuento) > 0 && (
                  <div className="flex justify-between text-emerald-700 font-semibold">
                    <span>Ahorro / Descuento:</span>
                    <span>-${Number(ticketSeleccionado.descuento).toFixed(2)}</span>
                  </div>
                )}
                <div className="flex justify-between text-base font-extrabold text-purple-950 pt-1">
                  <span>TOTAL:</span>
                  <span>${Number(ticketSeleccionado.total).toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-xs text-gray-500 pt-1">
                  <span>Método de pago:</span>
                  <span className="font-bold text-gray-700">{ticketSeleccionado.metodo_pago}</span>
                </div>
                {ticketSeleccionado.recibido && (
                  <>
                    <div className="flex justify-between text-xs text-gray-500">
                      <span>Efectivo recibido:</span>
                      <span>${Number(ticketSeleccionado.recibido).toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between text-xs font-bold text-emerald-700">
                      <span>Cambio entregado:</span>
                      <span>${Number(ticketSeleccionado.cambio || 0).toFixed(2)}</span>
                    </div>
                  </>
                )}
              </div>

              <p className="text-center text-xs text-gray-400 pt-2 italic">
                ✨ ¡Gracias por tu compra! ✨
              </p>
            </div>

            <div className="p-4 bg-gray-50 border-t border-gray-100 flex gap-2">
              <button
                onClick={() => window.print()}
                className="flex-1 py-2.5 bg-white border border-gray-300 hover:bg-gray-100 text-gray-700 font-bold rounded-xl text-xs flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Printer size={15} /> Imprimir / PDF
              </button>
              <button
                onClick={() => setTicketSeleccionado(null)}
                className="flex-1 py-2.5 bg-purple-700 hover:bg-purple-800 text-white font-bold rounded-xl text-xs cursor-pointer"
              >
                Cerrar Recibo
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}