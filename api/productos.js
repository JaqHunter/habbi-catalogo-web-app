const mysql = require('mysql2/promise');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { tienda } = req.query || {};

  try {
    const connection = await mysql.createConnection({
      host: process.env.TIDB_HOST,
      port: Number(process.env.TIDB_PORT) || 4000,
      user: process.env.TIDB_USER,
      password: process.env.TIDB_PASSWORD,
      database: process.env.TIDB_DATABASE || 'tienda',
      ssl: {
        rejectUnauthorized: true
      }
    });

    const configMap = {};

    // 1. Obtener datos globales de configuración clave/valor si existen
    try {
      const [configs] = await connection.execute('SELECT clave, valor FROM configuracion');
      configs.forEach(row => {
        configMap[row.clave] = row.valor;
      });
    } catch (_) {}

    // 2. Resolver datos de la tienda (Pago Móvil, Zelle, Tasa BCV)
    let tiendaId = null;
    try {
      const [tiendaCols] = await connection.execute("SHOW COLUMNS FROM tiendas");
      const colNames = new Set(tiendaCols.map(c => c.Field.toLowerCase()));

      let sqlTienda = '';
      let paramsTienda = [];

      if (tienda) {
        if (colNames.has('slug') && isNaN(Number(tienda))) {
          sqlTienda = 'SELECT * FROM tiendas WHERE slug = ? LIMIT 1';
          paramsTienda = [tienda];
        } else if (colNames.has('id')) {
          if (colNames.has('slug')) {
            sqlTienda = 'SELECT * FROM tiendas WHERE id = ? OR slug = ? LIMIT 1';
            paramsTienda = [tienda, tienda];
          } else {
            sqlTienda = 'SELECT * FROM tiendas WHERE id = ? LIMIT 1';
            paramsTienda = [tienda];
          }
        }
      } else {
        sqlTienda = 'SELECT * FROM tiendas ORDER BY id ASC LIMIT 1';
      }

      if (sqlTienda) {
        const [tiendaRows] = await connection.execute(sqlTienda, paramsTienda);
        if (tiendaRows.length > 0) {
          const t = tiendaRows[0];
          tiendaId = t.id;
          if (t.nombre) configMap.nombre_tienda = t.nombre;
          if (t.nombre_tienda) configMap.nombre_tienda = t.nombre_tienda;
          if (t.tasa_bcv) configMap.tasa_bcv = String(t.tasa_bcv);
          if (t.pagomovil_banco) configMap.pagomovil_banco = t.pagomovil_banco;
          if (t.pagomovil_telefono) configMap.pagomovil_telefono = t.pagomovil_telefono;
          if (t.pagomovil_cedula) configMap.pagomovil_cedula = t.pagomovil_cedula;
          if (t.zelle_titular) configMap.zelle_titular = t.zelle_titular;
          if (t.zelle_correo) configMap.zelle_correo = t.zelle_correo;
          if (t.whatsapp_contacto || t.telefono) {
            configMap.whatsapp_contacto = t.whatsapp_contacto || t.telefono;
          }
        }
      }
    } catch (_) {}

    // 3. Obtener productos activos con stock
    let sqlProductos = `
      SELECT p.id, p.nombre, p.precio_usd, p.stock, p.imagen_url, c.nombre AS categoria
      FROM productos p
      LEFT JOIN categorias c ON p.categoria_id = c.id
      WHERE p.activo = 1 AND p.stock > 0
    `;
    const paramsProd = [];

    try {
      const [prodCols] = await connection.execute("SHOW COLUMNS FROM productos");
      const prodColSet = new Set(prodCols.map(c => c.Field.toLowerCase()));
      if (tiendaId && prodColSet.has('tienda_id')) {
        sqlProductos += ' AND p.tienda_id = ?';
        paramsProd.push(tiendaId);
      }
    } catch (_) {}

    sqlProductos += ' ORDER BY p.id DESC';

    const [productos] = await connection.execute(sqlProductos, paramsProd);

    await connection.end();

    return res.status(200).json({
      config: configMap,
      productos: productos
    });
  } catch (error) {
    console.error('Error DB:', error);
    return res.status(500).json({ error: 'Error al conectar con la base de datos' });
  }
}
