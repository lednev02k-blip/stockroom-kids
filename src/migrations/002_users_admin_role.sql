CREATE TABLE users_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  login          TEXT NOT NULL UNIQUE,
  full_name      TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('owner','buyer','admin','seller')),
  password_hash  TEXT NOT NULL,
  password_salt  TEXT NOT NULL,
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  last_login_at  TEXT
);

INSERT INTO users_new (id, login, full_name, role, password_hash, password_salt, is_active, created_at, last_login_at)
SELECT id, login, full_name, role, password_hash, password_salt, is_active, created_at, last_login_at FROM users;

DROP TABLE users;

ALTER TABLE users_new RENAME TO users;
