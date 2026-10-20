CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  username varchar(32) NOT NULL,
  username_key varchar(32) NOT NULL UNIQUE,
  display_name varchar(64),
  password_hash varchar(100) NOT NULL,
  role varchar(16) NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  must_change_password boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name varchar(64);
UPDATE users SET display_name = username WHERE display_name IS NULL;

CREATE TABLE IF NOT EXISTS user_states (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash char(64) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  notification_time time NOT NULL DEFAULT '18:00',
  notification_days smallint[] NOT NULL DEFAULT ARRAY[1,2,3,4,5,6,7],
  support_enabled boolean NOT NULL DEFAULT true,
  inactive_enabled boolean NOT NULL DEFAULT true,
  paused_until date,
  updated_at timestamptz NOT NULL DEFAULT now()
);
