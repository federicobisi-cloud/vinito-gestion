require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const path = require('path');

const app = express();
// Railway y el reverse proxy de vinitorosario.com terminan el HTTPS antes de
// llegar acá; sin esto Express no reconoce la conexión como segura y
// express-session no persiste bien la cookie de sesión (login "fantasma").
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : (process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false),
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'vinito2025';
const READER_PASSWORD = process.env.READER_PASSWORD || 'lector123';

app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'cambiar-este-secreto-en-produccion',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 12, // 12 horas
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    },
  })
);

// ---------- Helpers ----------
function requireAdmin(req, res, next) {
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Solo el administrador puede realizar esta acción' });
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.session.role) {
    return res.status(401).json({ error: 'No autenticado' });
  }
  next();
}

// ---------- Auth ----------
app.post('/api/auth/login', (req, res) => {
  const { user, password } = req.body;
  if (user === 'admin' && password === ADMIN_PASSWORD) {
    req.session.role = 'admin';
    return res.json({ role: 'admin' });
  }
  if (user === 'reader' && password === READER_PASSWORD) {
    req.session.role = 'reader';
    return res.json({ role: 'reader' });
  }
  return res.status(401).json({ error: 'Contraseña incorrecta' });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/session', (req, res) => {
  res.json({ role: req.session.role || null });
});

