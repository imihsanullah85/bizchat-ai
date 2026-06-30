
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required. Set it to your PostgreSQL connection string before starting the app.');
}

const sslConfig = process.env.DATABASE_SSL === 'false'
  ? false
  : { rejectUnauthorized: false };

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig
});

async function createTables() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS businesses (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        shop_name VARCHAR(255),
        description TEXT,
        services TEXT,
        prices TEXT,
        timings TEXT,
        faqs TEXT,
        whatsapp_number VARCHAR(255),
        whatsapp_phone_id VARCHAR(255),
        payment_link VARCHAR(255),
        monthly_fee INTEGER,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
        customer_phone VARCHAR(255) NOT NULL,
        customer_name VARCHAR(255),
        lead_temperature VARCHAR(20) DEFAULT 'cold',
        follow_up_at TIMESTAMP WITH TIME ZONE,
        last_customer_reply_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (business_id, customer_phone)
      );
    `);

    // Migrate existing conversations table if columns don't exist yet
    await client.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS lead_temperature VARCHAR(20) DEFAULT 'cold';`);
    await client.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS follow_up_at TIMESTAMP WITH TIME ZONE;`);
    await client.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_customer_reply_at TIMESTAMP WITH TIME ZONE;`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
        direction VARCHAR(10) NOT NULL,
        content TEXT NOT NULL,
        timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
        conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
        customer_phone VARCHAR(255) NOT NULL,
        order_details TEXT NOT NULL,
        requested_datetime VARCHAR(255),
        status VARCHAR(20) NOT NULL DEFAULT 'new',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('Tables created/migrated successfully.');
  } catch (err) {
    console.error('Error creating tables:', err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  createTables
};
