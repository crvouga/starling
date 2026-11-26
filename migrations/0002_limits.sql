CREATE TRIGGER limit_trees BEFORE INSERT ON worktrees WHEN
 (SELECT count(*) FROM worktrees WHERE user_id=NEW.user_id AND state='open')>=8
 BEGIN SELECT RAISE(ABORT,'worktree quota'); END;
CREATE TRIGGER limit_turns BEFORE INSERT ON turns WHEN
 (SELECT count(*) FROM turns WHERE status IN ('queued','running','saving'))>=4 OR
 (SELECT count(*) FROM turns JOIN worktrees w ON w.id=turns.worktree_id WHERE w.user_id=(SELECT user_id FROM worktrees WHERE id=NEW.worktree_id) AND turns.created>unixepoch()-86400)>=32
 BEGIN SELECT RAISE(ABORT,'execution quota'); END;
CREATE TABLE feedback (id TEXT PRIMARY KEY,worktree_id TEXT NOT NULL REFERENCES worktrees(id),body TEXT NOT NULL,created INTEGER NOT NULL);
