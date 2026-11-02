export function migrate(db) {
  db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS offers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        marketplace TEXT NOT NULL,
        product_key TEXT NOT NULL,
        product_url TEXT NOT NULL,
        affiliate_url TEXT NOT NULL,
        affiliate_validation TEXT NOT NULL,
        title TEXT NOT NULL,
        price_cents INTEGER NOT NULL,
        old_price_cents INTEGER,
        coupon TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        image_url TEXT NOT NULL DEFAULT '',
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ready',
        published_at TEXT,
        last_error TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_offers_created ON offers(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_offers_fingerprint ON offers(fingerprint, created_at DESC);

      CREATE TABLE IF NOT EXISTS deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        offer_id INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
        destination TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        last_error TEXT,
        sent_at TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_delivery_queue ON deliveries(state, next_attempt_at);

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        offer_id INTEGER,
        detail TEXT NOT NULL
      ) STRICT;
    `);
  db.exec(
    `CREATE TABLE IF NOT EXISTS price_history (id INTEGER PRIMARY KEY, observed_at TEXT NOT NULL, marketplace TEXT NOT NULL, product_key TEXT NOT NULL, variant TEXT NOT NULL DEFAULT '', price_cents INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS idx_price_history ON price_history(marketplace, product_key, variant, observed_at);`,
  );
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(offers)')
      .all()
      .map((x) => x.name),
  );
  for (const [name, spec] of Object.entries({
    variant: "TEXT NOT NULL DEFAULT ''",
    final_price_cents: 'INTEGER',
    coupon_rules: 'TEXT',
    coupon_condition: "TEXT NOT NULL DEFAULT ''",
    score: 'INTEGER NOT NULL DEFAULT 0',
    score_detail: "TEXT NOT NULL DEFAULT '{}'",
  })) {
    if (!columns.has(name)) db.exec(`ALTER TABLE offers ADD COLUMN ${name} ${spec}`);
  }
  for (const [table, fields] of Object.entries({
    price_history: {
      source: "TEXT NOT NULL DEFAULT 'manual'",
      evidence: "TEXT NOT NULL DEFAULT '{}'",
      price_condition: "TEXT NOT NULL DEFAULT ''",
    },
    candidates: {
      source: "TEXT NOT NULL DEFAULT 'mercadolivre_api'",
      evidence: "TEXT NOT NULL DEFAULT '{}'",
      price_condition: "TEXT NOT NULL DEFAULT ''",
    },
    offers: { candidate_id: 'INTEGER' },
    deliveries: {
      mode: "TEXT NOT NULL DEFAULT 'manual'",
      sent_message: "TEXT NOT NULL DEFAULT ''",
    },
  })) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
      continue;
    const names = new Set(
      db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name),
    );
    for (const [name, type] of Object.entries(fields))
      if (!names.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }

  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS browser_import_drafts(id INTEGER PRIMARY KEY,product_key TEXT NOT NULL,variant TEXT NOT NULL,title TEXT NOT NULL,product_url TEXT NOT NULL,image_url TEXT NOT NULL,price_cents INTEGER NOT NULL,available INTEGER NOT NULL,price_condition TEXT NOT NULL,stage TEXT NOT NULL,observed_at TEXT NOT NULL,offer_id INTEGER,UNIQUE(product_key,variant)) STRICT;`);
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version=1').get()) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const offerColumns = new Set(
        db
          .prepare('PRAGMA table_info(offers)')
          .all()
          .map((c) => c.name),
      );
      for (const [name, type] of Object.entries({
        source: "TEXT NOT NULL DEFAULT 'manual'",
        capture_id: 'INTEGER',
        verified_at: "TEXT NOT NULL DEFAULT ''",
        stock_status: "TEXT NOT NULL DEFAULT 'unknown'",
      }))
        if (!offerColumns.has(name)) db.exec(`ALTER TABLE offers ADD COLUMN ${name} ${type}`);
      const deliveryColumns = new Set(
        db
          .prepare('PRAGMA table_info(deliveries)')
          .all()
          .map((c) => c.name),
      );
      for (const [name, type] of Object.entries({
        approved_price_cents: 'INTEGER',
        approved_message: "TEXT NOT NULL DEFAULT ''",
        approved_metadata: "TEXT NOT NULL DEFAULT '{}'",
      }))
        if (!deliveryColumns.has(name))
          db.exec(`ALTER TABLE deliveries ADD COLUMN ${name} ${type}`);
      db.exec(`UPDATE offers SET source='extension',capture_id=(SELECT id FROM browser_import_drafts WHERE offer_id=offers.id LIMIT 1),verified_at=COALESCE((SELECT observed_at FROM browser_import_drafts WHERE offer_id=offers.id LIMIT 1),''),stock_status=CASE WHEN (SELECT stage='product' AND available=1 FROM browser_import_drafts WHERE offer_id=offers.id LIMIT 1) THEN 'available' ELSE 'unknown' END WHERE id IN (SELECT offer_id FROM browser_import_drafts WHERE offer_id IS NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_offer_identity ON offers(product_key,variant,id DESC);
      CREATE INDEX IF NOT EXISTS idx_offer_capture ON offers(capture_id);
      CREATE INDEX IF NOT EXISTS idx_capture_observed ON browser_import_drafts(observed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_delivery_offer ON deliveries(offer_id,id DESC);`);
      db.prepare('INSERT INTO schema_migrations VALUES(1,?)').run(new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version=2').get()) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(
        "ALTER TABLE browser_import_drafts ADD COLUMN stock_status TEXT NOT NULL DEFAULT 'unknown' CHECK(stock_status IN ('unknown','available','unavailable'))",
      );
      db.exec(
        "UPDATE browser_import_drafts SET stock_status='available' WHERE stage='product' AND available=1",
      );
      db.exec("ALTER TABLE deliveries ADD COLUMN scheduled_at TEXT NOT NULL DEFAULT ''");
      db.exec('UPDATE deliveries SET scheduled_at=next_attempt_at');
      db.exec(
        "UPDATE offers SET stock_status=COALESCE((SELECT stock_status FROM browser_import_drafts WHERE id=offers.capture_id),'unknown') WHERE source='extension'",
      );
      db.prepare('INSERT INTO schema_migrations VALUES(2,?)').run(new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }
}
