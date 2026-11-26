CREATE TABLE users (id INTEGER PRIMARY KEY, login TEXT NOT NULL, credential TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE oauth_states (state TEXT PRIMARY KEY, verifier TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE logins (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
CREATE INDEX login_expiry ON logins(expires);
CREATE TABLE accounts (user_id INTEGER NOT NULL REFERENCES users(id), provider TEXT NOT NULL CHECK(provider IN ('claude','codex')), credential TEXT NOT NULL, PRIMARY KEY(user_id,provider));
CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, installation INTEGER NOT NULL, base TEXT NOT NULL);
CREATE TABLE worktrees (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), project_id INTEGER NOT NULL REFERENCES projects(id), branch TEXT NOT NULL UNIQUE, base TEXT NOT NULL, title TEXT NOT NULL, pr INTEGER, state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','closed')), revision INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
CREATE INDEX worktree_owner ON worktrees(user_id,state);
CREATE INDEX worktree_pr ON worktrees(project_id,pr);
CREATE TABLE sessions (id TEXT PRIMARY KEY, worktree_id TEXT NOT NULL REFERENCES worktrees(id), provider TEXT NOT NULL CHECK(provider IN ('claude','codex')), native_id TEXT, created INTEGER NOT NULL);
CREATE TABLE turns (id TEXT PRIMARY KEY, worktree_id TEXT NOT NULL REFERENCES worktrees(id), session_id TEXT NOT NULL REFERENCES sessions(id), kind TEXT NOT NULL, "input" TEXT NOT NULL, image TEXT, status TEXT NOT NULL CHECK(status IN ('queued','running','saving','done','failed','cancelled')), created INTEGER NOT NULL, ended INTEGER, error TEXT, cancel INTEGER NOT NULL DEFAULT 0, model_requests INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX one_writer ON turns(worktree_id) WHERE status IN ('queued','running','saving');
CREATE INDEX turns_by_session ON turns(session_id,created);
CREATE INDEX turns_by_tree ON turns(worktree_id,created);
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), turn_id TEXT NOT NULL REFERENCES turns(id), kind TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL);
CREATE INDEX session_events ON events(session_id,id);
CREATE TABLE deliveries (id TEXT PRIMARY KEY, received INTEGER NOT NULL);
CREATE TRIGGER limit_trees BEFORE INSERT ON worktrees WHEN
 (SELECT count(*) FROM worktrees WHERE user_id=NEW.user_id AND state='open')>=8
 BEGIN SELECT RAISE(ABORT,'worktree quota'); END;
CREATE TRIGGER limit_turns BEFORE INSERT ON turns WHEN
 (SELECT count(*) FROM turns WHERE status IN ('queued','running','saving'))>=4 OR
 (SELECT count(*) FROM turns JOIN worktrees w ON w.id=turns.worktree_id WHERE w.user_id=(SELECT user_id FROM worktrees WHERE id=NEW.worktree_id) AND turns.created>unixepoch()-86400)>=32
 BEGIN SELECT RAISE(ABORT,'execution quota'); END;
CREATE TABLE feedback (id TEXT PRIMARY KEY,worktree_id TEXT NOT NULL REFERENCES worktrees(id),body TEXT NOT NULL,created INTEGER NOT NULL);
