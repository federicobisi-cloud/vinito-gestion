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
// Sin SOCIO_PASSWORD configurada en Railway el usuario Socio queda deshabilitado
// (el repo es público, así que no dejamos una contraseña por defecto).
const SOCIO_PASSWORD = process.env.SOCIO_PASSWORD || null;

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
  if (user === 'socio' && SOCIO_PASSWORD && password === SOCIO_PASSWORD) {
    req.session.role = 'socio';
    return res.json({ role: 'socio' });
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

// Edición de un proveedor ya cargado. Si se le cambia el nombre, actualizamos
// también las boletas y cheques existentes para no perder el vínculo.
app.put('/api/proveedores/:id', requireAdmin, async (req, res) => {
  const { nombre, categoria, cuit, telefono, email, dias, nota } = req.body;
  if (!nombre || !nombre.trim()) {
    return res.status(400).json({ error: 'Ingresá el nombre del proveedor' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existingResult = await client.query('SELECT * FROM proveedores WHERE id=$1', [req.params.id]);
    const existing = existingResult.rows[0];
    if (!existing) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Proveedor no encontrado' });
    }
    const nuevoNombre = nombre.trim();
    const result = await client.query(
      `UPDATE proveedores SET nombre=$1, categoria=$2, cuit=$3, telefono=$4, email=$5, dias=$6, nota=$7
       WHERE id=$8 RETURNING *`,
      [nuevoNombre, categoria, cuit, telefono, email, dias, nota, req.params.id]
    );
    if (existing.nombre !== nuevoNombre) {
      await client.query('UPDATE boletas SET proveedor=$1 WHERE proveedor=$2', [nuevoNombre, existing.nombre]);
      await client.query('UPDATE cheques SET proveedor=$1 WHERE proveedor=$2', [nuevoNombre, existing.nombre]);
    }
    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar el proveedor' });
  } finally {
    client.release();
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
  const { formaPagoReal } = req.body || {};
  try {
    const result = await pool.query(
      `UPDATE boletas SET estado='pagado', pago_real=$1, pago_fecha=CURRENT_DATE WHERE id=$2 AND estado<>'pagado' RETURNING *`,
      [formaPagoReal || null, req.params.id]
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar la boleta' });
  }
});

// Revierte una boleta pagada por error, de vuelta a "deuda" (o "cheque_pendiente" si era a cheque).
app.put('/api/boletas/:id/despagar', requireAdmin, async (req, res) => {
  try {
    const existingResult = await pool.query('SELECT * FROM boletas WHERE id=$1', [req.params.id]);
    const existing = existingResult.rows[0];
    if (!existing) return res.status(404).json({ error: 'Boleta no encontrada' });
    const nuevoEstado = existing.forma_pago === 'cheque' ? 'cheque_pendiente' : 'deuda';
    const result = await pool.query(
      `UPDATE boletas SET estado=$1, pago_real=NULL, pago_fecha=NULL WHERE id=$2 RETURNING *`,
      [nuevoEstado, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al revertir el pago' });
  }
});

app.post('/api/boletas/bulk-pagar', requireAdmin, async (req, res) => {
  const { ids, formaPagoReal } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.json({ updated: 0 });
  try {
    const result = await pool.query(
      `UPDATE boletas SET estado='pagado', pago_real=$1, pago_fecha=CURRENT_DATE WHERE id = ANY($2::int[]) AND estado<>'pagado'`,
      [formaPagoReal || null, ids]
    );
    res.json({ updated: result.rowCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar las boletas' });
  }
});

app.delete('/api/boletas/:id', requireAdmin, async (req, res) => {
  try {
    // si era una factura de vinos que sumó stock, se borran también esos ingresos
    await pool.query(`DELETE FROM vino_movimientos WHERE grupo LIKE $1`, [`bol-${Number(req.params.id)}-%`]).catch(() => {});
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
      await client.query(`UPDATE boletas SET estado='pagado', pago_real='cheque', pago_fecha=CURRENT_DATE WHERE id=$1`, [cheque.boleta_id]);
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

// =====================================================================
// ---------- VINOS: catálogo, movimientos de stock y conteos ----------
// El stock NO se guarda como un número: es la suma de los movimientos
// (ingresos +, ventas/copas/roturas/consumo/devoluciones −, ajustes ±).
// Así el día que el sistema de ventas descuente solo, alcanza con que
// inserte movimientos de tipo 'venta' o 'copa'.
// =====================================================================
// Cada local maneja su propio stock de vinos.
const LOCALES_VINO = ['Wheelwright', 'Pichincha'];
// signo que aplica cada tipo sobre la cantidad que se carga (siempre positiva)
const SIGNO_MOV = { ingreso: 1, venta: -1, copa: -1, rotura: -1, consumo: -1, devolucion: -1 };

async function initVinos() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vinos (
      id                SERIAL PRIMARY KEY,
      nombre            TEXT NOT NULL,
      bodega            TEXT,
      varietal          TEXT,
      anada             TEXT,
      tipo              TEXT,
      proveedor         TEXT,
      costo             NUMERIC DEFAULT 0,
      precio_botella    NUMERIC DEFAULT 0,
      precio_copa       NUMERIC DEFAULT 0,
      copas_por_botella NUMERIC DEFAULT 5,
      stock_minimo      NUMERIC DEFAULT 0,
      activo            BOOLEAN DEFAULT true,
      created_at        TIMESTAMPTZ DEFAULT now(),
      updated_at        TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS vino_movimientos (
      id          SERIAL PRIMARY KEY,
      vino_id     INTEGER NOT NULL REFERENCES vinos(id) ON DELETE CASCADE,
      local       TEXT NOT NULL,
      tipo        TEXT NOT NULL,
      cantidad    NUMERIC NOT NULL,
      costo_unit  NUMERIC,
      precio_unit NUMERIC,
      fecha       DATE NOT NULL DEFAULT CURRENT_DATE,
      nota        TEXT,
      grupo       TEXT,
      usuario     TEXT,
      created_at  TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_vmov_vino ON vino_movimientos(vino_id);
    CREATE INDEX IF NOT EXISTS idx_vmov_fecha ON vino_movimientos(fecha);
    UPDATE vino_movimientos SET local='Wheelwright' WHERE local='Centro';
    ALTER TABLE vinos ADD COLUMN IF NOT EXISTS region TEXT;
    ALTER TABLE vinos ADD COLUMN IF NOT EXISTS clave TEXT;
    ALTER TABLE vinos ADD COLUMN IF NOT EXISTS referente TEXT;
    CREATE INDEX IF NOT EXISTS idx_vinos_clave ON vinos(clave);
    -- qué vinos trabaja cada local (cada local tiene su carta y su stock)
    CREATE TABLE IF NOT EXISTS vino_locales (
      vino_id INTEGER NOT NULL REFERENCES vinos(id) ON DELETE CASCADE,
      local   TEXT NOT NULL,
      PRIMARY KEY (vino_id, local)
    );
    INSERT INTO vino_locales (vino_id, local)
      SELECT DISTINCT vino_id, local FROM vino_movimientos ON CONFLICT DO NOTHING;
    -- planillas de Google Sheets de cada local: 'catalogo' (carta con costos) y 'stock' (la que carga el encargado)
    CREATE TABLE IF NOT EXISTS vino_planillas (
      local TEXT NOT NULL,
      tipo  TEXT NOT NULL,
      url   TEXT,
      ultima_sync TIMESTAMPTZ,
      PRIMARY KEY (local, tipo)
    );
    INSERT INTO vino_planillas (local, tipo, url) VALUES
      ('Wheelwright', 'catalogo', 'https://docs.google.com/spreadsheets/d/1UwBQvJmzbi9fmOcTMXl660n2D3lmuWa5vgRgsAiVAyM/edit?gid=0'),
      ('Pichincha', 'catalogo', 'https://docs.google.com/spreadsheets/d/1XrxCwVQ95iD_Z6fQP7ARj1IzM6Fg6TFB2H1UzUY2f3M/edit?gid=1162959689')
      ON CONFLICT DO NOTHING;
    UPDATE vino_planillas SET url='https://docs.google.com/spreadsheets/d/1XrxCwVQ95iD_Z6fQP7ARj1IzM6Fg6TFB2H1UzUY2f3M/edit?gid=1162959689'
      WHERE local='Pichincha' AND tipo='catalogo' AND (url IS NULL OR url='');
    -- planilla de stock que completa el encargado (una pestaña por local)
    INSERT INTO vino_planillas (local, tipo, url) VALUES
      ('Wheelwright', 'stock', 'https://docs.google.com/spreadsheets/d/1M-n_xUKsHo12LEgYTCI8bp3ARBOA0nRq_zaS_qQZv5Q/edit?gid=1834524866'),
      ('Pichincha', 'stock', 'https://docs.google.com/spreadsheets/d/1M-n_xUKsHo12LEgYTCI8bp3ARBOA0nRq_zaS_qQZv5Q/edit?gid=116525467')
      ON CONFLICT (local, tipo) DO UPDATE SET url=EXCLUDED.url WHERE vino_planillas.url IS NULL OR vino_planillas.url='';
    -- borra los vinos basura que creó la sincronización vieja del catálogo de Wheelwright
    -- (quedaron con un precio como nombre, ej. "$10.333")
    DELETE FROM vinos WHERE nombre ~ '^\\s*\\$\\s*[0-9.,]+\\s*$';
    -- DEUDAS de vinos: son boletas comunes marcadas como de vinos, con el detalle de botellas
    ALTER TABLE boletas ADD COLUMN IF NOT EXISTS es_vino BOOLEAN DEFAULT false;
    ALTER TABLE boletas ADD COLUMN IF NOT EXISTS suma_stock BOOLEAN DEFAULT false;
    CREATE TABLE IF NOT EXISTS boleta_vinos (
      id         SERIAL PRIMARY KEY,
      boleta_id  INTEGER NOT NULL REFERENCES boletas(id) ON DELETE CASCADE,
      vino_id    INTEGER NOT NULL REFERENCES vinos(id) ON DELETE CASCADE,
      cantidad   NUMERIC NOT NULL,
      costo_unit NUMERIC
    );
    CREATE INDEX IF NOT EXISTS idx_bvinos_boleta ON boleta_vinos(boleta_id);
    -- CIERRES de stock: cada sincronización de la planilla de stock guarda una foto del stock del local
    -- (una por día; si se sincroniza dos veces el mismo día se reemplaza la foto y se suma la reposición).
    -- consumo entre dos cierres = stock anterior + reposición − stock actual
    CREATE TABLE IF NOT EXISTS vino_cierres (
      id         SERIAL PRIMARY KEY,
      local      TEXT NOT NULL,
      fecha      DATE NOT NULL,
      usuario    TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (local, fecha)
    );
    CREATE TABLE IF NOT EXISTS vino_cierre_items (
      cierre_id  INTEGER NOT NULL REFERENCES vino_cierres(id) ON DELETE CASCADE,
      vino_id    INTEGER NOT NULL REFERENCES vinos(id) ON DELETE CASCADE,
      stock      NUMERIC NOT NULL DEFAULT 0,
      reposicion NUMERIC NOT NULL DEFAULT 0,
      PRIMARY KEY (cierre_id, vino_id)
    );
  `);
}
initVinos().catch((err) => console.error('Error creando tablas de vinos:', err));

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function precioVentaPorBotella(vino, tipo) {
  if (tipo === 'venta') return num(vino.precio_botella);
  if (tipo === 'copa') return num(vino.precio_copa) * (num(vino.copas_por_botella) || 1);
  return null;
}
function vinoParams(b) {
  return [
    (b.nombre || '').trim(), b.bodega || null, b.varietal || null, b.anada || null, b.tipo || null,
    b.proveedor || null, num(b.costo), num(b.precioBotella), num(b.precioCopa),
    num(b.copasPorBotella) || 5, num(b.stockMinimo), b.activo !== false, b.region || null,
  ];
}
async function vincularLocal(db, vinoId, local) {
  if (!LOCALES_VINO.includes(local)) return;
  await db.query('INSERT INTO vino_locales (vino_id, local) VALUES ($1,$2) ON CONFLICT DO NOTHING', [vinoId, local]);
}

// El lector (contadora) no ve el stock de vinos: solo admin y socio.
app.get('/api/vinos/state', requireAdminOSocio, async (req, res) => {
  try {
    const [vinos, movs, vlocs, bvin] = await Promise.all([
      pool.query('SELECT * FROM vinos ORDER BY nombre ASC'),
      pool.query(`SELECT id, vino_id, local, tipo, cantidad, costo_unit, precio_unit,
                         to_char(fecha,'YYYY-MM-DD') AS fecha, nota, grupo, usuario
                  FROM vino_movimientos ORDER BY fecha DESC, id DESC`),
      pool.query('SELECT vino_id, local FROM vino_locales'),
      pool.query('SELECT boleta_id, vino_id, cantidad, costo_unit FROM boleta_vinos ORDER BY id ASC').catch(() => ({ rows: [] })),
    ]);
    res.json({ vinos: vinos.rows, movimientos: movs.rows, vinoLocales: vlocs.rows, locales: LOCALES_VINO, boletaVinos: bvin.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cargar los vinos' });
  }
});

// Cierres de stock (fotos de cada sincronización) para calcular el consumo semanal/mensual/anual.
app.get('/api/vinos/consumo', requireAdminOSocio, async (req, res) => {
  try {
    const [c, i] = await Promise.all([
      pool.query("SELECT id, local, to_char(fecha,'YYYY-MM-DD') AS fecha FROM vino_cierres ORDER BY local, fecha"),
      pool.query('SELECT cierre_id, vino_id, stock, reposicion FROM vino_cierre_items'),
    ]);
    res.json({ cierres: c.rows, items: i.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cargar el consumo' });
  }
});

app.post('/api/vinos', requireAdmin, async (req, res) => {
  if (!req.body.nombre || !req.body.nombre.trim()) return res.status(400).json({ error: 'Ingresá el nombre del vino' });
  try {
    const r = await pool.query(
      `INSERT INTO vinos (nombre, bodega, varietal, anada, tipo, proveedor, costo, precio_botella, precio_copa, copas_por_botella, stock_minimo, activo, region)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      vinoParams(req.body)
    );
    await vincularLocal(pool, r.rows[0].id, req.body.local);
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al guardar el vino' });
  }
});

app.put('/api/vinos/:id', requireAdmin, async (req, res) => {
  if (!req.body.nombre || !req.body.nombre.trim()) return res.status(400).json({ error: 'Ingresá el nombre del vino' });
  try {
    const r = await pool.query(
      `UPDATE vinos SET nombre=$1, bodega=$2, varietal=$3, anada=$4, tipo=$5, proveedor=$6, costo=$7,
         precio_botella=$8, precio_copa=$9, copas_por_botella=$10, stock_minimo=$11, activo=$12, region=$13, updated_at=now()
       WHERE id=$14 RETURNING *`,
      [...vinoParams(req.body), req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Vino no encontrado' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar el vino' });
  }
});

// Solo se puede borrar un vino sin movimientos; si ya tuvo, se desactiva.
app.delete('/api/vinos/:id', requireAdmin, async (req, res) => {
  try {
    const m = await pool.query('SELECT COUNT(*)::int AS n FROM vino_movimientos WHERE vino_id=$1', [req.params.id]);
    if (m.rows[0].n > 0) {
      await pool.query('UPDATE vinos SET activo=false, updated_at=now() WHERE id=$1', [req.params.id]);
      return res.json({ ok: true, desactivado: true });
    }
    await pool.query('DELETE FROM vinos WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar el vino' });
  }
});

// Carga de movimientos. Body: { tipo, local, localDestino?, fecha, nota, items: [{ vinoId, cantidad }] }
app.post('/api/vinos/movimientos', requireAdmin, async (req, res) => {
  const { tipo, local, localDestino, fecha, nota } = req.body;
  const items = Array.isArray(req.body.items) ? req.body.items.filter((i) => i && i.vinoId && num(i.cantidad) !== 0) : [];
  const validos = [...Object.keys(SIGNO_MOV), 'ajuste', 'transferencia'];
  if (!validos.includes(tipo)) return res.status(400).json({ error: 'Tipo de movimiento inválido' });
  if (!LOCALES_VINO.includes(local)) return res.status(400).json({ error: 'Elegí el local' });
  if (tipo === 'transferencia' && (!LOCALES_VINO.includes(localDestino) || localDestino === local)) {
    return res.status(400).json({ error: 'Elegí un local de destino distinto al de origen' });
  }
  if (!items.length) return res.status(400).json({ error: 'Cargá al menos un vino con cantidad' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ids = items.map((i) => Number(i.vinoId));
    const vr = await client.query('SELECT * FROM vinos WHERE id = ANY($1::int[])', [ids]);
    const byId = Object.fromEntries(vr.rows.map((v) => [v.id, v]));
    let creados = 0;
    for (const it of items) {
      const vino = byId[Number(it.vinoId)];
      if (!vino) continue;
      const cant = num(it.cantidad);
      const grupo = tipo === 'transferencia' ? `tr-${Date.now()}-${vino.id}-${creados}` : null;
      const rows = [];
      if (tipo === 'ajuste') rows.push([local, cant]);
      else if (tipo === 'transferencia') rows.push([local, -Math.abs(cant)], [localDestino, Math.abs(cant)]);
      else rows.push([local, SIGNO_MOV[tipo] * Math.abs(cant)]);
      for (const [lc, c] of rows) {
        await vincularLocal(client, vino.id, lc);
        await client.query(
          `INSERT INTO vino_movimientos (vino_id, local, tipo, cantidad, costo_unit, precio_unit, fecha, nota, grupo, usuario)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [vino.id, lc, tipo, c, num(vino.costo), precioVentaPorBotella(vino, tipo), fecha || new Date().toISOString().slice(0, 10),
           nota || (tipo === 'transferencia' ? `Transferencia ${local} → ${localDestino}` : null), grupo, req.session.role]
        );
        creados++;
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true, creados });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al guardar el movimiento' });
  } finally {
    client.release();
  }
});

// Borra un movimiento (y su contraparte si era una transferencia).
app.delete('/api/vinos/movimientos/:id', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT grupo FROM vino_movimientos WHERE id=$1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Movimiento no encontrado' });
    if (r.rows[0].grupo) await pool.query('DELETE FROM vino_movimientos WHERE grupo=$1', [r.rows[0].grupo]);
    else await pool.query('DELETE FROM vino_movimientos WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar el movimiento' });
  }
});

// Conteo físico: compara lo contado con el stock del sistema y genera los ajustes.
// Body: { local, fecha, items: [{ vinoId, contado }] }
app.post('/api/vinos/conteo', requireAdmin, async (req, res) => {
  const { local, fecha } = req.body;
  const items = Array.isArray(req.body.items) ? req.body.items.filter((i) => i && i.vinoId && i.contado !== '' && i.contado != null) : [];
  if (!LOCALES_VINO.includes(local)) return res.status(400).json({ error: 'Elegí el local' });
  if (!items.length) return res.status(400).json({ error: 'No cargaste ninguna cantidad' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ids = items.map((i) => Number(i.vinoId));
    const vr = await client.query('SELECT * FROM vinos WHERE id = ANY($1::int[])', [ids]);
    const byId = Object.fromEntries(vr.rows.map((v) => [v.id, v]));
    const sr = await client.query(
      'SELECT vino_id, COALESCE(SUM(cantidad),0) AS stock FROM vino_movimientos WHERE local=$1 AND vino_id = ANY($2::int[]) GROUP BY vino_id',
      [local, ids]
    );
    const stock = Object.fromEntries(sr.rows.map((r) => [r.vino_id, num(r.stock)]));
    let ajustes = 0;
    for (const it of items) {
      const vino = byId[Number(it.vinoId)];
      if (!vino) continue;
      const contado = num(it.contado);
      const sistema = stock[vino.id] || 0;
      const dif = contado - sistema;
      if (dif === 0) continue;
      await client.query(
        `INSERT INTO vino_movimientos (vino_id, local, tipo, cantidad, costo_unit, fecha, nota, usuario)
         VALUES ($1,$2,'ajuste',$3,$4,$5,$6,$7)`,
        [vino.id, local, dif, num(vino.costo), fecha || new Date().toISOString().slice(0, 10),
         `Conteo físico: contado ${contado}, sistema ${sistema}`, req.session.role]
      );
      ajustes++;
    }
    await client.query('COMMIT');
    res.json({ ok: true, ajustes, contados: items.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al guardar el conteo' });
  } finally {
    client.release();
  }
});

// =====================================================================
// ---------- DEUDAS DE VINOS ----------
// Una factura de vinos es una boleta común (aparece también en Boletas/Cheques)
// marcada es_vino, con el detalle de botellas en boleta_vinos.
// Estado: 'deuda' = cheque por emitir · 'cheque_pendiente' = cheque emitido · 'pagado'.
// Si suma_stock, cada vino genera un movimiento 'ingreso' (grupo bol-<boleta>-<vino>).
// =====================================================================
const BOLETA_LOCAL = { Wheelwright: 'Centro', Pichincha: 'Pichincha' }; // en boletas Wheelwright figura como "Centro"

app.post('/api/vinos/deudas', requireAdmin, async (req, res) => {
  const { local, proveedor, numero, fecha, vencimiento, tipoDoc, tipoFact, iva, monto, notas, chequeEmitido, cheque } = req.body;
  const sumaStock = req.body.sumaStock === true;
  const items = Array.isArray(req.body.items) ? req.body.items.filter((i) => i && i.vinoId && num(i.cantidad) > 0) : [];
  if (!LOCALES_VINO.includes(local)) return res.status(400).json({ error: 'Elegí el local' });
  if (!proveedor || !String(proveedor).trim()) return res.status(400).json({ error: 'Elegí el proveedor' });
  if (!fecha) return res.status(400).json({ error: 'Completá la fecha' });
  if (!(num(monto) > 0)) return res.status(400).json({ error: 'Ingresá el total de la factura' });
  if (!items.length) return res.status(400).json({ error: 'Cargá al menos un vino con cantidad' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ids = items.map((i) => Number(i.vinoId));
    const vr = await client.query('SELECT * FROM vinos WHERE id = ANY($1::int[])', [ids]);
    const byId = Object.fromEntries(vr.rows.map((v) => [v.id, v]));
    const total = num(monto);
    const alic = num(iva);
    const neto = alic > 0 ? total / (1 + alic / 100) : total;
    const botellas = items.reduce((a, i) => a + num(i.cantidad), 0);
    const prov = String(proveedor).trim();
    const td = tipoDoc === 'remito' ? 'remito' : 'factura';

    const b = await client.query(
      `INSERT INTO boletas
        (tipo_doc, tipo_fact, proveedor, numero, fecha, vencimiento, forma_pago, local, neto, iva, monto, descripcion, notas, estado, es_vino, suma_stock)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,$15) RETURNING *`,
      [td, td === 'factura' ? (tipoFact || 'A') : null, prov, numero || null, fecha, vencimiento || null,
       chequeEmitido ? 'cheque' : 'cuenta_corriente', BOLETA_LOCAL[local], neto, td === 'factura' ? alic : 0, total,
       `Vinos ${local}: ${botellas} botellas (${items.length} etiqueta${items.length !== 1 ? 's' : ''})`,
       notas || null, chequeEmitido ? 'cheque_pendiente' : 'deuda', sumaStock]
    );
    const boleta = b.rows[0];

    if (chequeEmitido) {
      const ck = await client.query(
        `INSERT INTO cheques (numero, proveedor, banco, fecha_emision, fecha_cheque, monto, estado, boleta_id)
         VALUES ($1,$2,$3,$4,$5,$6,'pendiente',$7) RETURNING id`,
        [cheque?.numero || null, prov, cheque?.banco || null, fecha, cheque?.fechaCheque || fecha, total, boleta.id]
      );
      await client.query('UPDATE boletas SET cheque_id=$1 WHERE id=$2', [ck.rows[0].id, boleta.id]);
    }

    for (const it of items) {
      const vino = byId[Number(it.vinoId)];
      if (!vino) continue;
      const cant = num(it.cantidad);
      const costo = num(it.costoUnit) > 0 ? num(it.costoUnit) : num(vino.costo);
      await client.query(
        'INSERT INTO boleta_vinos (boleta_id, vino_id, cantidad, costo_unit) VALUES ($1,$2,$3,$4)',
        [boleta.id, vino.id, cant, costo]
      );
      await vincularLocal(client, vino.id, local);
      if (sumaStock) {
        await client.query(
          `INSERT INTO vino_movimientos (vino_id, local, tipo, cantidad, costo_unit, fecha, nota, grupo, usuario)
           VALUES ($1,$2,'ingreso',$3,$4,$5,$6,$7,$8)`,
          [vino.id, local, cant, costo, fecha, `Factura ${numero || 's/n'} · ${prov}`, `bol-${boleta.id}-${vino.id}`, req.session.role]
        );
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true, boleta });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al guardar la factura' });
  } finally {
    client.release();
  }
});

// Emite el (e)cheque de una factura que estaba "por emitir".
app.post('/api/vinos/deudas/:id/emitir-cheque', requireAdmin, async (req, res) => {
  const { numero, banco, fechaCheque } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM boletas WHERE id=$1', [req.params.id]);
    const b = r.rows[0];
    if (!b) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Factura no encontrada' }); }
    if (b.estado !== 'deuda') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Esta factura no está pendiente de emitir cheque' }); }
    const hoy = new Date().toISOString().slice(0, 10);
    const ck = await client.query(
      `INSERT INTO cheques (numero, proveedor, banco, fecha_emision, fecha_cheque, monto, estado, boleta_id)
       VALUES ($1,$2,$3,$4,$5,$6,'pendiente',$7) RETURNING id`,
      [numero || null, b.proveedor, banco || null, hoy, fechaCheque || hoy, b.monto, b.id]
    );
    await client.query(`UPDATE boletas SET forma_pago='cheque', estado='cheque_pendiente', cheque_id=$1 WHERE id=$2`, [ck.rows[0].id, b.id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al emitir el cheque' });
  } finally {
    client.release();
  }
});

// =====================================================================
// ---------- SINCRONIZACIÓN CON GOOGLE SHEETS ----------
// Usa la misma cuenta de servicio que la carta de Wheelwright
// (variable GOOGLE_CREDENTIALS). Cada planilla tiene que estar compartida
// con el email de esa cuenta (solo lectura alcanza).
//  · 'catalogo': la planilla de vinos del local. Columnas: A tipo, C etiqueta,
//    D cepa, F bodega, H región, I distribuidor (en Wheelwright: G), COSTO 26 (o COSTO), N precio carta.
//  · 'stock': la planilla que completa el encargado. Necesita una columna
//    SKU (o ETIQUETA/CEPA/BODEGA) y una columna STOCK con las botellas contadas.
// =====================================================================
let googleSheetsApi = null;
function sheetsClient() {
  if (!process.env.GOOGLE_CREDENTIALS) {
    throw new Error('Falta configurar GOOGLE_CREDENTIALS en Railway (la misma cuenta de servicio que usa la carta de Wheelwright).');
  }
  if (!googleSheetsApi) {
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
      // escritura: la sincronización completa la columna SKU de la planilla de stock
      // (la planilla de stock tiene que estar compartida como Editor con la cuenta de servicio)
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    googleSheetsApi = google.sheets({ version: 'v4', auth });
  }
  return googleSheetsApi;
}
function serviceAccountEmail() {
  try { return JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}').client_email || null; } catch (e) { return null; }
}
function parseSheetUrl(url) {
  const id = (String(url || '').match(/\/d\/([a-zA-Z0-9-_]+)/) || [])[1] || (/^[a-zA-Z0-9-_]{25,}$/.test(url || '') ? url : null);
  const gid = (String(url || '').match(/[#&?]gid=(\d+)/) || [])[1];
  return { id, gid: gid != null ? Number(gid) : null };
}
async function leerHoja(url) {
  const { id, gid } = parseSheetUrl(url);
  if (!id) throw new Error('El link de la planilla no es válido');
  const sheets = sheetsClient();
  let meta;
  try {
    meta = await sheets.spreadsheets.get({ spreadsheetId: id, fields: 'sheets.properties(sheetId,title)' });
  } catch (err) {
    const code = err.code || (err.response && err.response.status);
    if (code === 403 || code === 404) {
      throw new Error(`No tengo acceso a la planilla. Compartila (lector) con ${serviceAccountEmail() || 'la cuenta de servicio'}`);
    }
    throw err;
  }
  const hojas = meta.data.sheets.map((s) => s.properties);
  const hoja = (gid != null && hojas.find((h) => h.sheetId === gid)) || hojas[0];
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: `'${hoja.title.replace(/'/g, "''")}'!A:Z` }); // sin límite de filas
  const filas = r.data.values || [];
  filas.hoja = { id, title: hoja.title }; // para poder escribir después en la misma pestaña
  return filas;
}
// Escribe los SKU nuevos en la planilla de stock (filas que no tenían SKU).
async function escribirSkus(info) {
  if (!info || !info.pendientes.length) return 0;
  const letra = String.fromCharCode(65 + info.colSku);
  const titulo = info.title.replace(/'/g, "''");
  await sheetsClient().spreadsheets.values.batchUpdate({
    spreadsheetId: info.id,
    requestBody: {
      valueInputOption: 'RAW',
      data: info.pendientes.map((p) => ({ range: `'${titulo}'!${letra}${p.fila}`, values: [[p.sku]] })),
    },
  });
  return info.pendientes.length;
}
function skuDe(id) { return 'V' + String(id).padStart(4, '0'); }
function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
}
function claveVino(etiqueta, cepa, bodega) { return [norm(etiqueta), norm(cepa), norm(bodega)].join('|'); }
function plata(v) {
  const s = String(v || '').replace(/[^0-9,.-]/g, '');
  if (!s) return 0;
  // formato argentino: 12.096,50 → 12096.50
  return num(s.replace(/\./g, '').replace(',', '.'));
}
function capitalizar(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

// Busca la fila de encabezados de la planilla de catálogo y ubica cada columna por su nombre
// (Wheelwright y Pichincha tienen las columnas en distinto orden).
function columnasCatalogo(filas) {
  for (let i = 0; i < Math.min(filas.length, 10); i++) {
    const H = (filas[i] || []).map(norm);
    const idx = (...ns) => { for (const n of ns) { const k = H.indexOf(n); if (k >= 0) return k; } return -1; };
    const etiqueta = idx('ETIQUETA', 'ETIQUETAS');
    if (etiqueta < 0) continue;
    return {
      h: i, etiqueta, tipo: idx('VINO', 'TIPO'), cepa: idx('CEPA'), bodega: idx('BODEGA'), region: idx('REGION'),
      proveedor: idx('PROVEEDOR', 'DISTRIBUIDOR'),
      // contacto del proveedor: columna REFERENTE (en Pichincha la columna antes de REGION no tiene título)
      referente: idx('REFERENTE', 'CONTACTO') >= 0 ? idx('REFERENTE', 'CONTACTO') : (idx('REGION') > 0 && H[idx('REGION') - 1] === '' ? idx('REGION') - 1 : -1),
      // costo: primero la columna del año ("COSTO 26"); si esa celda está vacía, la columna COSTO
      costo: H.findIndex((x) => x.startsWith('COSTO') && x !== 'COSTO'),
      costoAlt: idx('COSTO'),
      // precio de carta: "PRECIO CARTA" (Pichincha) o "CARTA 26" (Wheelwright)
      precio: idx('PRECIO CARTA', 'PRECIO') >= 0 ? idx('PRECIO CARTA', 'PRECIO') : H.findIndex((x) => x.startsWith('CARTA')),
    };
  }
  // sin encabezados: formato viejo (A tipo, C etiqueta, D cepa, F bodega, H región, I distribuidor, L costo, N precio)
  return { h: 0, etiqueta: 2, tipo: 0, cepa: 3, bodega: 5, referente: 6, region: 7, proveedor: 8, costo: 11, costoAlt: -1, precio: 13 };
}

async function syncCatalogo(client, local, url) {
  const filas = await leerHoja(url);
  const res = { leidos: 0, creados: 0, actualizados: 0 };
  const c = columnasCatalogo(filas);
  const col = (f, k) => (k >= 0 ? String(f[k] == null ? '' : f[k]).trim() : '');
  const existentes = await client.query('SELECT id, clave, nombre, bodega, varietal FROM vinos');
  const porClave = new Map();
  existentes.rows.forEach((v) => porClave.set(v.clave || claveVino(v.nombre, v.varietal, v.bodega), v.id));
  const vistos = new Set();
  for (let i = c.h + 1; i < filas.length; i++) {
    const f = filas[i] || [];
    const etiqueta = col(f, c.etiqueta);
    if (!etiqueta) continue;
    const tipo = capitalizar(col(f, c.tipo)) || 'Tinto';
    const cepa = col(f, c.cepa) || null;
    const bodega = col(f, c.bodega) || null;
    const region = col(f, c.region) || null;
    const referente = col(f, c.referente) || null;
    const proveedor = col(f, c.proveedor) || null;
    const costo = plata(col(f, c.costo)) || plata(col(f, c.costoAlt));
    const precio = plata(col(f, c.precio));
    const clave = claveVino(etiqueta, cepa, bodega);
    if (vistos.has(clave)) continue; // fila repetida en la planilla
    vistos.add(clave);
    res.leidos++;
    let id = porClave.get(clave);
    if (id) {
      // actualiza datos de la planilla; costo/precio solo si la planilla los trae
      await client.query(
        `UPDATE vinos SET nombre=$1, varietal=$2, bodega=$3, tipo=$4, region=$5, proveedor=COALESCE($6, proveedor),
           costo=CASE WHEN $7::numeric > 0 THEN $7::numeric ELSE costo END,
           precio_botella=CASE WHEN $8::numeric > 0 THEN $8::numeric ELSE precio_botella END,
           clave=$9, referente=COALESCE($11, referente), updated_at=now()
         WHERE id=$10`,
        [etiqueta, cepa, bodega, tipo, region, proveedor, costo, precio, clave, id, referente]
      );
      res.actualizados++;
    } else {
      const r = await client.query(
        `INSERT INTO vinos (nombre, varietal, bodega, tipo, region, proveedor, costo, precio_botella, clave, referente)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [etiqueta, cepa, bodega, tipo, region, proveedor, costo, precio, clave, referente]
      );
      id = r.rows[0].id;
      porClave.set(clave, id);
      res.creados++;
    }
    await vincularLocal(client, id, local);
  }
  return res;
}

async function syncStock(client, local, url, usuario) {
  const filas = await leerHoja(url);
  const res = { filas: 0, ajustes: 0, creados: 0, noEncontrados: [] };
  // busca la fila de encabezados: el stock se toma de la columna TOTAL
  // (Wheelwright: columna M, Pichincha: columna K); si no hay TOTAL, STOCK/CANTIDAD/BOTELLAS
  let h = -1, cols = {};
  for (let i = 0; i < Math.min(filas.length, 10); i++) {
    const head = (filas[i] || []).map(norm);
    let iStock = head.indexOf('TOTAL');
    if (iStock < 0) iStock = head.findIndex((x) => x === 'STOCK' || x.startsWith('STOCK') || x === 'CANTIDAD' || x === 'BOTELLAS');
    if (iStock >= 0) {
      h = i;
      const etq = head.indexOf('ETIQUETA') >= 0 ? head.indexOf('ETIQUETA') : head.indexOf('ETIQUETAS');
      cols = { stock: iStock, sku: head.indexOf('SKU'), tipo: head.indexOf('TIPO'), etiqueta: etq, cepa: head.indexOf('CEPA'), bodega: head.indexOf('BODEGA'),
        // botellas que entraron desde el último cierre (no suma al STOCK de la planilla)
        repo: head.findIndex((x) => x.startsWith('REPOSICION')) };
      break;
    }
  }
  if (h < 0) throw new Error('La planilla de stock necesita una columna llamada TOTAL (o STOCK)');
  const vinos = await client.query('SELECT * FROM vinos');
  const porId = new Map(vinos.rows.map((v) => [v.id, v]));
  const porClave = new Map(vinos.rows.map((v) => [v.clave || claveVino(v.nombre, v.varietal, v.bodega), v]));
  const sr = await client.query('SELECT vino_id, COALESCE(SUM(cantidad),0) AS stock FROM vino_movimientos WHERE local=$1 GROUP BY vino_id', [local]);
  const stock = new Map(sr.rows.map((r) => [r.vino_id, num(r.stock)]));
  const hoy = new Date().toISOString().slice(0, 10);
  const val = (f, k) => (k >= 0 && f[k] != null ? String(f[k]).trim() : '');
  const contados = new Map(); // vino_id -> { vino, contado } (si un vino aparece en dos filas, se suman)
  const skuPendientes = []; // filas sin SKU: se completan en la planilla después del COMMIT
  const repoFilas = []; // filas con REPOSICION cargada: se vacían en la planilla después del COMMIT
  // cuántas veces aparece cada SKU: si es único se confía en él aunque el nombre en la planilla haya cambiado
  const skuCount = new Map();
  for (let i = h + 1; i < filas.length; i++) {
    const s = val(filas[i] || [], cols.sku).toUpperCase();
    if (s) skuCount.set(s, (skuCount.get(s) || 0) + 1);
  }
  for (let i = h + 1; i < filas.length; i++) {
    const f = filas[i] || [];
    const etiqueta = val(f, cols.etiqueta), sku = val(f, cols.sku);
    if (!etiqueta && !sku) continue; // filas vacías o de totales
    const crudo = val(f, cols.stock);
    if (crudo === '') continue;
    const contado = num(crudo.replace(',', '.'));
    const cepaF = val(f, cols.cepa), bodegaF = val(f, cols.bodega), tipoN = norm(val(f, cols.tipo));
    const clave = claveVino(etiqueta, cepaF, bodegaF);
    const claveTipo = tipoN ? clave + '|' + tipoN : clave;
    let vino = null;
    // 1) por SKU (es el id del vino en el sistema). Si el SKU está repetido en la planilla
    //    (ej. VARIETE malbec y cab franc con el mismo SKU) solo se usa si etiqueta/cepa/bodega coinciden.
    if (sku) {
      const m = sku.toUpperCase().match(/V?0*(\d+)/);
      const v = m ? porId.get(Number(m[1])) : null;
      const unico = skuCount.get(sku.toUpperCase()) === 1;
      if (v && (!etiqueta || unico || [clave, claveTipo].includes(v.clave || claveVino(v.nombre, v.varietal, v.bodega)))) vino = v;
    }
    // 2) por etiqueta + cepa + bodega + tipo (ej. KAMALA cab franc tinto y rosado son vinos distintos)
    if (!vino && etiqueta) {
      const v = porClave.get(claveTipo) || porClave.get(clave);
      if (v && (!tipoN || !v.tipo || norm(v.tipo) === tipoN)) vino = v;
    }
    // 3) vino nuevo en la planilla de stock que todavía no está en el sistema: se da de alta
    if (!vino && etiqueta) {
      const nueva = porClave.has(clave) ? claveTipo : clave; // si ya existe con otro tipo, la clave lleva el tipo
      const ins = await client.query(
        `INSERT INTO vinos (nombre, varietal, bodega, tipo, clave) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [etiqueta, cepaF || null, bodegaF || null, capitalizar(val(f, cols.tipo)) || 'Tinto', nueva]
      );
      vino = ins.rows[0];
      porId.set(vino.id, vino);
      porClave.set(nueva, vino);
      res.creados++;
    }
    if (!vino) { res.noEncontrados.push(sku || `fila ${i + 1}`); continue; }
    res.filas++;
    if (!sku && cols.sku >= 0) skuPendientes.push({ fila: i + 1, sku: skuDe(vino.id) });
    const repoCrudo = val(f, cols.repo);
    const repo = repoCrudo === '' ? 0 : num(repoCrudo.replace(',', '.'));
    if (repoCrudo !== '') repoFilas.push(i + 1);
    const prev = contados.get(vino.id);
    contados.set(vino.id, { vino, contado: (prev ? prev.contado : 0) + contado, repo: (prev ? prev.repo : 0) + repo });
  }
  for (const { vino, contado } of contados.values()) {
    await vincularLocal(client, vino.id, local);
    const dif = contado - (stock.get(vino.id) || 0);
    if (dif === 0) continue;
    await client.query(
      `INSERT INTO vino_movimientos (vino_id, local, tipo, cantidad, costo_unit, fecha, nota, usuario)
       VALUES ($1,$2,'ajuste',$3,$4,$5,$6,$7)`,
      [vino.id, local, dif, num(vino.costo), hoy, `Sincronización planilla de stock: ${contado} (sistema ${stock.get(vino.id) || 0})`, usuario]
    );
    stock.set(vino.id, contado);
    res.ajustes++;
  }
  // la planilla es el stock completo del local: los vinos que tienen stock en el sistema
  // pero no figuran en la planilla quedan en 0
  if (res.filas > 0) {
    for (const [vinoId, s] of stock) {
      if (!s || contados.has(vinoId)) continue;
      const vino = porId.get(vinoId);
      await client.query(
        `INSERT INTO vino_movimientos (vino_id, local, tipo, cantidad, costo_unit, fecha, nota, usuario)
         VALUES ($1,$2,'ajuste',$3,$4,$5,$6,$7)`,
        [vinoId, local, -s, num(vino && vino.costo), hoy, `Sincronización planilla de stock: no figura en la planilla (sistema ${s})`, usuario]
      );
      stock.set(vinoId, 0);
      res.ajustes++;
    }
    res.cierre = await guardarCierre(client, local, stock, contados, usuario);
  }
  if (filas.hoja && cols.sku >= 0) res._skus = { ...filas.hoja, colSku: cols.sku, pendientes: skuPendientes };
  if (res.cierre && filas.hoja && cols.repo >= 0 && repoFilas.length) res._repo = { ...filas.hoja, colRepo: cols.repo, filas: repoFilas };
  return res;
}

// Fecha de hoy en Argentina (el servidor corre en UTC).
function fechaAR() { return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10); }

// Guarda la foto del stock del local (cierre del día) con la reposición cargada en la planilla.
// Si ya hubo un cierre hoy, se reemplaza el stock y la reposición se suma a la que ya estaba
// (la columna REPOSICION se vacía después de cada sincronización, así no se cuenta dos veces).
async function guardarCierre(client, local, stock, contados, usuario) {
  const fecha = fechaAR();
  const ex = await client.query('SELECT id FROM vino_cierres WHERE local=$1 AND fecha=$2', [local, fecha]);
  let id;
  const repoPrev = new Map();
  if (ex.rows[0]) {
    id = ex.rows[0].id;
    const r = await client.query('SELECT vino_id, reposicion FROM vino_cierre_items WHERE cierre_id=$1 AND reposicion<>0', [id]);
    r.rows.forEach((x) => repoPrev.set(x.vino_id, num(x.reposicion)));
    await client.query('DELETE FROM vino_cierre_items WHERE cierre_id=$1', [id]);
    await client.query('UPDATE vino_cierres SET usuario=$2, created_at=now() WHERE id=$1', [id, usuario]);
  } else {
    id = (await client.query('INSERT INTO vino_cierres (local, fecha, usuario) VALUES ($1,$2,$3) RETURNING id', [local, fecha, usuario])).rows[0].id;
  }
  const ids = new Set([...stock.keys(), ...repoPrev.keys(), ...contados.keys()]);
  const vids = [], sts = [], reps = [];
  let repoTot = 0;
  for (const vid of ids) {
    const s = num(stock.get(vid));
    const rp = (repoPrev.get(vid) || 0) + (contados.has(vid) ? num(contados.get(vid).repo) : 0);
    if (s === 0 && rp === 0) continue;
    vids.push(vid); sts.push(s); reps.push(rp);
    repoTot += rp;
  }
  if (vids.length) {
    await client.query(
      `INSERT INTO vino_cierre_items (cierre_id, vino_id, stock, reposicion)
       SELECT $1, * FROM unnest($2::int[], $3::numeric[], $4::numeric[])`,
      [id, vids, sts, reps]
    );
  }
  const n = await client.query('SELECT COUNT(*)::int AS n FROM vino_cierres WHERE local=$1', [local]);
  return { fecha, reposicion: repoTot, primero: n.rows[0].n === 1 };
}

// Vacía las celdas de REPOSICION que ya quedaron registradas en el cierre.
async function limpiarReposicion(info) {
  if (!info || !info.filas.length) return 0;
  const letra = String.fromCharCode(65 + info.colRepo);
  const titulo = info.title.replace(/'/g, "''");
  await sheetsClient().spreadsheets.values.batchClear({
    spreadsheetId: info.id,
    requestBody: { ranges: info.filas.map((f) => `'${titulo}'!${letra}${f}`) },
  });
  return info.filas.length;
}

function requireAdminOSocio(req, res, next) {
  if (req.session.role !== 'admin' && req.session.role !== 'socio') {
    return res.status(403).json({ error: 'No tenés permiso para sincronizar' });
  }
  next();
}

app.get('/api/vinos-planillas', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT local, tipo, url, ultima_sync FROM vino_planillas');
    res.json({ planillas: r.rows, serviceAccount: serviceAccountEmail(), credenciales: !!process.env.GOOGLE_CREDENTIALS });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cargar las planillas' });
  }
});

app.put('/api/vinos-planillas', requireAdmin, async (req, res) => {
  const items = Array.isArray(req.body.planillas) ? req.body.planillas : [];
  try {
    for (const p of items) {
      if (!LOCALES_VINO.includes(p.local) || !['catalogo', 'stock'].includes(p.tipo)) continue;
      await pool.query(
        `INSERT INTO vino_planillas (local, tipo, url) VALUES ($1,$2,$3)
         ON CONFLICT (local, tipo) DO UPDATE SET url=EXCLUDED.url`,
        [p.local, p.tipo, (p.url || '').trim() || null]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al guardar las planillas' });
  }
});

// Sincroniza un local: primero el catálogo (vinos, costos) y después el stock que cargó el encargado.
app.post('/api/vinos/sync', requireAdminOSocio, async (req, res) => {
  const { local } = req.body;
  if (!LOCALES_VINO.includes(local)) return res.status(400).json({ error: 'Elegí el local' });
  const pr = await pool.query('SELECT tipo, url FROM vino_planillas WHERE local=$1', [local]);
  const urls = Object.fromEntries(pr.rows.map((r) => [r.tipo, r.url]));
  if (!urls.catalogo && !urls.stock) return res.status(400).json({ error: `No hay planillas configuradas para ${local}` });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = { local };
    if (urls.catalogo) out.catalogo = await syncCatalogo(client, local, urls.catalogo);
    if (urls.stock) out.stock = await syncStock(client, local, urls.stock, req.session.role);
    await client.query("UPDATE vino_planillas SET ultima_sync=now() WHERE local=$1 AND url IS NOT NULL", [local]);
    await client.query('COMMIT');
    // recién con los vinos guardados se escriben sus SKU en la planilla de stock
    if (out.stock && out.stock._skus) {
      try {
        out.stock.skusEscritos = await escribirSkus(out.stock._skus);
      } catch (e) {
        console.error('No se pudieron escribir los SKU:', e.message);
        out.stock.skuError = `No pude completar los SKU en la planilla de stock. Compartila como Editor con ${serviceAccountEmail() || 'la cuenta de servicio'}`;
      }
      delete out.stock._skus;
    }
    // la reposición ya quedó guardada en el cierre: se vacía la columna para la semana siguiente
    if (out.stock && out.stock._repo) {
      try {
        out.stock.repoLimpiadas = await limpiarReposicion(out.stock._repo);
      } catch (e) {
        console.error('No se pudo vaciar REPOSICION:', e.message);
        out.stock.repoError = 'La reposición quedó registrada pero no pude vaciar la columna REPOSICION: vaciala a mano para no contarla dos veces';
      }
      delete out.stock._repo;
    }
    res.json(out);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message || 'Error al sincronizar' });
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
