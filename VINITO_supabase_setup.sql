-- ════════════════════════════════════════════
--  VINITO — Setup base de datos en Supabase
--  Ejecutar en: supabase.com → SQL Editor
-- ════════════════════════════════════════════

-- 1. CONFIGURACIÓN (contraseñas y emails de alerta)
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO config (key, value) VALUES
  ('pw_admin',      'vinito2025'),
  ('pw_reader',     'lector123'),
  ('alert_emails',  '[]')
ON CONFLICT (key) DO NOTHING;

-- 2. PROVEEDORES
CREATE TABLE IF NOT EXISTS proveedores (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre       TEXT NOT NULL,
  categoria    TEXT,
  cuit         TEXT,
  telefono     TEXT,
  email        TEXT,
  dias_entrega TEXT,
  notas        TEXT,
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- 3. BOLETAS
CREATE TABLE IF NOT EXISTS boletas (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo_doc    TEXT NOT NULL DEFAULT 'factura',  -- 'factura' | 'remito'
  tipo_fact   TEXT,                              -- 'A' | 'B' | 'C' | 'E'
  proveedor   TEXT NOT NULL,
  numero      TEXT,
  fecha       DATE NOT NULL,
  vencimiento DATE,
  pago        TEXT NOT NULL,  -- contado | cuenta_corriente | cheque | transferencia
  local       TEXT NOT NULL,  -- 'Centro' | 'Pichincha'
  subtotal    NUMERIC(12,2) DEFAULT 0,
  iva_rate    NUMERIC(5,2)  DEFAULT 0,
  monto       NUMERIC(12,2) NOT NULL,
  descripcion TEXT,
  notas       TEXT,
  estado      TEXT NOT NULL DEFAULT 'deuda',  -- deuda | cheque_pendiente | parcial | pagado
  cheque_id   UUID,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- 4. CHEQUES
CREATE TABLE IF NOT EXISTS cheques (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proveedor      TEXT NOT NULL,
  numero_cheque  TEXT,
  banco          TEXT,
  fecha_emision  DATE,
  fecha_cheque   DATE,
  monto          NUMERIC(12,2) NOT NULL,
  estado         TEXT NOT NULL DEFAULT 'pendiente',  -- pendiente | acreditado
  boleta_id      UUID REFERENCES boletas(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ DEFAULT now()
);

-- 5. SEGURIDAD — permitir acceso público (la app maneja auth propia)
ALTER TABLE config      ENABLE ROW LEVEL SECURITY;
ALTER TABLE proveedores ENABLE ROW LEVEL SECURITY;
ALTER TABLE boletas     ENABLE ROW LEVEL SECURITY;
ALTER TABLE cheques     ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public_all" ON config      FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "public_all" ON proveedores FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "public_all" ON boletas     FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "public_all" ON cheques     FOR ALL USING (true) WITH CHECK (true);

-- ════════════════════════════════════════════
--  ✅ Listo. Las tablas están creadas.
--  Las contraseñas se pueden cambiar así:
--  UPDATE config SET value = 'nueva_clave' WHERE key = 'pw_admin';
--  UPDATE config SET value = 'nueva_clave' WHERE key = 'pw_reader';
-- ════════════════════════════════════════════
