export function migratePlatform(db) {
  migrateV3(db);
  migrateGroupModes(db);
}
function migrateV3(db) {
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE version=3').get()) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE destination_groups (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        start_minute INTEGER NOT NULL DEFAULT 480, end_minute INTEGER NOT NULL DEFAULT 1320,
        interval_minutes INTEGER NOT NULL DEFAULT 60, revision INTEGER NOT NULL DEFAULT 1
      ) STRICT;
      CREATE TABLE topics (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, keywords TEXT NOT NULL,
        min_cents INTEGER NOT NULL DEFAULT 0, max_cents INTEGER,
        stores TEXT NOT NULL, group_ids TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1
      ) STRICT;
      CREATE TABLE store_connections (
        marketplace TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'unconfigured',
        last_error TEXT NOT NULL DEFAULT '', validated_at TEXT, last_seen_at TEXT
      ) STRICT;
      INSERT INTO store_connections(marketplace) VALUES('mercadolivre'),('amazon'),('shopee');
      CREATE TABLE browser_jobs (
        id INTEGER PRIMARY KEY, marketplace TEXT NOT NULL, kind TEXT NOT NULL,
        payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL, leased_until TEXT, result TEXT, error TEXT,
        delivery_id INTEGER, topic_id INTEGER
      ) STRICT;
      CREATE INDEX idx_browser_jobs_state ON browser_jobs(state,created_at);
      CREATE TABLE platform_observations (
        marketplace TEXT NOT NULL, product_key TEXT NOT NULL, variant TEXT NOT NULL,
        product_url TEXT NOT NULL, price_cents INTEGER NOT NULL, stock_status TEXT NOT NULL,
        observed_at TEXT NOT NULL, price_condition TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'product',
        PRIMARY KEY(marketplace,product_key,variant)
      ) STRICT;
      CREATE TABLE offer_topics (
        offer_id INTEGER NOT NULL REFERENCES offers(id), topic_id INTEGER NOT NULL REFERENCES topics(id),
        PRIMARY KEY(offer_id,topic_id)
      ) STRICT;
      CREATE TABLE platform_review_batches (
        id TEXT PRIMARY KEY, token TEXT NOT NULL, snapshot TEXT NOT NULL,
        created_at TEXT NOT NULL, completed_at TEXT, result TEXT
      ) STRICT;
      ALTER TABLE offers ADD COLUMN discarded_at TEXT;
      ALTER TABLE deliveries ADD COLUMN group_revision INTEGER;
      ALTER TABLE deliveries ADD COLUMN refresh_job_id INTEGER;
      ALTER TABLE deliveries ADD COLUMN sent_price_cents INTEGER;
      CREATE INDEX idx_delivery_destination ON deliveries(destination,state,next_attempt_at);
    `);
    const id = db.prepare("SELECT value FROM settings WHERE key='whatsapp_group_id'").get()?.value;
    const name = db
      .prepare("SELECT value FROM settings WHERE key='whatsapp_group_name'")
      .get()?.value;
    if (id) db.prepare('INSERT INTO destination_groups(id,name) VALUES(?,?)').run(id, name || id);
    db.prepare('INSERT INTO schema_migrations VALUES(3,?)').run(new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

// Version 4: one control per group (off / review / automatic) replaces the group toggle,
// the automatic group list and the groups chosen inside each topic.
function migrateGroupModes(db) {
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE version=4').get()) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(
      "ALTER TABLE destination_groups ADD COLUMN mode TEXT NOT NULL DEFAULT 'review' CHECK(mode IN ('off','review','automatic'))",
    );
    let automatic = [];
    try {
      automatic = JSON.parse(
        db.prepare("SELECT value FROM settings WHERE key='automatic_groups'").get()?.value || '[]',
      );
    } catch {
      automatic = [];
    }
    const update = db.prepare('UPDATE destination_groups SET mode=? WHERE id=?');
    for (const group of db.prepare('SELECT id,enabled FROM destination_groups').all())
      update.run(
        !group.enabled ? 'off' : automatic.includes(group.id) ? 'automatic' : 'review',
        group.id,
      );
    db.exec("UPDATE topics SET group_ids='[]'");
    db.prepare('INSERT INTO schema_migrations VALUES(4,?)').run(new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
