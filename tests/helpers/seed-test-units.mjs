export function seedTestUnits(db) {
  const insert = db.prepare(
    `INSERT INTO units (id, code, name, short_name, echelon, parent_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(code) DO NOTHING`
  );
  const at = new Date().toISOString();
  db.transaction(() => {
    insert.run('G8-FMRAC', 'G8-FMRAC', 'Fiscal Management Resource Analysis Cell', 'FMRAC', 'fire_team', 'MFR', at);
    insert.run('G8-BUDGET', 'G8-BUDGET', 'Budget Branch', 'Budget', 'section', 'MFR', at);
    insert.run('CLR-4', 'CLR-4', 'Combat Logistics Regiment 4', 'CLR-4', 'regiment', 'MFR', at);
  })();
}
