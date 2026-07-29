-- Esquema Vinito - Sistema de gestión de proveedores
-- Ejecutar una sola vez contra la base de datos Postgres del proyecto en Railway

CREATE TABLE IF NOT EXISTS proveedores (
  id         SERIAL PRIMARY KEY,
  nombre     TEXT NOT NULL,
  categoria  TEXT,
  cuit       TEXT,
  telefono   TEXT,
  email      TEXT,
  dias       TEXT,
  nota       TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS boletas (
  id          SERIAL PRIMARY KEY,
  tipo_doc    TEXT NOT NULL,        -- 'factura' | 'remito'
  tipo_fact   TEXT,                 -- 'A' | 'B' | 'C' | 'E'
  proveedor   TEXT NOT NULL,        -- nombre del proveedor (igual que en el front original)
  numero      TEXT,
  fecha       DATE NOT NULL,
  vencimiento DATE,
  forma_pago  TEXT NOT NULL,        -- contado | cuenta_corriente | cheque | transferencia
  local       TEXT,                 -- Centro | Pichincha
  neto        NUMERIC DEFAULT 0,
  iva         NUMERIC DEFAULT 0,
  monto       NUMERIC NOT NULL,
  descripcion TEXT,
  notas       TEXT,
  estado      TEXT NOT NULL DEFAULT 'deuda',  -- deuda | pagado | parcial | cheque_pendiente
  cheque_id   INTEGER,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cheques (
  id             SERIAL PRIMARY KEY,
  numero         TEXT,
  proveedor      TEXT NOT NULL,
  banco          TEXT,
  fecha_emision  DATE,
  fecha_cheque   DATE,
  monto          NUMERIC NOT NULL,
  estado         TEXT NOT NULL DEFAULT 'pendiente', -- pendiente | acreditado
  boleta_id      INTEGER REFERENCES boletas(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ DEFAULT now()
);

-- Nota: boletas.cheque_id es una referencia "blanda" a cheques.id (manejada por la app),
-- sin FK física para evitar dependencia circular entre las dos tablas.

CREATE TABLE IF NOT EXISTS alert_emails (
  id    SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_boletas_proveedor ON boletas(proveedor);
CREATE INDEX IF NOT EXISTS idx_cheques_boleta ON cheques(boleta_id);
