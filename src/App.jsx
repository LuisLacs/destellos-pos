import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { 
  ShoppingBag, Package, PlusCircle, Search, Trash2, 
  Eye, EyeOff, Edit2, Check, X, Camera, Sparkles, RefreshCw 
} from 'lucide-react'

const CATEGORIAS = ['TODAS', 'CADENAS-COLLARES', 'ARETES', 'PULSERAS', 'ANILLOS', 'LLAVEROS']

export default function App() {
  const [vistaActiva, setVistaActiva] = useState('ventas') // 'ventas' | 'inventario' | 'agregar'
  const [productos, setProductos] = useState([])
  const [cargando, setCargando] = useState(true)
  
  // Estados para Ventas (POS)
  const [categoriaFiltro, setCategoriaFiltro] = useState('TODAS')
  const [busqueda, setBusqueda] = useState('')
  const [carrito, setCarrito] = useState([])
  const [descuento, setDescuento] = useState(0)
  const [procesandoVenta, setProcesandoVenta] = useState(false)

  // Estados para Inventario
  const [imagenExpandidaId, setImagenExpandidaId] = useState(null)
  const [editandoId, setEditandoId] = useState(null)
  const [formEdicion, setFormEdicion] = useState({})

  // Estados para Agregar Producto
  const [nuevoProd, setNuevoProd] = useState({
    codigo: '',
    nombre_producto: '',
    categoria: 'CADENAS-COLLARES',
    cantidad: 1,
    costo_produccion: '',
    precio_publico: '',
    imagen_url: ''
  })
  const [subiendoImagen, setSubiendoImagen] = useState(false)

  useEffect(() => {
    cargarProductos()
  }, [])

  async function cargarProductos() {
    setCargando(true)
    const { data, error } = await supabase
      .from('productos')
      .select('*')
      .order('nombre_producto', { ascending: true })

    if (error) {
      console.error('Error cargando productos:', error)
    } else {
      setProductos(data || [])
    }
    setCargando(false)
  }

  // --- LÓGICA DE COMPRESIÓN Y SUBIDA DE IMÁGENES ---
  async function comprimirYSubirImagen(file) {
    if (!file) return null
    setSubiendoImagen(true)
    try {
      // Comprimir imagen usando Canvas a máx 600px de ancho
      const bitmap = await createImageBitmap(file)
      const canvas = document.createElement('canvas')
      const maxWidth = 600
      const scale = maxWidth / bitmap.width
      canvas.width = bitmap.width > maxWidth ? maxWidth : bitmap.width
      canvas.height = bitmap.width > maxWidth ? bitmap.height * scale : bitmap.height

      const ctx = canvas.getContext('2d')
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)

      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.75))
      const fileName = `prod_${Date.now()}.jpg`

      const { error: uploadError } = await supabase.storage
        .from('productos')
        .upload(fileName, blob, { contentType: 'image/jpeg' })

      if (uploadError) throw uploadError

      const { data } = supabase.storage.from('productos').getPublicUrl(fileName)
      return data.publicUrl
    } catch (err) {
      alert('Error al subir imagen: Asegúrate de haber ejecutado el script SQL para crear el bucket "productos" en Supabase.')
      console.error(err)
      return null
    } finally {
      setSubiendoImagen(false)
    }
  }

  // --- LÓGICA DEL CARRITO Y VENTAS ---
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

  const subtotalCarrito = carrito.reduce((acc, item) => acc + (Number(item.precio_publico) * item.qty), 0)
  const totalCarrito = Math.max(0, subtotalCarrito - Number(descuento || 0))

  async function cobrarVenta() {
    if (carrito.length === 0) return
    setProcesandoVenta(true)

    try {
      // Descontar inventario en Supabase de cada producto vendido
      for (const item of carrito) {
        const nuevoStock = Math.max(0, item.cantidad - item.qty)
        await supabase
          .from('productos')
          .update({ cantidad: nuevoStock })
          .eq('id', item.id)
      }

      alert(`¡Venta registrada con éxito! Total cobrado: $${totalCarrito.toFixed(2)}`)
      setCarrito([])
      setDescuento(0)
      await cargarProductos()
    } catch (error) {
      alert('Hubo un error al actualizar el stock.')
      console.error(error)
    } finally {
      setProcesandoVenta(false)
    }
  }

  // --- LÓGICA DE EDICIÓN EN INVENTARIO ---
  function iniciarEdicion(prod) {
    setEditandoId(prod.id)
    setFormEdicion({ ...prod })
  }

  async function guardarEdicion() {
    const { error } = await supabase
      .from('productos')
      .update({
        codigo: formEdicion.codigo,
        nombre_producto: formEdicion.nombre_producto,
        categoria: formEdicion.categoria,
        cantidad: Number(formEdicion.cantidad),
        costo_produccion: Number(formEdicion.costo_produccion),
        precio_publico: Number(formEdicion.precio_publico),
        imagen_url: formEdicion.imagen_url
      })
      .eq('id', editandoId)

    if (error) {
      alert('Error al guardar cambios: ' + error.message)
    } else {
      setEditandoId(null)
      cargarProductos()
    }
  }

  // --- LÓGICA PARA AGREGAR PRODUCTO ---
  async function crearProducto(e) {
    e.preventDefault()
    if (!nuevoProd.nombre_producto || !nuevoProd.precio_publico) {
      return alert('Por favor completa el nombre y el precio al público.')
    }

    const { error } = await supabase.from('productos').insert([{
      codigo: nuevoProd.codigo,
      nombre_producto: nuevoProd.nombre_producto,
      categoria: nuevoProd.categoria,
      cantidad: Number(nuevoProd.cantidad) || 0,
      costo_produccion: Number(nuevoProd.costo_produccion) || 0,
      precio_publico: Number(nuevoProd.precio_publico) || 0,
      imagen_url: nuevoProd.imagen_url
    }])

    if (error) {
      alert('Error al crear producto: ' + error.message)
    } else {
      alert('¡Producto agregado al catálogo!')
      setNuevoProd({
        codigo: '', nombre_producto: '', categoria: 'CADENAS-COLLARES',
        cantidad: 1, costo_produccion: '', precio_publico: '', imagen_url: ''
      })
      cargarProductos()
      setVistaActiva('inventario')
    }
  }

  // Filtrado de productos compartido
  const productosFiltrados = productos.filter(p => {
    const coincideCat = categoriaFiltro === 'TODAS' || p.categoria === categoriaFiltro
    const coincideTexto = p.nombre_producto.toLowerCase().includes(busqueda.toLowerCase()) ||
                          (p.codigo && p.codigo.toLowerCase().includes(busqueda.toLowerCase()))
    return coincideCat && coincideTexto
  })

  return (
    <div className="flex h-screen overflow-hidden bg-destellos-pink">
      
      {/* SIDEBAR DE NAVEGACIÓN */}
      <aside className="w-20 md:w-56 bg-white border-r border-pink-100 flex flex-col justify-between shadow-sm z-10">
        <div>
          <div className="p-4 flex items-center justify-center md:justify-start gap-2 border-b border-pink-100">
            <div className="w-10 h-10 rounded-full bg-destellos-lilac flex items-center justify-center text-white font-bold shadow-inner">
              <Sparkles size={20} />
            </div>
            <div className="hidden md:block">
              <h1 className="font-bold text-base leading-tight text-destellos-dark">Destellos de Oro</h1>
              <span className="text-xs text-destellos-gold font-medium">Punto de Venta</span>
            </div>
          </div>

          <nav className="p-2 space-y-2 mt-4">
            <button
              onClick={() => setVistaActiva('ventas')}
              className={`w-full flex items-center justify-center md:justify-start gap-3 p-3 rounded-xl font-medium transition-all ${
                vistaActiva === 'ventas' 
                  ? 'bg-destellos-lilac text-purple-950 shadow-sm font-semibold' 
                  : 'text-gray-600 hover:bg-pink-50'
              }`}
            >
              <ShoppingBag size={22} />
              <span className="hidden md:inline">Ventas (POS)</span>
            </button>

            <button
              onClick={() => setVistaActiva('inventario')}
              className={`w-full flex items-center justify-center md:justify-start gap-3 p-3 rounded-xl font-medium transition-all ${
                vistaActiva === 'inventario' 
                  ? 'bg-destellos-lilac text-purple-950 shadow-sm font-semibold' 
                  : 'text-gray-600 hover:bg-pink-50'
              }`}
            >
              <Package size={22} />
              <span className="hidden md:inline">Inventario</span>
            </button>

            <button
              onClick={() => setVistaActiva('agregar')}
              className={`w-full flex items-center justify-center md:justify-start gap-3 p-3 rounded-xl font-medium transition-all ${
                vistaActiva === 'agregar' 
                  ? 'bg-destellos-lilac text-purple-950 shadow-sm font-semibold' 
                  : 'text-gray-600 hover:bg-pink-50'
              }`}
            >
              <PlusCircle size={22} />
              <span className="hidden md:inline">Agregar Prod.</span>
            </button>
          </nav>
        </div>

        <div className="p-3 border-t border-pink-100">
          <button 
            onClick={cargarProductos}
            className="w-full flex items-center justify-center gap-2 p-2 text-xs text-gray-500 hover:text-destellos-dark hover:bg-pink-50 rounded-lg"
          >
            <RefreshCw size={15} className={cargando ? 'animate-spin' : ''} />
            <span className="hidden md:inline">Sincronizar Stock</span>
          </button>
        </div>
      </aside>

      {/* CONTENIDO PRINCIPAL */}
      <main className="flex-1 flex overflow-hidden">
        
        {/* ==================== MÓDULO 1: VENTAS (POS) ==================== */}
        {vistaActiva === 'ventas' && (
          <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
            
            {/* IZQUIERDA: CARRITO / TICKET EN CURSO (35%) */}
            <div className="w-full md:w-5/12 lg:w-4/12 bg-white border-r border-pink-100 flex flex-col h-full shadow-sm">
              <div className="p-4 border-b border-pink-100 flex justify-between items-center bg-pink-50/40">
                <h2 className="font-bold text-lg text-gray-800">Ticket de Venta</h2>
                {carrito.length > 0 && (
                  <button 
                    onClick={() => setCarrito([])}
                    className="text-xs text-red-500 hover:underline flex items-center gap-1"
                  >
                    <Trash2 size={14} /> Vaciar
                  </button>
                )}
              </div>

              {/* Lista de items en el carrito */}
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
                        <p className="text-xs text-gray-500">${item.precio_publico} c/u</p>
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
              </div>

              {/* Pie de Carrito y Botón de Cobro */}
              <div className="p-4 border-t border-pink-200 bg-white space-y-3">
                <div className="flex justify-between items-center text-sm">
                  <span className="text-gray-500">Descuento ($):</span>
                  <input 
                    type="number" 
                    min="0"
                    value={descuento}
                    onChange={e => setDescuento(e.target.value)}
                    className="w-24 border border-pink-200 rounded-lg px-2 py-1 text-right font-medium"
                  />
                </div>
                <div className="flex justify-between items-baseline border-t border-pink-100 pt-2">
                  <span className="text-base font-bold text-gray-700">Total a Cobrar:</span>
                  <span className="text-3xl font-extrabold text-purple-900">${totalCarrito.toFixed(2)}</span>
                </div>

                <button
                  onClick={cobrarVenta}
                  disabled={carrito.length === 0 || procesandoVenta}
                  className="w-full py-3.5 rounded-xl bg-purple-700 hover:bg-purple-800 disabled:bg-gray-300 text-white font-bold text-lg shadow-md active:scale-[0.99] transition-all cursor-pointer"
                >
                  {procesandoVenta ? 'Procesando...' : 'Cobrar Venta'}
                </button>
              </div>
            </div>

            {/* DERECHA: CATÁLOGO DE PRODUCTOS (65%) */}
            <div className="flex-1 flex flex-col h-full overflow-hidden p-4">
              {/* Buscador y Filtros */}
              <div className="space-y-3 mb-4">
                <div className="relative">
                  <Search className="absolute left-3.5 top-3 text-gray-400" size={20} />
                  <input
                    type="text"
                    placeholder="Buscar por nombre o código (ej. mariposa, C-DO-05)..."
                    value={busqueda}
                    onChange={e => setBusqueda(e.target.value)}
                    className="w-full pl-11 pr-4 py-2.5 bg-white border border-pink-200 rounded-xl shadow-xs focus:outline-none focus:ring-2 focus:ring-destellos-lilac"
                  />
                </div>

                <div className="flex gap-2 overflow-x-auto pb-1">
                  {CATEGORIAS.map(cat => (
                    <button
                      key={cat}
                      onClick={() => setCategoriaFiltro(cat)}
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
              </div>

              {/* Grid de Tarjetas de Productos */}
              <div className="flex-1 overflow-y-auto pr-1">
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                  {productosFiltrados.map(prod => {
                    const agotado = prod.cantidad <= 0
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
                          {imagenExpandidaId === prod.id && prod.imagen_url && (
                            <img 
                              src={prod.imagen_url} 
                              alt={prod.nombre_producto} 
                              className="w-full h-24 object-cover rounded-lg my-1.5 border border-pink-100"
                            />
                          )}
                        </div>

                        <div className="mt-3 pt-2 border-t border-pink-50 flex items-center justify-between">
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
                <p className="text-xs text-gray-500">Modifica precios, existencias o despliega fotos de apoyo para Jazmín</p>
              </div>

              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Buscar producto..."
                  value={busqueda}
                  onChange={e => setBusqueda(e.target.value)}
                  className="px-3 py-2 bg-white border border-pink-200 rounded-xl text-sm"
                />
                <select
                  value={categoriaFiltro}
                  onChange={e => setCategoriaFiltro(e.target.value)}
                  className="px-3 py-2 bg-white border border-pink-200 rounded-xl text-sm font-medium"
                >
                  {CATEGORIAS.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto bg-white rounded-2xl border border-pink-100 shadow-xs">
              <table className="w-full text-left border-collapse text-sm">
                <thead className="bg-pink-50/70 text-gray-600 text-xs uppercase sticky top-0">
                  <tr>
                    <th className="p-3">Código</th>
                    <th className="p-3">Producto</th>
                    <th className="p-3">Categoría</th>
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
                      <>
                        <tr key={prod.id} className="hover:bg-pink-50/30">
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
                              <select
                                value={formEdicion.categoria}
                                onChange={e => setFormEdicion({...formEdicion, categoria: e.target.value})}
                                className="border rounded px-1.5 py-1"
                              >
                                {CATEGORIAS.filter(c => c !== 'TODAS').map(c => (
                                  <option key={c} value={c}>{c}</option>
                                ))}
                              </select>
                            ) : (
                              <span className="px-2 py-1 rounded-full bg-purple-50 text-purple-800 font-semibold">
                                {prod.categoria}
                              </span>
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
                              className={`p-1.5 rounded-lg border transition-colors ${
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
                                <button onClick={guardarEdicion} className="p-1.5 bg-emerald-600 text-white rounded-lg">
                                  <Check size={16} />
                                </button>
                                <button onClick={() => setEditandoId(null)} className="p-1.5 bg-gray-200 text-gray-700 rounded-lg">
                                  <X size={16} />
                                </button>
                              </div>
                            ) : (
                              <button 
                                onClick={() => iniciarEdicion(prod)}
                                className="p-1.5 text-gray-500 hover:text-purple-800 hover:bg-purple-50 rounded-lg"
                              >
                                <Edit2 size={16} />
                              </button>
                            )}
                          </td>
                        </tr>

                        {/* Fila desplegable para ver o cambiar la foto de apoyo */}
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
                                    <label className="px-3 py-1.5 bg-purple-700 text-white rounded-lg text-xs font-semibold cursor-pointer flex items-center gap-1.5">
                                      <Camera size={14} />
                                      {subiendoImagen ? 'Comprimiendo...' : 'Tomar / Subir Foto'}
                                      <input 
                                        type="file" 
                                        accept="image/*" 
                                        capture="environment"
                                        className="hidden"
                                        onChange={async (e) => {
                                          const url = await comprimirYSubirImagen(e.target.files[0])
                                          if (url) {
                                            await supabase.from('productos').update({ imagen_url: url }).eq('id', prod.id)
                                            cargarProductos()
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
                                          cargarProductos()
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
                      </>
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
                    placeholder="Ej. C-DO-19"
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

              <div>
                <label className="block text-xs font-bold text-gray-600 mb-1">Nombre o Descripción del Producto *</label>
                <input
                  type="text"
                  required
                  placeholder="Ej. Cadenita mariposa nácar dorada"
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
                    placeholder="130.00"
                    value={nuevoProd.precio_publico}
                    onChange={e => setNuevoProd({...nuevoProd, precio_publico: e.target.value})}
                    className="w-full px-3 py-2 border border-pink-200 rounded-xl text-sm font-bold text-purple-900"
                  />
                </div>
              </div>

              {/* Ganancia calculada en tiempo real */}
              <div className="p-3 bg-pink-50/60 rounded-xl flex justify-between items-center text-sm">
                <span className="text-gray-600 font-medium">Ganancia Estimada por Pieza:</span>
                <span className="font-extrabold text-emerald-700">
                  ${(Number(nuevoProd.precio_publico || 0) - Number(nuevoProd.costo_produccion || 0)).toFixed(2)}
                </span>
              </div>

              {/* Imagen de Apoyo */}
              <div className="space-y-2 pt-2 border-t border-pink-100">
                <label className="block text-xs font-bold text-gray-600">Foto de Apoyo (Opcional)</label>
                <div className="flex items-center gap-3">
                  <label className="px-4 py-2 bg-destellos-lilac text-purple-950 rounded-xl text-xs font-bold cursor-pointer flex items-center gap-2">
                    <Camera size={16} />
                    {subiendoImagen ? 'Subiendo...' : 'Tomar Foto'}
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
                  <input
                    type="text"
                    placeholder="O pega URL de imagen..."
                    value={nuevoProd.imagen_url}
                    onChange={e => setNuevoProd({...nuevoProd, imagen_url: e.target.value})}
                    className="flex-1 px-3 py-2 border border-pink-200 rounded-xl text-xs"
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
      </main>
    </div>
  )
}