// ---------- Estado completo ----------
app.get('/api/state', requireAuth, async (req, res) => {
  try {
    const [prov, bol, chq, emails] = await Promise.all([
      pool.query('SELECT * FROM proveedores ORDER BY nombre ASC'),
      pool.query('SELECT * FROM boletas ORDER BY id DESC'),
      pool.query('SELECT * FROM cheques ORDER BY id DESC'),
      pool.query('SELECT email FROM alert_emails ORDER BY id ASC'),
    ]);
    res.json({
      role: req.session.role,
      proveedores: prov.rows,
      boletas: bol.rows,
      cheques: chq.rows,
      alertEmails: emails.rows.map((r) => r.email),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cargar los datos' });
  }
});

// ---------- Proveedores ----------
app.post('/api/proveedores', requireAdmin, async (req, res) => {
  const { nombre, categoria, cuit, telefono, email, dias, nota } = req.body;
  if (!nombre || !nombre.trim()) {
    return res.status(400).json({ error: 'Ingresá el nombre del proveedor' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO proveedores (nombre, categoria, cuit, telefono, email, dias, nota)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [nombre.trim(), categoria, cuit, telefono, email, dias, nota]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al guardar el proveedor' });
  }
});

// ---------- Boletas ----------
app.post('/api/boletas', requireAdmin, async (req, res) => {
  const {
    tipoDoc, tipoFact, proveedor, numero, fecha, vencimiento,
    formaPago, local, neto, iva, monto, descripcion, notas,
    cheque, // { numero, banco, fechaCheque } | null
  } = req.body;

  if (!proveedor || !fecha) {
    return res.status(400).json({ error: 'Completá los campos obligatorios' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const isCheque = formaPago === 'cheque';
    const estadoInicial = isCheque ? 'cheque_pendiente' : 'deuda';

    const boletaResult = await client.query(
      `INSERT INTO boletas
        (tipo_doc, tipo_fact, proveedor, numero, fecha, vencimiento, forma_pago, local, neto, iva, monto, descripcion, notas, estado)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [tipoDoc, tipoFact || null, proveedor, numero || null, fecha, vencimiento || null,
       formaPago, local, neto || 0, iva || 0, monto, descripcion || null, notas || null, estadoInicial]
    );
    const boleta = boletaResult.rows[0];

    let chequeRow = null;
    if (isCheque) {
      const chequeResult = await client.query(
        `INSERT INTO cheques (numero, proveedor, banco, fecha_emision, fecha_cheque, monto, estado, boleta_id)
         VALUES ($1,$2,$3,$4,$5,$6,'pendiente',$7) RETURNING *`,
        [cheque?.numero || null, proveedor, cheque?.banco || null, fecha,
         cheque?.fechaCheque || fecha, monto, boleta.id]
      );
      chequeRow = chequeResult.rows[0];
      await client.query('UPDATE boletas SET cheque_id=$1 WHERE id=$2', [chequeRow.id, boleta.id]);
      boleta.cheque_id = chequeRow.id;
    }

    await client.query('COMMIT');
    res.json({ boleta, cheque: chequeRow });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al guardar la boleta' });
  } finally {
    client.release();
  }
});

// Edición de una boleta ya cargada (monto, número, fecha, etc.)
app.put('/api/boletas/:id', requireAdmin, async (req, res) => {
  const {
    tipoDoc, tipoFact, proveedor, numero, fecha, vencimiento,
    formaPago, local, neto, iva, monto, descripcion, notas,
    cheque, // { numero, banco, fechaCheque } | null
  } = req.body;

  if (!proveedor || !fecha) {
    return res.status(400).json({ error: 'Completá los campos obligatorios' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existingResult = await client.query('SELECT * FROM boletas WHERE id=$1', [req.params.id]);
    const existing = existingResult.rows[0];
    if (!existing) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Boleta no encontrada' });
    }

    const isCheque = formaPago === 'cheque';
    let chequeId = existing.cheque_id;

    if (existing.cheque_id && !isCheque) {
      // Dejó de pagarse con cheque: eliminamos el cheque asociado.
      await client.query('DELETE FROM cheques WHERE id=$1', [existing.cheque_id]);
      chequeId = null;
    } else if (existing.cheque_id && isCheque) {
      // Sigue siendo cheque: actualizamos sus datos.
      await client.query(
        `UPDATE cheques SET numero=$1, proveedor=$2, banco=$3, fecha_emision=$4, fecha_cheque=$5, monto=$6 WHERE id=$7`,
        [cheque?.numero || null, proveedor, cheque?.banco || null, fecha, cheque?.fechaCheque || fecha, monto, existing.cheque_id]
      );
    } else if (!existing.cheque_id && isCheque) {
      // Pasó a pagarse con cheque: creamos uno nuevo.
      const chequeResult = await client.query(
        `INSERT INTO cheques (numero, proveedor, banco, fecha_emision, fecha_cheque, monto, estado, boleta_id)
         VALUES ($1,$2,$3,$4,$5,$6,'pendiente',$7) RETURNING *`,
        [cheque?.numero || null, proveedor, cheque?.banco || null, fecha, cheque?.fechaCheque || fecha, monto, existing.id]
      );
      chequeId = chequeResult.rows[0].id;
    }

    // Preservamos el estado salvo que el cambio de forma de pago lo requiera.
    let estado = existing.estado;
    if (isCheque && existing.forma_pago !== 'cheque') estado = 'cheque_pendiente';
    if (!isCheque && existing.estado === 'cheque_pendiente') estado = 'deuda';

    const updateResult = await client.query(
      `UPDATE boletas SET
        tipo_doc=$1, tipo_fact=$2, proveedor=$3, numero=$4, fecha=$5, vencimiento=$6,
        forma_pago=$7, local=$8, neto=$9, iva=$10, monto=$11, descripcion=$12, notas=$13,
        estado=$14, cheque_id=$15
       WHERE id=$16 RETURNING *`,
      [tipoDoc, tipoFact || null, proveedor, numero || null, fecha, vencimiento || null,
       formaPago, local, neto || 0, iva, monto, descripcion || null, notas || null,
       estado, chequeId, req.params.id]
    );

    await client.query('COMMIT');
    res.json(updateResult.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar la boleta' });
  } finally {
    client.release();
  }
});

app.put('/api/boletas/:id/pagar', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE boletas SET estado='pagado' WHERE id=$1 AND estado<>'pagado' RETURNING *`,
      [req.params.id]
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar la boleta' });
  }
});

app.post('/api/boletas/bulk-pagar', requireAdmin, async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.json({ updated: 0 });
  try {
    const result = await pool.query(
      `UPDATE boletas SET estado='pagado' WHERE id = ANY($1::int[]) AND estado<>'pagado'`,
      [ids]
    );
    res.json({ updated: result.rowCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar las boletas' });
  }
});

app.delete('/api/boletas/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM boletas WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar la boleta' });
  }
});

// ---------- Cheques ----------
app.put('/api/cheques/:id/acreditar', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const chequeResult = await client.query(
      `UPDATE cheques SET estado='acreditado' WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    const cheque = chequeResult.rows[0];
    if (cheque && cheque.boleta_id) {
      await client.query(`UPDATE boletas SET estado='pagado' WHERE id=$1`, [cheque.boleta_id]);
    }
    await client.query('COMMIT');
    res.json(cheque || null);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar el cheque' });
  } finally {
    client.release();
  }
});

// ---------- Config de alertas por email ----------
app.put('/api/email-config', requireAdmin, async (req, res) => {
  const { emails } = req.body;
  if (!Array.isArray(emails)) return res.status(400).json({ error: 'Formato inválido' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM alert_emails');
    for (const email of emails) {
      if (email && email.includes('@')) {
        await client.query('INSERT INTO alert_emails (email) VALUES ($1) ON CONFLICT DO NOTHING', [email]);
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al guardar la configuración' });
  } finally {
    client.release();
  }
});

// ---------- Estáticos ----------
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Vinito gestión escuchando en puerto ${PORT}`);
});
