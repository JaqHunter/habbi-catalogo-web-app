const mysql = require('mysql2/promise');

/**
 * Serverless function en Vercel para registrar pedidos en TiDB Cloud
 * Maneja clientes (UPSERT), generación de orden correlativa (#HS-XXXX),
 * transacción ACID para cabecera (pedidos) y detalle (pedido_detalles).
 */
export default async function handler(req, res) {
  // Configuración de cabeceras CORS
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Método no permitido. Solo se acepta POST.' });
  }

  const { cliente, entrega, pago, totales, items } = req.body || {};

  // 1. Validaciones de carga útil (Payload)
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, error: 'El carrito no contiene productos.' });
  }

  if (!cliente || !cliente.cedula_rif || !cliente.nombre || !cliente.telefono) {
    return res.status(400).json({ success: false, error: 'Faltan datos obligatorios del cliente (Cédula/RIF, Nombre o Teléfono).' });
  }

  if (!entrega || !entrega.modalidad) {
    return res.status(400).json({ success: false, error: 'Debe especificar la modalidad de entrega.' });
  }

  if (entrega.modalidad === 'DOMICILIO' && (!entrega.direccion || entrega.direccion.trim() === '')) {
    return res.status(400).json({ success: false, error: 'La dirección de entrega es obligatoria para envíos a domicilio.' });
  }

  if (!pago || !pago.metodo) {
    return res.status(400).json({ success: false, error: 'Debe seleccionar un método de pago.' });
  }

  if (pago.metodo !== 'EFECTIVO' && (!pago.referencia || pago.referencia.trim() === '')) {
    return res.status(400).json({ success: false, error: 'Debe ingresar el número de referencia del pago.' });
  }

  let connection;

  try {
    // 2. Conexión a TiDB Cloud con soporte SSL
    connection = await mysql.createConnection({
      host: process.env.TIDB_HOST,
      port: Number(process.env.TIDB_PORT) || 4000,
      user: process.env.TIDB_USER,
      password: process.env.TIDB_PASSWORD,
      database: process.env.TIDB_DATABASE || 'tienda',
      ssl: {
        rejectUnauthorized: true
      }
    });

    // Helper: inspeccionar columnas de una tabla para adaptarse al esquema real
    async function getTableColumns(tableName) {
      try {
        const [cols] = await connection.execute(`SHOW COLUMNS FROM \`${tableName}\``);
        return new Set(cols.map(c => c.Field.toLowerCase()));
      } catch (e) {
        return new Set();
      }
    }

    const colsClientes = await getTableColumns('clientes');
    const colsPedidos = await getTableColumns('pedidos');
    const colsDetalles = await getTableColumns('pedido_detalles');

    // 3. Registrar o actualizar cliente (UPSERT)
    let clienteId = null;
    const cedulaField = colsClientes.has('cedula_rif') ? 'cedula_rif' : (colsClientes.has('cedula') ? 'cedula' : 'cedula_rif');
    const dirField = colsClientes.has('direccion') ? 'direccion' : null;

    if (colsClientes.size > 0) {
      if (dirField) {
        await connection.execute(`
          INSERT INTO clientes (${cedulaField}, nombre, telefono, direccion)
          VALUES (?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            nombre = VALUES(nombre),
            telefono = VALUES(telefono),
            direccion = COALESCE(VALUES(direccion), direccion)
        `, [cliente.cedula_rif.trim(), cliente.nombre.trim(), cliente.telefono.trim(), cliente.direccion || null]);
      } else {
        await connection.execute(`
          INSERT INTO clientes (${cedulaField}, nombre, telefono)
          VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE
            nombre = VALUES(nombre),
            telefono = VALUES(telefono)
        `, [cliente.cedula_rif.trim(), cliente.nombre.trim(), cliente.telefono.trim()]);
      }

      const [cRows] = await connection.execute(
        `SELECT id FROM clientes WHERE ${cedulaField} = ? LIMIT 1`,
        [cliente.cedula_rif.trim()]
      );
      if (cRows.length > 0) {
        clienteId = cRows[0].id;
      }
    }

    // 4. Generar número de orden correlativo único (#HS-1001)
    let correlativoNum = 1001;
    try {
      const [lastOrder] = await connection.execute('SELECT id FROM pedidos ORDER BY id DESC LIMIT 1');
      if (lastOrder.length > 0 && lastOrder[0].id) {
        correlativoNum = Number(lastOrder[0].id) + 1001;
      }
    } catch (_) {}

    const numeroOrden = `#HS-${correlativoNum}`;

    // 5. Iniciar Transacción ACID
    await connection.beginTransaction();

    try {
      // Inserción en cabecera 'pedidos'
      const totalUSD = parseFloat(totales?.total_usd || 0);
      const totalBs = parseFloat(totales?.total_bs || 0);
      const tasaBCV = parseFloat(totales?.tasa_bcv || 0);

      // Armado dinámico de campos para 'pedidos' según columnas reales
      const pedidoFields = [];
      const pedidoValues = [];

      if (colsPedidos.has('numero_orden')) {
        pedidoFields.push('numero_orden');
        pedidoValues.push(numeroOrden);
      }
      if (colsPedidos.has('cliente_id') && clienteId) {
        pedidoFields.push('cliente_id');
        pedidoValues.push(clienteId);
      }
      if (colsPedidos.has('modalidad_entrega')) {
        pedidoFields.push('modalidad_entrega');
        pedidoValues.push(entrega.modalidad);
      }
      if (colsPedidos.has('direccion_entrega')) {
        pedidoFields.push('direccion_entrega');
        pedidoValues.push(entrega.direccion || null);
      }
      if (colsPedidos.has('metodo_pago')) {
        pedidoFields.push('metodo_pago');
        pedidoValues.push(pago.metodo);
      }
      if (colsPedidos.has('banco_origen')) {
        pedidoFields.push('banco_origen');
        pedidoValues.push(pago.banco_origen || null);
      }
      if (colsPedidos.has('referencia_pago')) {
        pedidoFields.push('referencia_pago');
        pedidoValues.push(pago.referencia || null);
      }
      if (colsPedidos.has('tasa_bcv')) {
        pedidoFields.push('tasa_bcv');
        pedidoValues.push(tasaBCV);
      }
      if (colsPedidos.has('total_usd')) {
        pedidoFields.push('total_usd');
        pedidoValues.push(totalUSD);
      }
      if (colsPedidos.has('total_bs')) {
        pedidoFields.push('total_bs');
        pedidoValues.push(totalBs);
      }
      if (colsPedidos.has('estatus')) {
        pedidoFields.push('estatus');
        pedidoValues.push('PENDIENTE');
      } else if (colsPedidos.has('estado')) {
        pedidoFields.push('estado');
        pedidoValues.push('PENDIENTE');
      }

      let pedidoId = correlativoNum;

      if (pedidoFields.length > 0) {
        const placeholders = pedidoFields.map(() => '?').join(', ');
        const [resPedido] = await connection.execute(
          `INSERT INTO pedidos (${pedidoFields.join(', ')}) VALUES (${placeholders})`,
          pedidoValues
        );
        pedidoId = resPedido.insertId || correlativoNum;
      }

      // Inserción en detalle 'pedido_detalles'
      for (const item of items) {
        const itemQty = parseInt(item.cantidad, 10) || 1;
        const itemPrice = parseFloat(item.precio_usd || 0);
        const itemSubtotal = itemPrice * itemQty;

        const detalleFields = [];
        const detalleValues = [];

        if (colsDetalles.has('pedido_id')) {
          detalleFields.push('pedido_id');
          detalleValues.push(pedidoId);
        }
        if (colsDetalles.has('producto_id')) {
          detalleFields.push('producto_id');
          detalleValues.push(item.id);
        }
        if (colsDetalles.has('nombre_producto') || colsDetalles.has('nombre')) {
          detalleFields.push(colsDetalles.has('nombre_producto') ? 'nombre_producto' : 'nombre');
          detalleValues.push(item.nombre || '');
        }
        if (colsDetalles.has('cantidad')) {
          detalleFields.push('cantidad');
          detalleValues.push(itemQty);
        }
        if (colsDetalles.has('precio_unitario_usd') || colsDetalles.has('precio_unitario')) {
          detalleFields.push(colsDetalles.has('precio_unitario_usd') ? 'precio_unitario_usd' : 'precio_unitario');
          detalleValues.push(itemPrice);
        }
        if (colsDetalles.has('subtotal_usd') || colsDetalles.has('subtotal')) {
          detalleFields.push(colsDetalles.has('subtotal_usd') ? 'subtotal_usd' : 'subtotal');
          detalleValues.push(itemSubtotal);
        }

        if (detalleFields.length > 0) {
          const detPlaceholders = detalleFields.map(() => '?').join(', ');
          await connection.execute(
            `INSERT INTO pedido_detalles (${detalleFields.join(', ')}) VALUES (${detPlaceholders})`,
            detalleValues
          );
        }
      }

      // 6. Confirmación de transacción
      await connection.commit();

      return res.status(200).json({
        success: true,
        numero_orden: numeroOrden,
        pedido_id: pedidoId
      });

    } catch (txError) {
      // 7. Reversión en caso de fallos
      await connection.rollback();
      throw txError;
    }

  } catch (error) {
    console.error('Error al procesar pedido en TiDB Cloud:', error);
    return res.status(500).json({
      success: false,
      error: 'Error interno al procesar el pedido en el servidor.',
      detalle: error.message
    });
  } finally {
    if (connection) {
      try {
        await connection.end();
      } catch (_) {}
    }
  }
}

