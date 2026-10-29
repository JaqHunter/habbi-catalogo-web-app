const mysql = require('mysql2/promise');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

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

    // 1. Obtener datos de configuración (tasa, nombre del comercio, teléfono)
    const [configs] = await connection.execute('SELECT clave, valor FROM configuracion');
    const configMap = {};
    configs.forEach(row => {
      configMap[row.clave] = row.valor;
    });

    // 2. Obtener productos activos con stock
    const [productos] = await connection.execute(`
      SELECT p.id, p.nombre, p.precio_usd, p.stock, p.imagen_url, c.nombre AS categoria
      FROM productos p
      LEFT JOIN categorias c ON p.categoria_id = c.id
      WHERE p.activo = 1 AND p.stock > 0
      ORDER BY p.id DESC
    `);

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