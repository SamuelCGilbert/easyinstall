-- Apps offered on the site. source decides how the installer gets them:
--   winget  : pkg = winget package ID
--   msstore : pkg = Microsoft Store ID (installed through winget -s msstore)
--   choco   : pkg = Chocolatey package name
--   direct  : url = installer URL, or a page to scrape when url_pattern is set; args = silent switches
--   manual  : not installed by the script; the site links to homepage
CREATE TABLE apps (
  key         TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('winget','msstore','choco','direct','manual')),
  pkg         TEXT NOT NULL DEFAULT '',
  url         TEXT NOT NULL DEFAULT '',
  url_pattern TEXT NOT NULL DEFAULT '',
  args        TEXT NOT NULL DEFAULT '',
  detect      TEXT NOT NULL DEFAULT '',
  requires    TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  homepage    TEXT NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX apps_enabled ON apps (enabled, category, sort);

-- Signed-in users (Google) and their saved presets, stored as one JSON list per user.
CREATE TABLE users (
  sub        TEXT PRIMARY KEY,
  email      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE presets (
  sub        TEXT PRIMARY KEY REFERENCES users(sub) ON DELETE CASCADE,
  data       TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
