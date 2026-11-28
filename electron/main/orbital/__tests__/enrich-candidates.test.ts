import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { ORBITAL_CANDIDATES_SQL } from '../enrich-candidates';

it('does not queue DCC files for marketplace pack matching', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE assets (id INTEGER, name TEXT, orbital_title TEXT, content_format TEXT,
    scan_location_id INTEGER, orbital_description TEXT, orbital_match_attempted INTEGER, asset_type TEXT);
    INSERT INTO assets VALUES (1, 'Pack', NULL, NULL, 1, NULL, 0, 'unreal_pack');
    INSERT INTO assets VALUES (2, 'Body.blend', NULL, NULL, 2, NULL, 0, 'dcc_scene');
    CREATE TABLE orbital_match_rejections (asset_id INTEGER, product_slug TEXT);`);
  expect(db.prepare(ORBITAL_CANDIDATES_SQL).all()).toMatchObject([{ id: 1 }]);
  db.close();
});

it('leaves out an asset the user dismissed, but not one with a rejected listing', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE assets (id INTEGER, name TEXT, orbital_title TEXT, content_format TEXT,
    scan_location_id INTEGER, orbital_description TEXT, orbital_match_attempted INTEGER, asset_type TEXT);
    INSERT INTO assets VALUES (1, 'Dismissed', NULL, NULL, 1, NULL, 0, 'unreal_pack');
    INSERT INTO assets VALUES (2, 'Rejected one', NULL, NULL, 1, NULL, 0, 'unreal_pack');
    CREATE TABLE orbital_match_rejections (asset_id INTEGER, product_slug TEXT);
    INSERT INTO orbital_match_rejections VALUES (1, NULL), (2, 'wrong-listing');`);
  expect(db.prepare(ORBITAL_CANDIDATES_SQL).all()).toMatchObject([{ id: 2 }]);
  db.close();
});
