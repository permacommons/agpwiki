ALTER TABLE pages RENAME COLUMN original_language TO canonical_language;
ALTER TABLE posts RENAME COLUMN original_language TO canonical_language;
ALTER TABLE forum_threads RENAME COLUMN original_language TO canonical_language;
ALTER TABLE forum_comments RENAME COLUMN original_language TO canonical_language;
