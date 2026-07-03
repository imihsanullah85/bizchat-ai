
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
        owner_whatsapp VARCHAR(20),
        payment_link VARCHAR(255),
        category VARCHAR(255),
        monthly_fee INTEGER,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Add category column to existing databases that were created before this column existed
    await client.query(`
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS category VARCHAR(255);
    `);

    await client.query(`
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS owner_whatsapp VARCHAR(20);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
        customer_phone VARCHAR(255) NOT NULL,
        customer_name VARCHAR(255),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (business_id, customer_phone)
      );
    `);

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
      CREATE TABLE IF NOT EXISTS conversation_insights (
        id SERIAL PRIMARY KEY,
        business_id INTEGER REFERENCES businesses(id),
        conversation_id INTEGER,
        customer_phone VARCHAR(20),
        insight_type VARCHAR(50),
        insight_data TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Tables created successfully (if they did not exist).');
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
