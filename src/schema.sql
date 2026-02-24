-- =============================================================================
-- CERT Outfitters -- Demo Database Schema & Seed Data
-- =============================================================================
-- Compatible with Cloudflare D1 (SQLite)
-- Run via: npx wrangler d1 execute cert-support-db --file=src/schema.sql
-- =============================================================================

-- ---- Orders table ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS orders (
  order_id           TEXT    PRIMARY KEY,
  customer_name      TEXT    NOT NULL,
  customer_state     TEXT    NOT NULL,
  customer_county    TEXT    NOT NULL DEFAULT '',
  status             TEXT    NOT NULL,
  tracking_number    TEXT    NOT NULL,
  carrier            TEXT    NOT NULL,
  estimated_delivery TEXT    NOT NULL,
  items              TEXT    NOT NULL,
  return_eligible    INTEGER NOT NULL DEFAULT 0,
  subtotal           REAL    NOT NULL DEFAULT 0.00,
  tax_rate           REAL    NOT NULL DEFAULT 0.00,
  tax_collected      REAL    NOT NULL DEFAULT 0.00,
  tax_verified       INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---- NC county tax rates reference table ------------------------------------
-- Mirrors the runtime lookup table in index.ts.
-- Kept in D1 as an audit trail and for direct SQL reporting.

CREATE TABLE IF NOT EXISTS nc_tax_rates (
  county      TEXT PRIMARY KEY,
  state_rate  REAL NOT NULL DEFAULT 0.0475,
  county_rate REAL NOT NULL,
  total_rate  REAL GENERATED ALWAYS AS (state_rate + county_rate) STORED
);

-- ---- NC county rate seed data ------------------------------------------------
-- Dummy data for demo purposes - not real tax rates

INSERT OR IGNORE INTO nc_tax_rates (county, county_rate) VALUES
  ('wake',         0.0250),
  ('mecklenburg',  0.0250),
  ('durham',       0.0275),
  ('orange',       0.0275),
  ('guilford',     0.0225),
  ('onslow',       0.0225),
  ('alameda',      0.0000),
  ('losangeles',   0.0000),
  ('sandiego',     0.0000);

-- =============================================================================
-- DEMO SEED DATA -- fictional CERT Outfitters orders
-- Covers: correct tax, undercharge, overcharge, non-NC pass-through,
--         CA erroneous charge, returned order, still-processing orders
-- =============================================================================

-- NC / Wake County -- tax CORRECT
-- $189.99 x 7.25% (4.75 + 2.50) = $13.77
INSERT OR IGNORE INTO orders VALUES (
  'CERT-000001', 'Customer A', 'NC', 'Wake',
  'shipped', 'TRACK-DUMMY-001', 'UPS', '2026-02-28',
  '[{"name":"CERT Tactical Backpack 72hr","qty":1,"sku":"CO-BP-72H"},{"name":"Water Purification Tablets x50","qty":2,"sku":"CO-WP-T50"}]',
  1, 189.99, 0.0725, 13.77, 0, '2026-02-20'
);

-- NC / Mecklenburg County -- tax CORRECT
-- $349.50 x 7.25% (4.75 + 2.50) = $25.34
INSERT OR IGNORE INTO orders VALUES (
  'CERT-000002', 'Customer B', 'NC', 'Mecklenburg',
  'delivered', 'TRACK-DUMMY-002', 'USPS', '2026-02-18',
  '[{"name":"CERT First Aid Kit Pro","qty":1,"sku":"CO-FA-PRO"},{"name":"Emergency Mylar Blankets x10","qty":1,"sku":"CO-EB-M10"},{"name":"Hand-Crank NOAA Weather Radio","qty":1,"sku":"CO-WR-HC1"}]',
  1, 349.50, 0.0725, 25.34, 0, '2026-02-12'
);

-- NC / Wake County -- tax CORRECT, still processing
-- $124.00 x 7.25% (4.75 + 2.50) = $8.99
INSERT OR IGNORE INTO orders VALUES (
  'CERT-000003', 'Customer C', 'NC', 'Wake',
  'processing', 'PENDING', 'FedEx', '2026-03-05',
  '[{"name":"CERT Tactical Vest - Size L","qty":1,"sku":"CO-TV-LG"},{"name":"Nitrile Gloves Box x100","qty":1,"sku":"CO-NG-100"}]',
  0, 124.00, 0.0725, 8.99, 0, '2026-02-23'
);

-- NC / Durham County -- tax DISCREPANCY (undercharged)
-- $212.75 x 7.50% (4.75 + 2.75) = $15.96 expected -- only $13.83 collected
-- Wrong rate applied (7.25% instead of 7.50%) -- undercharged by $2.13
INSERT OR IGNORE INTO orders VALUES (
  'CERT-000004', 'Customer D', 'NC', 'Durham',
  'delivered', 'TRACK-DUMMY-004', 'FedEx', '2026-02-15',
  '[{"name":"CERT Emergency Food Rations 72hr","qty":3,"sku":"CO-EF-72H"},{"name":"Dust Masks N95 x20","qty":1,"sku":"CO-DM-N95"}]',
  1, 212.75, 0.0725, 13.83, 0, '2026-02-08'
);

-- NC / Orange County -- tax DISCREPANCY (overcharged)
-- $95.00 x 7.50% (4.75 + 2.75) = $7.13 expected -- $8.55 collected
-- 9% rate applied erroneously -- overcharged by $1.42
INSERT OR IGNORE INTO orders VALUES (
  'CERT-000005', 'Customer E', 'NC', 'Orange',
  'shipped', 'TRACK-DUMMY-005', 'UPS', '2026-03-01',
  '[{"name":"Glow Sticks Emergency Pack x24","qty":1,"sku":"CO-GS-24P"},{"name":"Waterproof Match Kit","qty":2,"sku":"CO-MK-WPR"}]',
  1, 95.00, 0.0900, 8.55, 0, '2026-02-21'
);

-- NC / Wake County -- RETURNED, not re-eligible for return
-- $78.50 x 7.25% = $5.69 -- tax correct
INSERT OR IGNORE INTO orders VALUES (
  'CERT-000006', 'Customer F', 'NC', 'Wake',
  'returned', 'TRACK-DUMMY-006', 'UPS', '2026-02-10',
  '[{"name":"CERT Folding Stretcher","qty":1,"sku":"CO-FS-STD"}]',
  0, 78.50, 0.0725, 5.69, 0, '2026-01-28'
);

-- NC / Guilford County -- tax CORRECT
-- $445.00 x 7.00% (4.75 + 2.25) = $31.15
INSERT OR IGNORE INTO orders VALUES (
  'CERT-000007', 'Customer G', 'NC', 'Guilford',
  'shipped', 'TRACK-DUMMY-007', 'USPS', '2026-03-02',
  '[{"name":"CERT Team Response Kit - 10 Person","qty":1,"sku":"CO-TRK-10P"},{"name":"Triage Tags x50","qty":1,"sku":"CO-TT-50P"}]',
  1, 445.00, 0.0700, 31.15, 0, '2026-02-22'
);

-- CA / Los Angeles -- NO NC TAX, $0 collected -- CORRECT
INSERT OR IGNORE INTO orders VALUES (
  'CERT-000008', 'Customer H', 'CA', 'Los Angeles',
  'delivered', 'TRACK-DUMMY-008', 'FedEx', '2026-02-19',
  '[{"name":"CERT Earthquake Preparedness Kit","qty":1,"sku":"CO-EQ-KIT"},{"name":"Emergency Whistle x6","qty":1,"sku":"CO-EW-6PK"}]',
  1, 299.00, 0.0000, 0.00, 0, '2026-02-11'
);

-- CA / San Diego -- NC tax ERRONEOUSLY collected on out-of-state order -- DISCREPANCY
INSERT OR IGNORE INTO orders VALUES (
  'CERT-000009', 'Customer I', 'CA', 'San Diego',
  'shipped', 'TRACK-DUMMY-009', 'UPS', '2026-03-03',
  '[{"name":"CERT Tactical Backpack 72hr","qty":1,"sku":"CO-BP-72H"},{"name":"Emergency Poncho x4","qty":1,"sku":"CO-EP-4PK"}]',
  1, 159.00, 0.0725, 11.53, 0, '2026-02-22'
);

-- NC / Onslow County -- tax CORRECT, still processing
-- $532.00 x 7.00% (4.75 + 2.25) = $37.24
INSERT OR IGNORE INTO orders VALUES (
  'CERT-000010', 'Customer J', 'NC', 'Onslow',
  'processing', 'PENDING', 'UPS', '2026-03-07',
  '[{"name":"CERT Team Response Kit - 10 Person","qty":1,"sku":"CO-TRK-10P"},{"name":"CERT Tactical Vest - Size M","qty":2,"sku":"CO-TV-MD"},{"name":"Hand-Crank NOAA Weather Radio","qty":1,"sku":"CO-WR-HC1"}]',
  1, 532.00, 0.0700, 37.24, 0, '2026-02-24'
);
