import { newId, now } from './db.js';

export const INCIDENT_CATEGORIES = Object.freeze([
  'vulnerability',
  'security_incident',
  'privacy',
  'account_access',
  'data_integrity',
  'availability',
  'other',
]);

export const INCIDENT_SEVERITIES = Object.freeze([
  'informational', 'low', 'moderate', 'high', 'critical',
]);

export const INCIDENT_STATUSES = Object.freeze([
  'submitted', 'acknowledged', 'investigating', 'mitigated', 'closed',
]);

const TRANSITIONS = Object.freeze({
  submitted: new Set(['acknowledged', 'investigating', 'closed']),
  acknowledged: new Set(['investigating', 'mitigated', 'closed']),
  investigating: new Set(['mitigated', 'closed']),
  mitigated: new Set(['investigating', 'closed']),
  closed: new Set(['investigating']),
});

function text(value, max) {
  const cleaned = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  return cleaned && cleaned.length <= max ? cleaned : null;
}

function optionalText(value, max) {
  if (value == null || String(value).trim() === '') return null;
  return text(value, max);
}

function observedAt(value) {
  if (value == null || String(value).trim() === '') return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.getTime() > Date.now() + 5 * 60 * 1000) return null;
  return parsed.toISOString();
}

export function validateIncident(payload = {}) {
  const category = String(payload.category || '');
  const severity = String(payload.severity || '');
  const title = text(payload.title, 160);
  const description = text(payload.description, 5000);
  const affectedArea = optionalText(payload.affected_area, 120);
  const observed = observedAt(payload.observed_at);
  const errors = {};
  if (!INCIDENT_CATEGORIES.includes(category)) errors.category = 'Choose a valid concern type.';
  if (!INCIDENT_SEVERITIES.includes(severity)) errors.severity = 'Choose a valid severity.';
  if (!title) errors.title = 'Provide a title between 1 and 160 characters.';
  if (!description) errors.description = 'Describe the concern in 5,000 characters or fewer.';
  if (payload.affected_area && !affectedArea) errors.affected_area = 'Affected area is limited to 120 characters.';
  if (payload.observed_at && !observed) errors.observed_at = 'Observed time must be a valid time that is not in the future.';
  return Object.keys(errors).length
    ? { ok: false, errors }
    : { ok: true, value: { category, severity, title, description, affected_area: affectedArea, observed_at: observed } };
}

function eventsFor(db, incidentId, includeInternal) {
  const where = includeInternal ? '' : 'AND e.visible_to_reporter = 1';
  return db.prepare(
    `SELECT e.id, e.kind, e.from_status, e.to_status, e.message,
            e.visible_to_reporter, e.created_at,
            u.first_name AS actor_first_name, u.last_name AS actor_last_name
       FROM security_incident_events e
       JOIN users u ON u.id = e.actor_id
      WHERE e.incident_id = ? ${where}
      ORDER BY e.created_at, e.rowid`
  ).all(incidentId).map((event) => ({ ...event, visible_to_reporter: Boolean(event.visible_to_reporter) }));
}

function withEvents(db, rows, includeInternal) {
  return rows.map((row) => ({ ...row, events: eventsFor(db, row.id, includeInternal) }));
}

export function listReporterIncidents(db, reporterId) {
  const rows = db.prepare(
    `SELECT id, category, severity, title, description, affected_area, observed_at,
            status, created_at, updated_at, acknowledged_at, resolved_at
       FROM security_incidents
      WHERE reporter_id = ?
      ORDER BY created_at DESC`
  ).all(reporterId);
  return withEvents(db, rows, false);
}

export function listOperatorIncidents(db) {
  const rows = db.prepare(
    `SELECT i.id, i.reporter_id, i.category, i.severity, i.title, i.description,
            i.affected_area, i.observed_at, i.status, i.created_at, i.updated_at,
            i.acknowledged_at, i.resolved_at,
            u.username AS reporter_username, u.first_name AS reporter_first_name,
            u.last_name AS reporter_last_name, r.abbr AS reporter_rank_abbr
       FROM security_incidents i
       JOIN users u ON u.id = i.reporter_id
       LEFT JOIN ranks r ON r.id = u.rank_id
      ORDER BY CASE i.status WHEN 'submitted' THEN 0 WHEN 'acknowledged' THEN 1
                           WHEN 'investigating' THEN 2 WHEN 'mitigated' THEN 3 ELSE 4 END,
               CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'moderate' THEN 2
                               WHEN 'low' THEN 3 ELSE 4 END,
               i.updated_at DESC`
  ).all();
  return withEvents(db, rows, true);
}

