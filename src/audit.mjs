import { q } from './db.mjs';

export function audit(user, action, entity, entityId, details) {
  q.run(
    'INSERT INTO audit_log (at, user_id, login, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)',
    new Date().toISOString(),
    user ? user.id : null,
    user ? user.login : null,
    action,
    entity || null,
    entityId ?? null,
    details ? JSON.stringify(details) : null,
  );
}