export function createIncident(db, reporterId, payload) {
  const validation = validateIncident(payload);
  if (!validation.ok) return validation;
  const incident = db.transaction(() => {
    const id = newId();
    const createdAt = now();
    const value = validation.value;
    db.prepare(
      `INSERT INTO security_incidents
        (id, reporter_id, category, severity, title, description, affected_area,
         observed_at, status, created_at, updated_at, last_actor_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?)`
    ).run(
      id, reporterId, value.category, value.severity, value.title, value.description,
      value.affected_area, value.observed_at, createdAt, createdAt, reporterId
    );
    db.prepare(
      `INSERT INTO security_incident_events
        (id, incident_id, actor_id, kind, to_status, visible_to_reporter, created_at)
       VALUES (?, ?, ?, 'submitted', 'submitted', 1, ?)`
    ).run(newId(), id, reporterId, createdAt);
    return db.prepare('SELECT * FROM security_incidents WHERE id = ?').get(id);
  })();
  return { ok: true, value: { ...incident, events: eventsFor(db, incident.id, false) } };
}

export function addReporterFollowUp(db, reporterId, incidentId, message) {
  const body = text(message, 2000);
  if (!body) return { ok: false, status: 400, message: 'Follow-up text is required and limited to 2,000 characters.' };
  const incident = db.prepare('SELECT id, reporter_id, status FROM security_incidents WHERE id = ?').get(incidentId);
  if (!incident || incident.reporter_id !== reporterId) return { ok: false, status: 404, message: 'No security report was found.' };
  const createdAt = now();
  const eventId = newId();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO security_incident_events
        (id, incident_id, actor_id, kind, message, visible_to_reporter, created_at)
       VALUES (?, ?, ?, 'reporter_follow_up', ?, 1, ?)`
    ).run(eventId, incident.id, reporterId, body, createdAt);
    db.prepare(
      'UPDATE security_incidents SET updated_at = ?, last_actor_id = ? WHERE id = ?'
    ).run(createdAt, reporterId, incident.id);
  })();
  return { ok: true, value: { id: eventId, incident_id: incident.id, message: body, created_at: createdAt } };
}

export function updateIncident(db, actorId, incidentId, payload = {}) {
  const incident = db.prepare('SELECT * FROM security_incidents WHERE id = ?').get(incidentId);
  if (!incident) return { ok: false, status: 404, message: 'No security report was found.' };
  const nextStatus = payload.status == null ? incident.status : String(payload.status);
  if (!INCIDENT_STATUSES.includes(nextStatus)) return { ok: false, status: 400, message: 'Choose a valid incident status.' };
  if (nextStatus !== incident.status && !TRANSITIONS[incident.status]?.has(nextStatus)) {
    return { ok: false, status: 409, message: `A ${incident.status} report cannot move directly to ${nextStatus}.` };
  }
  const note = optionalText(payload.note, 2000);
  if (payload.note && !note) return { ok: false, status: 400, message: 'Update text is limited to 2,000 characters.' };
  if (nextStatus === incident.status && !note) return { ok: false, status: 400, message: 'Change the status or add an update.' };
  const visible = payload.visible_to_reporter !== false;
  const changedAt = now();
  const eventId = newId();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO security_incident_events
        (id, incident_id, actor_id, kind, from_status, to_status, message, visible_to_reporter, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      eventId, incident.id, actorId, nextStatus === incident.status ? 'operator_note' : 'status',
      incident.status, nextStatus, note, visible ? 1 : 0, changedAt
    );
    db.prepare(
      `UPDATE security_incidents
          SET status = ?, updated_at = ?, last_actor_id = ?,
              acknowledged_at = CASE WHEN ? IN ('acknowledged', 'investigating', 'mitigated', 'closed')
                                      THEN COALESCE(acknowledged_at, ?) ELSE acknowledged_at END,
              resolved_at = CASE WHEN ? = 'closed' THEN ?
                                 WHEN status = 'closed' AND ? <> 'closed' THEN NULL ELSE resolved_at END
        WHERE id = ?`
    ).run(nextStatus, changedAt, actorId, nextStatus, changedAt, nextStatus, changedAt, nextStatus, incident.id);
  })();
  return {
    ok: true,
    value: {
      event_id: eventId,
      reporter_id: incident.reporter_id,
      from_status: incident.status,
      status: nextStatus,
      note,
      visible_to_reporter: visible,
      updated_at: changedAt,
    },
  };
}
